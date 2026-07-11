#!/usr/bin/env node

const { Command } = require('commander');

const program = new Command();

program
  .name('queuectl')
  .description('CLI-based background job queue system')
  .version('1.0.0');

program
  .command('enqueue')
  .description('Add a new job to the queue')
  .argument('<json>', 'Job JSON string')
  .action(() => {
    // stub — will be implemented in Phase 3
  });

program
  .command('worker')
  .description('Manage worker processes')
  .addCommand(
    new Command('start')
      .description('Start one or more workers')
      .option('-c, --count <number>', 'Number of workers to start', '1')
      .action(() => {
        // stub — will be implemented in Phase 4/7
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
        // stub — will be implemented in Phase 6
      }),
  )
  .addCommand(
    new Command('retry')
      .description('Retry a dead job')
      .argument('<job-id>', 'ID of the job to retry')
      .action(() => {
        // stub — will be implemented in Phase 6
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
      .action(() => {
        // stub — will be implemented in Phase 2
      }),
  )
  .addCommand(
    new Command('get')
      .description('Get a config value')
      .argument('<key>', 'Config key')
      .action(() => {
        // stub — will be implemented in Phase 2
      }),
  )
  .addCommand(
    new Command('list')
      .description('List all config values')
      .action(() => {
        // stub — will be implemented in Phase 2
      }),
  );

program.parse();
