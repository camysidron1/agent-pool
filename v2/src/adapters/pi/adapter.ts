// PiAdapter — runs agents via Pi SDK with native task management tools

import { join } from 'path';
import type { AgentAdapter, AgentContext } from '../agent.js';
import type { GitClient } from '../../git/interfaces.js';
import type { TaskStore } from '../../stores/interfaces.js';
import {
  checkoutTaskBranch,
  setupDocs,
  updateGitignore,
  setupOutputCapture,
  buildPromptWithContext,
  DOC_RULES,
} from '../base-setup.js';
import { createPiTools } from './tools.js';
import { createPoolExtension } from './extension.js';
import {
  createAgentSession,
  runPrintMode,
  SessionManager,
  DefaultResourceLoader,
  codingTools,
} from '@mariozechner/pi-coding-agent';

export class PiAdapter implements AgentAdapter {
  private abortController: AbortController | null = null;

  constructor(
    private git: GitClient,
    private taskStore: TaskStore,
  ) {}

  async setup(ctx: AgentContext): Promise<void> {
    await checkoutTaskBranch(this.git, ctx);
    setupDocs(ctx);
    updateGitignore(ctx, ['agent-docs', 'shared-docs', '.pi']);
  }

  async run(ctx: AgentContext): Promise<number> {
    const { logPath } = setupOutputCapture(ctx.agentId, ctx.dataDir, ctx.taskId);
    this.abortController = new AbortController();

    const customTools = createPiTools({
      taskStore: this.taskStore,
      projectName: ctx.projectName,
      agentId: ctx.agentId,
      taskId: ctx.taskId,
    });

    const extensionFactory = createPoolExtension({
      taskStore: this.taskStore,
      projectName: ctx.projectName,
      logPath,
      agentId: ctx.agentId,
      taskId: ctx.taskId,
    });

    const appendSystemPrompt = this.buildAppendSystemPrompt(ctx);

    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.clonePath,
      extensionFactories: [extensionFactory],
      appendSystemPrompt,
      noExtensions: false,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: ctx.clonePath,
      tools: codingTools,
      customTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
    });

    const prompt = this.buildPrompt(ctx);

    // runPrintMode sends the prompt, runs the agentic loop, and returns exit code
    const exitCode = await runPrintMode(session, {
      mode: 'text',
      initialMessage: prompt,
    });

    this.abortController = null;
    return exitCode;
  }

  buildPrompt(ctx: AgentContext): string {
    return buildPromptWithContext(ctx);
  }

  abort(): void {
    this.abortController?.abort();
  }

  forceKill(): void {
    this.abortController?.abort();
  }

  getLogPath(ctx: AgentContext): string {
    return join(ctx.dataDir, 'logs', ctx.agentId, `${ctx.taskId}.log`);
  }

  private buildAppendSystemPrompt(ctx: AgentContext): string {
    const sections: string[] = [];

    sections.push('# agent-pool Context');
    sections.push('');
    sections.push(`You are agent "${ctx.agentId}" working on project "${ctx.projectName}".`);
    sections.push(`Your current task ID is "${ctx.taskId}".`);
    sections.push('');
    sections.push('## Task Management');
    sections.push('You have task management tools for coordinating with other agents:');
    sections.push('- **create_task**: Create subtasks for other agents to pick up from the shared queue');
    sections.push('- **list_tasks**: View the current task queue');
    sections.push('- **get_task_status**: Check status of a specific task');
    sections.push('- **finish_task**: Mark your current task and end the session');
    sections.push('');
    sections.push('### When to create subtasks');
    sections.push('- When your task naturally decomposes into independent pieces that can run in parallel');
    sections.push('- When you discover follow-up work outside your current scope');
    sections.push('- Do NOT create subtasks for sequential steps you can handle yourself');
    sections.push('');
    sections.push('### Finishing');
    sections.push('ALWAYS call finish_task when done. Use the appropriate status:');
    sections.push('- **completed**: task is done, all changes committed and pushed');
    sections.push('- **blocked**: you hit an issue you cannot resolve (missing access, unclear requirements, etc.)');
    sections.push('- **pending**: you want to retry the task (resets it for another agent to pick up)');
    sections.push('- **backlogged**: deprioritize for later');
    sections.push('');
    sections.push(DOC_RULES);

    if (ctx.trackingContext) {
      sections.push('');
      sections.push(ctx.trackingContext);
    }

    if (ctx.workflowContext) {
      sections.push('');
      sections.push(ctx.workflowContext);
    }

    return sections.join('\n');
  }
}
