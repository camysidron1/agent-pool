import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { EventBus } from '../daemon/event-bus.js';
import { IntegrationManager } from '../integrations/manager.js';
import { bold, green, red, dim } from '../util/colors.js';

export function registerIntegrationCommand(program: Command, ctx: AppContext): void {
  const integration = program
    .command('integration')
    .description('Manage integrations');

  integration
    .command('list')
    .description('List discovered integrations')
    .action(async () => {
      const bus = new EventBus();
      const manager = new IntegrationManager(ctx.config.dataDir, bus);
      const integrations = await manager.discover();

      if (integrations.length === 0) {
        console.log('No integrations found.');
        console.log(dim(`Place integrations in ${ctx.config.dataDir}/integrations/`));
        return;
      }

      console.log(bold('Integrations:'));
      for (const integ of integrations) {
        const events = Object.keys(integ.events);
        console.log(`  ${bold(integ.name)} v${integ.version}`);
        if (events.length > 0) {
          console.log(`    Events: ${events.join(', ')}`);
        }
      }
    });

  integration
    .command('validate')
    .description('Validate an integration')
    .argument('<name>', 'Integration name')
    .action(async (name: string) => {
      const bus = new EventBus();
      const manager = new IntegrationManager(ctx.config.dataDir, bus);
      const result = await manager.validateFiles(name);

      if (result.valid) {
        console.log(green(`Integration '${name}' is valid.`));
      } else {
        console.log(red(`Integration '${name}' has errors:`));
        for (const error of result.errors) {
          console.log(`  - ${error}`);
        }
      }
    });
}
