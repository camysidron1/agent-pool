import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { DaemonServer } from '../daemon/server.js';
import { DaemonClient } from '../daemon/client.js';
import { startDaemon } from '../daemon/index.js';
import { join } from 'path';
import { bold, green, red, dim } from '../util/colors.js';

export function registerDaemonCommand(program: Command, ctx: AppContext): void {
  const daemon = program
    .command('daemon')
    .description('Manage the agent-pool daemon');

  daemon
    .command('start')
    .description('Start the daemon in foreground')
    .action(async () => {
      console.log('Starting daemon...');
      const server = await startDaemon({
        dataDir: ctx.config.dataDir,
        taskStore: ctx.stores.tasks,
      });
      console.log(green(`Daemon running (PID: ${process.pid})`));

      // Keep running until signal
      const shutdown = () => {
        console.log('\nShutting down daemon...');
        server.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

  daemon
    .command('stop')
    .description('Stop a running daemon')
    .action(async () => {
      const dataDir = ctx.config.dataDir;
      const socketPath = join(dataDir, 'apd.sock');

      // Try graceful shutdown via socket
      const client = new DaemonClient({ socketPath, timeoutMs: 3000 });
      const connected = await client.connect();
      if (connected) {
        try {
          await client.request('shutdown');
          client.close();
          console.log(green('Daemon stopped.'));
          return;
        } catch {
          client.close();
        }
      }

      // Fall back to killing the PID
      const pid = await DaemonServer.readPid(dataDir);
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
          console.log(green(`Daemon stopped (PID: ${pid}).`));
          return;
        } catch {
          // PID not alive
        }
      }

      console.log('No running daemon found.');
    });

  daemon
    .command('status')
    .description('Show daemon status')
    .action(async () => {
      const dataDir = ctx.config.dataDir;
      const socketPath = join(dataDir, 'apd.sock');

      const client = new DaemonClient({ socketPath, timeoutMs: 3000 });
      const connected = await client.connect();
      if (connected) {
        try {
          const resp = await client.request('status');
          client.close();
          if (resp.result) {
            const r = resp.result as Record<string, unknown>;
            console.log(bold('Daemon:'), green('running'));
            if (r.pid) console.log(`  PID: ${r.pid}`);
            if (r.uptime) console.log(`  Uptime: ${formatUptime(r.uptime as number)}`);
            if (r.connectedClients !== undefined) console.log(`  Connected clients: ${r.connectedClients}`);
            if (r.readyRunners !== undefined) console.log(`  Ready runners: ${r.readyRunners}`);
            return;
          }
        } catch {
          client.close();
        }
      }

      // Check PID file
      const pid = await DaemonServer.readPid(dataDir);
      if (pid) {
        try {
          process.kill(pid, 0);
          console.log(bold('Daemon:'), green('running'), dim(`(PID: ${pid})`));
          return;
        } catch {
          // stale PID
        }
      }

      console.log(bold('Daemon:'), red('not running'));
    });
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}
