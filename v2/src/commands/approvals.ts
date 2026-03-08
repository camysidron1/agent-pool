import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface ApprovalRequest {
  id: string;
  agent: string;
  tool: string;
  input: string;
  timestamp: string;
  status: 'pending' | 'approved' | 'denied';
  decided_at: string | null;
}

function getApprovalsDir(ctx: AppContext): string {
  return join(ctx.config.dataDir, 'approvals');
}

function ensureApprovalsDir(ctx: AppContext): string {
  const dir = getApprovalsDir(ctx);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readApprovalFiles(dir: string): ApprovalRequest[] {
  if (!existsSync(dir)) return [];

  const results: ApprovalRequest[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.startsWith('req-') && f.endsWith('.json'));
  } catch {
    return [];
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const data = JSON.parse(raw) as ApprovalRequest;
      if (data.id && data.status) {
        results.push(data);
      }
    } catch {
      // Skip malformed files
    }
  }

  return results;
}

function formatAge(timestamp: string): string {
  const now = Date.now();
  let reqTime: number;
  try {
    reqTime = new Date(timestamp).getTime();
    if (isNaN(reqTime)) reqTime = now;
  } catch {
    reqTime = now;
  }

  const ageSec = Math.floor((now - reqTime) / 1000);
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  return `${Math.floor(ageSec / 3600)}h`;
}

function statusColor(status: string): string {
  if (process.env.NO_COLOR) return status;
  switch (status) {
    case 'pending':  return `\x1b[33m${status}\x1b[0m`;
    case 'approved': return `\x1b[32m${status}\x1b[0m`;
    case 'denied':   return `\x1b[31m${status}\x1b[0m`;
    default:         return status;
  }
}

export function listApprovals(ctx: AppContext, opts: { all?: boolean } = {}): string {
  const dir = ensureApprovalsDir(ctx);
  const requests = readApprovalFiles(dir);

  const filtered = opts.all ? requests : requests.filter(r => r.status === 'pending');

  if (filtered.length === 0) {
    return 'No pending approval requests.';
  }

  const header = formatRow('ID', 'Agent', 'Tool', 'Input', 'Age');
  const divider = formatRow('---', '-----', '----', '-----', '---');
  const rows = filtered.map(r =>
    formatRow(r.id, r.agent, r.tool, truncate(r.input, 40), formatAge(r.timestamp))
  );

  return [header, divider, ...rows].join('\n');
}

function formatRow(id: string, agent: string, tool: string, input: string, age: string): string {
  return `${id.padEnd(28)} ${agent.padEnd(10)} ${tool.padEnd(12)} ${input.padEnd(40)} ${age}`;
}

function truncate(s: string, len: number): string {
  if (!s) return '';
  return s.length > len ? s.slice(0, len - 3) + '...' : s;
}

export function approveRequest(ctx: AppContext, target: string): string {
  const dir = ensureApprovalsDir(ctx);
  const decidedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  if (target === '--all') {
    const requests = readApprovalFiles(dir);
    const pending = requests.filter(r => r.status === 'pending');
    for (const req of pending) {
      const filePath = join(dir, `${req.id}.json`);
      req.status = 'approved';
      req.decided_at = decidedAt;
      writeFileSync(filePath, JSON.stringify(req, null, 2) + '\n');
    }
    return `Approved ${pending.length} pending request(s).`;
  }

  const filePath = join(dir, `${target}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`request '${target}' not found.`);
  }

  const data = JSON.parse(readFileSync(filePath, 'utf-8')) as ApprovalRequest;
  data.status = 'approved';
  data.decided_at = decidedAt;
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return `Approved ${target}.`;
}

export function denyRequest(ctx: AppContext, target: string): string {
  const dir = ensureApprovalsDir(ctx);
  const decidedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const filePath = join(dir, `${target}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`request '${target}' not found.`);
  }

  const data = JSON.parse(readFileSync(filePath, 'utf-8')) as ApprovalRequest;
  data.status = 'denied';
  data.decided_at = decidedAt;
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  return `Denied ${target}.`;
}

export function registerApprovalsCommands(program: Command, ctx: AppContext): void {
  program
    .command('approvals')
    .description('List pending approvals')
    .option('--all', 'Show all approvals (not just pending)')
    .action((opts) => {
      console.log(listApprovals(ctx, opts));
    });

  program
    .command('approve')
    .description('Approve a request')
    .argument('<id>', 'Approval ID or --all')
    .action((id: string) => {
      try {
        console.log(approveRequest(ctx, id));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command('deny')
    .description('Deny a request')
    .argument('<id>', 'Approval ID')
    .action((id: string) => {
      try {
        console.log(denyRequest(ctx, id));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command('watch')
    .description('Watch approvals live')
    .option('--interval <ms>', 'Poll interval in seconds', '2')
    .action((opts) => {
      const dir = ensureApprovalsDir(ctx);
      const intervalSec = parseFloat(opts.interval) || 2;
      const seen = new Set<string>();

      console.log('\x1b[1mWatching for approval requests...\x1b[0m (Ctrl+C to stop)\n');

      const poll = () => {
        const requests = readApprovalFiles(dir);

        // Show new pending requests
        for (const req of requests) {
          if (req.status !== 'pending') continue;
          if (seen.has(req.id)) continue;
          seen.add(req.id);

          console.log(`\x1b[1;33m>>> NEW APPROVAL REQUEST\x1b[0m [${req.timestamp}]`);
          console.log(`    ID:    ${req.id}`);
          console.log(`    Agent: \x1b[1;36m${req.agent}\x1b[0m`);
          console.log(`    Tool:  \x1b[1m${req.tool}\x1b[0m`);
          console.log(`    Input: ${truncate(req.input, 80)}`);
          console.log(`    -> \x1b[1magent-pool approve ${req.id}\x1b[0m  or  \x1b[1magent-pool approve --all\x1b[0m\n`);
        }

        // Clean seen entries for requests that no longer exist
        const currentIds = new Set(requests.map(r => r.id));
        for (const id of seen) {
          if (!currentIds.has(id)) {
            seen.delete(id);
          }
        }
      };

      poll();
      const timer = setInterval(poll, intervalSec * 1000);

      // Graceful shutdown
      process.on('SIGINT', () => {
        clearInterval(timer);
        console.log('\nStopped watching.');
        process.exit(0);
      });
    });
}
