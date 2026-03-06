#!/usr/bin/env bash
set -euo pipefail

# finish-task.sh — marks the current agent task and signals agent-runner
# Called from inside a Claude session via the /finish command.
#
# Required env vars (set by agent-runner.sh):
#   AGENT_POOL_TASK_ID    — current task ID
#   AGENT_POOL_PROJECT    — project name
#   AGENT_POOL_DATA_DIR   — data directory (e.g. ~/.agent-pool)
#
# Usage: finish-task.sh [status]
#   status: completed (default), blocked, pending, backlogged

STATUS="${1:-completed}"

# Validate env vars
for var in AGENT_POOL_TASK_ID AGENT_POOL_PROJECT AGENT_POOL_DATA_DIR; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set. This script must be run from an agent-pool Claude session." >&2
    exit 1
  fi
done

# Validate status
case "$STATUS" in
  completed|blocked|pending|backlogged) ;;
  *)
    echo "ERROR: Invalid status '$STATUS'. Must be: completed, blocked, pending, or backlogged." >&2
    exit 1
    ;;
esac

TASKS_JSON="$AGENT_POOL_DATA_DIR/tasks-${AGENT_POOL_PROJECT}.json"
LOCK_DIR="$TASKS_JSON.lock"

if [[ ! -f "$TASKS_JSON" ]]; then
  echo "ERROR: Tasks file not found: $TASKS_JSON" >&2
  exit 1
fi

# Acquire lock (same pattern as agent-runner.sh)
max_wait=50
waited=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  sleep 0.1
  waited=$((waited + 1))
  if [[ $waited -ge $max_wait ]]; then
    echo "ERROR: Could not acquire task lock after 5 seconds." >&2
    exit 1
  fi
done

# Mark the task
/usr/bin/python3 -c "
import json, sys, time, os
with open('$TASKS_JSON', 'r') as f:
    data = json.load(f)
for t in data['tasks']:
    if t['id'] == sys.argv[1]:
        t['status'] = sys.argv[2]
        if sys.argv[2] in ('completed', 'blocked'):
            t['completed_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        if sys.argv[2] in ('pending', 'backlogged'):
            t['claimed_by'] = ''
            t.pop('started_at', None)
            t.pop('completed_at', None)
        break
tmp = '$TASKS_JSON' + '.tmp'
with open(tmp, 'w') as f:
    json.dump(data, f, indent=2)
os.rename(tmp, '$TASKS_JSON')
" "$AGENT_POOL_TASK_ID" "$STATUS"

# Release lock
rm -rf "$LOCK_DIR"

# Write signal file so agent-runner skips post-exit handling
SIGNAL_FILE="$AGENT_POOL_DATA_DIR/.task-finished-${AGENT_POOL_TASK_ID}"
echo "$STATUS" > "$SIGNAL_FILE"

echo "Task $AGENT_POOL_TASK_ID marked as $STATUS."
