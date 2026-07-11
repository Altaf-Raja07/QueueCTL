#!/usr/bin/env node

const { Command } = require('commander');
const { getConfig, setConfig, getAllConfig } = require('../src/config');
const { enqueueJob, listDeadJobs, retryDeadJob, getStatus, getJobs } = require('../src/queue');
const { startWorker, stopWorkers, countActiveWorkers } = require('../src/worker');

const program = new Command();

program
  .name('queuectl')
  .description('CLI-based background job queue system')
  .version('1.0.0');

program
  .command('enqueue')
  .description('Add a new job to the queue')
  .argument('<json>', 'Job JSON string')
  .action((json) => {
    try {
      const result = enqueueJob(json);
      console.error(`Job ${result.id} enqueued (${result.state})`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  });

program
  .command('worker')
  .description('Manage worker processes')
  .addCommand(
    new Command('start')
      .description('Start one or more workers')
      .option('-c, --count <number>', 'Number of workers to start', '1')
      .action((opts) => {
        startWorker(parseInt(opts.count, 10) || 1);
      }),
  )
  .addCommand(
    new Command('stop')
      .description('Stop all workers gracefully')
      .action(() => {
        const { signaled, pruned } = stopWorkers();
        if (signaled.length === 0 && pruned.length === 0) {
          console.error('No running workers found');
          return;
        }
        for (const pid of signaled) {
          console.error(`Sent SIGTERM to worker ${pid}`);
        }
        for (const pid of pruned) {
          console.error(`Pruned stale PID ${pid}`);
        }
      }),
  );

program
  .command('status')
  .description('Show job counts and worker information')
  .action(() => {
    const counts = getStatus();
    const order = ['pending', 'processing', 'completed', 'failed', 'dead'];
    for (const state of order) {
      console.log(`${state.padEnd(12)} ${counts[state]}`);
    }
    console.log(`${'active workers'.padEnd(12)} ${countActiveWorkers()}`);
  });

program
  .command('list')
  .description('List jobs filtered by state')
  .option('-s, --state <state>', 'Filter by job state')
  .option('-j, --json', 'Output as JSON array (stdout only)')
  .action((opts) => {
    if (opts.state && !['pending', 'processing', 'completed', 'failed', 'dead'].includes(opts.state)) {
      console.error(`Invalid state '${opts.state}'. Must be one of: pending, processing, completed, failed, dead`);
      process.exit(1);
    }
    const jobs = getJobs(opts.state);
    if (opts.json) {
      console.log(JSON.stringify(jobs));
      return;
    }
    if (jobs.length === 0) {
      const label = opts.state ? ` in state '${opts.state}'` : '';
      console.error(`No jobs${label}`);
      return;
    }
    for (const j of jobs) {
      const created = (j.created_at || '').slice(0, 19);
      const err = j.last_error ? ` err="${j.last_error.slice(0, 40)}"` : '';
      console.log(`${j.id.padEnd(16)} ${j.command.padEnd(24)} ${j.state.padEnd(12)} ${String(j.attempts).padEnd(3)}/${String(j.max_retries).padEnd(3)} ${created}${err}`);
    }
  });

program
  .command('dlq')
  .description('Dead Letter Queue operations')
  .addCommand(
    new Command('list')
      .description('List dead jobs')
      .action(() => {
        const jobs = listDeadJobs();
        if (jobs.length === 0) {
          console.error('No dead jobs');
          return;
        }
        for (const j of jobs) {
          console.log(`${j.id}  attempts=${j.attempts}/${j.max_retries}  error="${j.last_error || ''}"  updated=${j.updated_at}`);
        }
      }),
  )
  .addCommand(
    new Command('retry')
      .description('Retry a dead job')
      .argument('<job-id>', 'ID of the job to retry')
      .action((id) => {
        try {
          const result = retryDeadJob(id);
          console.error(`Job ${result.id} retried (${result.state})`);
        } catch (e) {
          console.error(e.message);
          process.exit(1);
        }
      }),
  );

program
  .command('config')
  .description('Manage configuration')
  .addCommand(
    new Command('set')
      .description('Set a config value')
      .argument('<key>', 'Config key')
      .argument('<value>', 'Config value')
      .action((key, value) => {
        setConfig(key, value);
        console.error(`Config ${key} set to ${value}`);
      }),
  )
  .addCommand(
    new Command('get')
      .description('Get a config value')
      .argument('<key>', 'Config key')
      .action((key) => {
        const val = getConfig(key);
        if (val === undefined) {
          console.error(`Unknown config key '${key}'`);
          process.exit(1);
        }
        console.log(val);
      }),
  )
  .addCommand(
    new Command('list')
      .description('List all config values')
      .action(() => {
        const all = getAllConfig();
        for (const [key, value] of Object.entries(all)) {
          console.log(`${key}=${value}`);
        }
      }),
  );

program.parse();
