#!/usr/bin/env bash
set -euo pipefail

# finish-task.sh — delegates to v2 TypeScript finish-task
# Called from inside a Claude session via the /finish command.
#
# Required env vars (set by agent-runner.sh or v2 run-agent):
#   AGENT_POOL_TASK_ID    — current task ID
#   AGENT_POOL_PROJECT    — project name
#   AGENT_POOL_DATA_DIR   — data directory (e.g. ~/.agent-pool)
#   AGENT_POOL_TOOL_DIR   — tool directory (e.g. ~/.agent-pool)

TOOL_DIR="${AGENT_POOL_TOOL_DIR:-$(cd "$(dirname "$0")" && pwd)}"
exec bun run "$TOOL_DIR/v2/src/finish-task.ts" "$@"
