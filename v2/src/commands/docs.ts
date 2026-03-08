import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';

export function registerDocsCommand(program: Command, ctx: AppContext): void {
  program
    .command('docs [target]')
    .description('View documentation directories and files')
    .action((target?: string) => {
      const docsDir = join(ctx.config.dataDir, 'docs');

      if (!existsSync(docsDir)) {
        console.log('No docs directory yet. Docs are created when agents run.');
        return;
      }

      if (!target) {
        listAllDocs(docsDir);
      } else if (target === 'shared') {
        showDirContents(join(docsDir, 'shared'), 'Shared docs');
      } else {
        showDirContents(join(docsDir, 'agents', target), `Docs for ${target}`);
      }
    });
}

function listAllDocs(docsDir: string): void {
  const header = [
    padRight('Directory', 20),
    padRight('Files', 8),
    'Last Modified',
  ].join(' ');
  const separator = [
    padRight('---------', 20),
    padRight('-----', 8),
    '-------------',
  ].join(' ');

  console.log(header);
  console.log(separator);

  const sharedDir = join(docsDir, 'shared');
  if (existsSync(sharedDir) && statSync(sharedDir).isDirectory()) {
    printDirInfo(sharedDir, 'shared');
  }

  const agentsDir = join(docsDir, 'agents');
  if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
    for (const entry of readdirSync(agentsDir)) {
      const agentDir = join(agentsDir, entry);
      if (statSync(agentDir).isDirectory()) {
        printDirInfo(agentDir, entry);
      }
    }
  }
}

function printDirInfo(dir: string, label: string): void {
  const files = readdirSync(dir).filter(f => {
    try {
      return statSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  });

  let lastMod = '-';
  if (files.length > 0) {
    let maxMtime = 0;
    for (const f of files) {
      const mtime = statSync(join(dir, f)).mtimeMs;
      if (mtime > maxMtime) maxMtime = mtime;
    }
    const d = new Date(maxMtime);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    lastMod = `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  console.log(
    [padRight(label, 20), padRight(String(files.length), 8), lastMod].join(' ')
  );
}

function showDirContents(dir: string, heading: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    if (heading.startsWith('Shared')) {
      console.log('No shared docs yet.');
    } else {
      const name = heading.replace('Docs for ', '');
      console.log(`No docs for agent '${name}'.`);
    }
    return;
  }

  console.log(`${heading} (${dir}):\n`);

  const entries = readdirSync(dir).filter(f => {
    try {
      return statSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  });

  if (entries.length === 0) {
    console.log('  (empty)');
    return;
  }

  for (const fname of entries) {
    const filePath = join(dir, fname);
    if (fname.endsWith('.md')) {
      console.log(`=== ${fname} ===`);
      console.log(readFileSync(filePath, 'utf-8'));
    } else {
      console.log(`  ${fname}`);
    }
  }
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}
