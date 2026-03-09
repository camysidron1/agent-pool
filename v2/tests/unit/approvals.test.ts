import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, type TestContext } from '../fixtures/context.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  readApprovalFiles,
  listApprovals,
  approveRequest,
  denyRequest,
  type ApprovalRequest,
} from '../../src/commands/approvals.js';

function writeApproval(dir: string, req: ApprovalRequest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${req.id}.json`), JSON.stringify(req, null, 2));
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-1234567890-agent-01',
    agent: 'agent-01',
    tool: 'Bash',
    input: '{"command":"echo hello"}',
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    status: 'pending',
    decided_at: null,
    ...overrides,
  };
}

describe('approvals', () => {
  let ctx: TestContext;
  let approvalsDir: string;

  beforeEach(() => {
    ctx = createTestContext();
    approvalsDir = join(ctx.config.dataDir, 'approvals');
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe('readApprovalFiles', () => {
    test('returns empty array when directory does not exist', () => {
      const result = readApprovalFiles(join(ctx.config.dataDir, 'nonexistent'));
      expect(result).toEqual([]);
    });

    test('returns empty array for empty directory', () => {
      mkdirSync(approvalsDir, { recursive: true });
      const result = readApprovalFiles(approvalsDir);
      expect(result).toEqual([]);
    });

    test('reads valid approval files', () => {
      const req = makeRequest();
      writeApproval(approvalsDir, req);
      const result = readApprovalFiles(approvalsDir);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(req.id);
      expect(result[0].status).toBe('pending');
      expect(result[0].tool).toBe('Bash');
    });

    test('skips non-request files', () => {
      mkdirSync(approvalsDir, { recursive: true });
      writeFileSync(join(approvalsDir, 'other.json'), '{}');
      writeFileSync(join(approvalsDir, '.notify.log'), 'data');
      const req = makeRequest();
      writeApproval(approvalsDir, req);
      const result = readApprovalFiles(approvalsDir);
      expect(result).toHaveLength(1);
    });

    test('skips malformed JSON files', () => {
      mkdirSync(approvalsDir, { recursive: true });
      writeFileSync(join(approvalsDir, 'req-bad.json'), 'not json{{{');
      const req = makeRequest();
      writeApproval(approvalsDir, req);
      const result = readApprovalFiles(approvalsDir);
      expect(result).toHaveLength(1);
    });

    test('skips JSON files missing required fields', () => {
      mkdirSync(approvalsDir, { recursive: true });
      writeFileSync(join(approvalsDir, 'req-incomplete.json'), JSON.stringify({ foo: 'bar' }));
      const result = readApprovalFiles(approvalsDir);
      expect(result).toHaveLength(0);
    });

    test('reads multiple approval files', () => {
      writeApproval(approvalsDir, makeRequest({ id: 'req-001-agent-01' }));
      writeApproval(approvalsDir, makeRequest({ id: 'req-002-agent-02', agent: 'agent-02' }));
      writeApproval(approvalsDir, makeRequest({ id: 'req-003-agent-01', status: 'approved' }));
      const result = readApprovalFiles(approvalsDir);
      expect(result).toHaveLength(3);
    });
  });

  describe('listApprovals', () => {
    test('shows message when no pending requests', () => {
      const result = listApprovals(ctx);
      expect(result).toBe('No pending approval requests.');
    });

    test('shows message when only approved/denied exist and not --all', () => {
      writeApproval(approvalsDir, makeRequest({ id: 'req-done-agent-01', status: 'approved' }));
      const result = listApprovals(ctx);
      expect(result).toBe('No pending approval requests.');
    });

    test('lists pending requests with header', () => {
      writeApproval(approvalsDir, makeRequest());
      const result = listApprovals(ctx);
      expect(result).toContain('ID');
      expect(result).toContain('Agent');
      expect(result).toContain('Tool');
      expect(result).toContain('req-1234567890-agent-01');
      expect(result).toContain('agent-01');
      expect(result).toContain('Bash');
    });

    test('--all includes approved and denied', () => {
      writeApproval(approvalsDir, makeRequest({ id: 'req-p-agent-01', status: 'pending' }));
      writeApproval(approvalsDir, makeRequest({ id: 'req-a-agent-01', status: 'approved' }));
      writeApproval(approvalsDir, makeRequest({ id: 'req-d-agent-01', status: 'denied' }));
      const result = listApprovals(ctx, { all: true });
      expect(result).toContain('req-p-agent-01');
      expect(result).toContain('req-a-agent-01');
      expect(result).toContain('req-d-agent-01');
    });

    test('truncates long input', () => {
      const longInput = 'a'.repeat(100);
      writeApproval(approvalsDir, makeRequest({ input: longInput }));
      const result = listApprovals(ctx);
      expect(result).not.toContain('a'.repeat(100));
      expect(result).toContain('...');
    });
  });

  describe('approveRequest', () => {
    test('approves a single request by id', () => {
      const req = makeRequest();
      writeApproval(approvalsDir, req);

      const result = approveRequest(ctx, req.id);
      expect(result).toBe(`Approved ${req.id}.`);

      const updated = JSON.parse(readFileSync(join(approvalsDir, `${req.id}.json`), 'utf-8'));
      expect(updated.status).toBe('approved');
      expect(updated.decided_at).toBeTruthy();
    });

    test('throws error for nonexistent request', () => {
      expect(() => approveRequest(ctx, 'req-nonexistent')).toThrow("request 'req-nonexistent' not found");
    });

    test('approves all pending with --all', () => {
      writeApproval(approvalsDir, makeRequest({ id: 'req-1-agent-01' }));
      writeApproval(approvalsDir, makeRequest({ id: 'req-2-agent-02', agent: 'agent-02' }));
      writeApproval(approvalsDir, makeRequest({ id: 'req-3-agent-01', status: 'approved' }));

      const result = approveRequest(ctx, '--all');
      expect(result).toBe('Approved 2 pending request(s).');

      const r1 = JSON.parse(readFileSync(join(approvalsDir, 'req-1-agent-01.json'), 'utf-8'));
      const r2 = JSON.parse(readFileSync(join(approvalsDir, 'req-2-agent-02.json'), 'utf-8'));
      const r3 = JSON.parse(readFileSync(join(approvalsDir, 'req-3-agent-01.json'), 'utf-8'));
      expect(r1.status).toBe('approved');
      expect(r2.status).toBe('approved');
      expect(r3.status).toBe('approved'); // already was approved
    });

    test('--all with no pending returns count 0', () => {
      mkdirSync(approvalsDir, { recursive: true });
      const result = approveRequest(ctx, '--all');
      expect(result).toBe('Approved 0 pending request(s).');
    });
  });

  describe('denyRequest', () => {
    test('denies a single request by id', () => {
      const req = makeRequest();
      writeApproval(approvalsDir, req);

      const result = denyRequest(ctx, req.id);
      expect(result).toBe(`Denied ${req.id}.`);

      const updated = JSON.parse(readFileSync(join(approvalsDir, `${req.id}.json`), 'utf-8'));
      expect(updated.status).toBe('denied');
      expect(updated.decided_at).toBeTruthy();
    });

    test('throws error for nonexistent request', () => {
      expect(() => denyRequest(ctx, 'req-nonexistent')).toThrow("request 'req-nonexistent' not found");
    });

    test('preserves other fields when denying', () => {
      const req = makeRequest({ tool: 'Write', agent: 'agent-05' });
      writeApproval(approvalsDir, req);

      denyRequest(ctx, req.id);
      const updated = JSON.parse(readFileSync(join(approvalsDir, `${req.id}.json`), 'utf-8'));
      expect(updated.tool).toBe('Write');
      expect(updated.agent).toBe('agent-05');
      expect(updated.status).toBe('denied');
    });
  });
});
