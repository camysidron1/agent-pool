import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { bold, dim } from '../util/colors.js';

export function registerProjectCommand(program: Command, ctx: AppContext): void {
  const projectCmd = program
    .command('project')
    .description('Manage projects');

  projectCmd
    .command('add')
    .description('Add a project')
    .requiredOption('--source <path>', 'Source repository path')
    .option('--branch <branch>', 'Branch name', 'main')
    .option('--prefix <prefix>', 'Clone prefix')
    .option('--setup <cmd>', 'Setup command')
    .argument('<name>', 'Project name')
    .action((name: string, opts: { source: string; branch: string; prefix?: string; setup?: string }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      projectService.add({
        name,
        source: opts.source,
        branch: opts.branch,
        prefix: opts.prefix,
        setup: opts.setup,
      });
      console.log(`Added project '${name}'`);
    });

  projectCmd
    .command('list')
    .description('List all projects')
    .action(() => {
      const projectService = new ProjectService(ctx.stores.projects);
      const projects = projectService.list();

      if (projects.length === 0) {
        console.log('No projects.');
        return;
      }

      const nameW = 16, prefixW = 12, branchW = 12, trackW = 16, workflowW = 16;
      const header = [
        'Name'.padEnd(nameW),
        'Prefix'.padEnd(prefixW),
        'Branch'.padEnd(branchW),
        'Tracking'.padEnd(trackW),
        'Workflow'.padEnd(workflowW),
        'Source',
      ].join(' ');
      const sep = [
        '----'.padEnd(nameW),
        '------'.padEnd(prefixW),
        '------'.padEnd(branchW),
        '--------'.padEnd(trackW),
        '--------'.padEnd(workflowW),
        '------',
      ].join(' ');
      console.log(header);
      console.log(sep);

      for (const p of projects) {
        const name = p.isDefault ? `${p.name} *` : p.name;
        const tracking = p.trackingType
          ? `${p.trackingType[0].toUpperCase()}${p.trackingType.slice(1)} (${p.trackingProjectKey})`
          : '-';
        const workflow = p.workflowType || '-';
        const row = [
          name.padEnd(nameW),
          (p.prefix || '-').padEnd(prefixW),
          p.branch.padEnd(branchW),
          tracking.padEnd(trackW),
          workflow.padEnd(workflowW),
          p.source,
        ].join(' ');
        console.log(row);
      }
    });

  projectCmd
    .command('remove')
    .description('Remove a project')
    .argument('<name>', 'Project name')
    .action((name: string) => {
      const projectService = new ProjectService(ctx.stores.projects);
      projectService.remove(name);
      console.log(`Removed project '${name}'`);
    });

  projectCmd
    .command('default')
    .description('Set default project')
    .argument('<name>', 'Project name')
    .action((name: string) => {
      const projectService = new ProjectService(ctx.stores.projects);
      projectService.setDefault(name);
      console.log(`Default project set to '${name}'`);
    });

  projectCmd
    .command('set-tracking')
    .description('Configure issue tracking')
    .requiredOption('--type <type>', 'Tracking type')
    .requiredOption('--key <key>', 'Project key')
    .option('--label <label>', 'Label')
    .option('--instructions <instructions>', 'Instructions')
    .argument('<name>', 'Project name')
    .action((name: string, opts: { type: string; key: string; label?: string; instructions?: string }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      projectService.setTracking(name, {
        type: opts.type,
        projectKey: opts.key,
        label: opts.label,
        instructions: opts.instructions,
      });
      console.log(`Tracking configured for '${name}'`);
    });

  projectCmd
    .command('clear-tracking')
    .description('Clear issue tracking')
    .argument('<name>', 'Project name')
    .action((name: string) => {
      const projectService = new ProjectService(ctx.stores.projects);
      projectService.clearTracking(name);
      console.log(`Tracking cleared for '${name}'`);
    });

  projectCmd
    .command('set-workflow')
    .description('Configure git workflow')
    .requiredOption('--type <type>', 'Workflow type')
    .option('--instructions <instructions>', 'Instructions')
    .option('--auto-merge <bool>', 'Auto merge')
    .option('--merge-method <method>', 'Merge method')
    .argument('<name>', 'Project name')
    .action((name: string, opts: { type: string; instructions?: string; autoMerge?: string; mergeMethod?: string }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      projectService.setWorkflow(name, {
        type: opts.type,
        instructions: opts.instructions,
        autoMerge: opts.autoMerge === 'true' ? true : opts.autoMerge === 'false' ? false : undefined,
        mergeMethod: opts.mergeMethod,
      });
      console.log(`Workflow configured for '${name}'`);
    });

  projectCmd
    .command('clear-workflow')
    .description('Clear git workflow')
    .argument('<name>', 'Project name')
    .action((name: string) => {
      const projectService = new ProjectService(ctx.stores.projects);
      projectService.clearWorkflow(name);
      console.log(`Workflow cleared for '${name}'`);
    });
}
