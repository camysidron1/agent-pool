import { describe, test, expect } from 'bun:test';
import { formatQueueSummary } from '../../../src/util/queue-summary.js';
import type { QueueSummary } from '../../../src/services/task-service.js';
import type { Task } from '../../../src/stores/interfaces.js';

// Strip ANSI codes for predictable assertions
function strip(s: string): string {
  return s.replace(/\x1b\[\d+m/g, '');
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    projectName: 'proj',
    prompt: 'do something',
    status: 'pending',
    claimedBy: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    priority: 0,
    timeoutMinutes: null,
    retryMax: 1,
    retryCount: 0,
    retryStrategy: 'same',
    result: null,
    ...overrides,
  };
}

function baseSummary(overrides: Partial<QueueSummary> = {}): QueueSummary {
  return {
    total: 0,
    pending: 0,
    inProgress: 0,
    blocked: 0,
    waitingOnDeps: 0,
    claimable: 0,
    completed: 0,
    backlogged: 0,
    cancelled: 0,
    nextClaimable: null,
    ...overrides,
  };
}

describe('formatQueueSummary', () => {
  test('shows idle message when no active tasks', () => {
    const output = strip(formatQueueSummary(baseSummary({ total: 2, completed: 2 })));
    expect(output).toContain('Queue:');
    expect(output).toContain('idle');
  });

  test('shows next claimable task', () => {
    const task = makeTask({ id: 't-42', prompt: 'implement feature X' });
    const output = strip(formatQueueSummary(baseSummary({
      total: 3, pending: 1, claimable: 1, inProgress: 1,
      nextClaimable: task,
    })));
    expect(output).toContain('t-42');
    expect(output).toContain('implement feature X');
    expect(output).toContain('1 claimable');
    expect(output).toContain('1 running');
  });

  test('shows waiting-on-deps warning', () => {
    const output = strip(formatQueueSummary(baseSummary({
      total: 3, pending: 2, waitingOnDeps: 2, claimable: 0, inProgress: 1,
    })));
    expect(output).toContain('waiting on deps');
  });

  test('shows blocked warning', () => {
    const output = strip(formatQueueSummary(baseSummary({
      total: 2, blocked: 2, claimable: 0,
    })));
    expect(output).toContain('blocked');
    expect(output).toContain('unblock');
  });

  test('shows priority badge on next claimable', () => {
    const task = makeTask({ id: 't-5', priority: 3, prompt: 'urgent fix' });
    const output = strip(formatQueueSummary(baseSummary({
      total: 1, pending: 1, claimable: 1, nextClaimable: task,
    })));
    expect(output).toContain('[P3]');
  });

  test('truncates long prompts', () => {
    const longPrompt = 'A'.repeat(80);
    const task = makeTask({ prompt: longPrompt });
    const output = strip(formatQueueSummary(baseSummary({
      total: 1, pending: 1, claimable: 1, nextClaimable: task,
    })));
    expect(output).toContain('...');
    expect(output).not.toContain(longPrompt);
  });
});
