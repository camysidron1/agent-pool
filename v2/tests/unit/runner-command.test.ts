import { describe, test, expect } from 'bun:test';
import { buildRunnerCommand } from '../../src/util/runner-command.js';
import type { Project } from '../../src/stores/interfaces.js';

function makeProject(overrides?: Partial<Project>): Project {
  return {
    name: 'myproj',
    source: '/tmp/source',
    prefix: 'mp',
    branch: 'main',
    setup: null,
    isDefault: true,
    trackingType: null,
    trackingProjectKey: null,
    trackingLabel: null,
    trackingInstructions: null,
    workflowType: null,
    workflowInstructions: null,
    workflowAutoMerge: null,
    workflowMergeMethod: null,
    agentType: null,
    ...overrides,
  };
}

describe('buildRunnerCommand', () => {
  const toolDir = '/usr/local/agent-pool';
  const clonePath = '/data/mp-01';
  const project = makeProject();

  test('queue mode produces agent-pool run-agent command', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {});
    expect(cmd).toBe(`cd ${clonePath} && agent-pool -p myproj run-agent 1 --push`);
  });

  test('queue mode with env and skipPermissions', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {
      env: 'staging',
      skipPermissions: true,
    });
    expect(cmd).toContain('--env staging');
    expect(cmd).toContain('--skip-permissions');
  });

  test('queue mode with agent includes --agent flag', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {
      agent: 'codex',
    });
    expect(cmd).toContain('--agent codex');
    expect(cmd).toContain('agent-pool -p myproj run-agent');
  });

  test('no-queue mode without agent produces claude command', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {
      queue: false,
    });
    expect(cmd).toBe(`cd ${clonePath} && ccc`);
  });

  test('no-queue mode with skipPermissions adds flag', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {
      queue: false,
      skipPermissions: true,
    });
    expect(cmd).toBe(`cd ${clonePath} && ccc --dangerously-skip-permissions`);
  });

  test('no-queue mode with agent codex produces codex exec --full-auto', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {
      queue: false,
      agent: 'codex',
    });
    expect(cmd).toBe(`cd ${clonePath} && codex exec --full-auto`);
  });

  test('no-queue mode with agent claude produces claude command', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {
      queue: false,
      agent: 'claude',
    });
    expect(cmd).toBe(`cd ${clonePath} && ccc`);
  });

  test('no-queue mode with agent claude and skipPermissions', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {
      queue: false,
      agent: 'claude',
      skipPermissions: true,
    });
    expect(cmd).toBe(`cd ${clonePath} && ccc --dangerously-skip-permissions`);
  });

  test('queue mode without agent omits --agent flag', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {});
    expect(cmd).not.toContain('--agent');
  });

  test('adds --push flag when push is true', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, { push: true });
    expect(cmd).toContain('--push');
  });

  test('includes --push by default in queue mode', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, {});
    expect(cmd).toContain('--push');
  });

  test('omits --push when push is explicitly false', () => {
    const cmd = buildRunnerCommand(clonePath, 1, project, toolDir, { push: false });
    expect(cmd).not.toContain('--push');
  });

  test('combines all flags including push and agent', () => {
    const cmd = buildRunnerCommand(clonePath, 3, project, toolDir, {
      skipPermissions: true,
      env: 'production',
      agent: 'codex',
      push: true,
    });
    expect(cmd).toContain('--skip-permissions');
    expect(cmd).toContain('--env production');
    expect(cmd).toContain('--agent codex');
    expect(cmd).toContain('--push');
    expect(cmd).toContain('agent-pool -p myproj run-agent');
  });
});
