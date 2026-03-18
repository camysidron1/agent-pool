import { describe, test, expect } from 'bun:test';
import { createAdapter, resolveAgentType } from '../../../src/adapters/factory.js';
import { ClaudeAdapter } from '../../../src/adapters/claude.js';
import { CodexAdapter } from '../../../src/adapters/codex.js';
import { MockGitClient } from '../../../src/git/mock.js';

describe('resolveAgentType', () => {
  test('defaults to claude when no arguments', () => {
    expect(resolveAgentType()).toBe('claude');
  });

  test('defaults to claude when both undefined/null', () => {
    expect(resolveAgentType(undefined, null)).toBe('claude');
  });

  test('cliFlag overrides projectDefault', () => {
    expect(resolveAgentType('codex', 'claude')).toBe('codex');
  });

  test('uses projectDefault when cliFlag is undefined', () => {
    expect(resolveAgentType(undefined, 'codex')).toBe('codex');
  });

  test('returns claude when cliFlag is claude', () => {
    expect(resolveAgentType('claude')).toBe('claude');
  });

  test('returns codex when cliFlag is codex', () => {
    expect(resolveAgentType('codex')).toBe('codex');
  });

  test('throws on unknown type', () => {
    expect(() => resolveAgentType('unknown')).toThrow("Unknown agent type: 'unknown'");
  });

  test('throws on invalid projectDefault when no cliFlag', () => {
    expect(() => resolveAgentType(undefined, 'invalid')).toThrow("Unknown agent type: 'invalid'");
  });
});

describe('createAdapter', () => {
  test('returns ClaudeAdapter for claude type', () => {
    const git = new MockGitClient();
    const adapter = createAdapter('claude', git);
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
  });

  test('returns CodexAdapter for codex type', () => {
    const git = new MockGitClient();
    const adapter = createAdapter('codex', git);
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });
});
