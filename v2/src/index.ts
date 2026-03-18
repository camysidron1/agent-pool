#!/usr/bin/env bun
import { createApp } from './app.js';
import { createProductionContext } from './container.js';

const dataDir = process.env.AGENT_POOL_DATA_DIR || `${process.env.HOME}/.agent-pool/data`;
const toolDir = process.env.AGENT_POOL_TOOL_DIR || `${process.env.HOME}/.agent-pool`;

const ctx = createProductionContext({ dataDir, toolDir });
const app = createApp(ctx);
try {
  await app.parseAsync(process.argv);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
