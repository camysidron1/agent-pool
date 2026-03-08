import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { migrateFromV1 } from '../stores/migrate-v1.js';

export function registerMigrateCommand(program: Command, ctx: AppContext): void {
  program
    .command('migrate')
    .description('Migrate from v1 JSON data files')
    .action(() => {
      const result = migrateFromV1(ctx.db, ctx.config.dataDir);

      console.log('Migration complete:');
      console.log(`  Projects:     ${result.projects}`);
      console.log(`  Clones:       ${result.clones}`);
      console.log(`  Tasks:        ${result.tasks}`);
      console.log(`  Dependencies: ${result.dependencies}`);

      if (result.errors.length > 0) {
        console.log(`\nWarnings (${result.errors.length}):`);
        for (const err of result.errors) {
          console.log(`  - ${err}`);
        }
      }
    });
}
