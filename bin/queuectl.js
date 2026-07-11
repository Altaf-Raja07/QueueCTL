#!/usr/bin/env node

const { Command } = require('commander');
const { getConfig, setConfig, getAllConfig } = require('../src/config');
const { enqueueJob, listDeadJobs, retryDeadJob } = require('../src/queue');
const { startWorker } = require('../src/worker');

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
        // stub — will be implemented in Phase 8
      }),
  );

program
  .command('status')
  .description('Show job counts and worker information')
  .action(() => {
    // stub — will be implemented in Phase 10
  });

program
  .command('list')
  .description('List jobs filtered by state')
  .option('-s, --state <state>', 'Filter by job state')
  .option('-j, --json', 'Output as JSON array (stdout only)')
  .action(() => {
    // stub — will be implemented in Phase 10
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
        console.log(getConfig(key));
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
