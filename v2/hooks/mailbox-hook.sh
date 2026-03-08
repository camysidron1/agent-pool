#!/usr/bin/env bash
# PreToolUse hook: checks for mailbox messages + writes heartbeat.
# Fast path: if no mailbox file exists and no heartbeat needed, exit quickly.
set -euo pipefail

# --- Heartbeat writing (agent health signal, ~2ms overhead) ---
if [[ -n "${AGENT_POOL_DATA_DIR:-}" ]] && [[ -n "${AGENT_POOL_AGENT_ID:-}" ]]; then
  HEARTBEAT_DIR="$AGENT_POOL_DATA_DIR/heartbeats"
  mkdir -p "$HEARTBEAT_DIR"
  cat > "$HEARTBEAT_DIR/$AGENT_POOL_AGENT_ID.json" <<HEARTBEAT
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","pid":$$,"task_id":"${AGENT_POOL_TASK_ID:-}","last_tool":"${TOOL_NAME:-}"}
HEARTBEAT
fi

# --- Mailbox check ---
MAILBOX="$PWD/.mailbox"
[[ -f "$MAILBOX" ]] || exit 0

# Read and clear atomically (move then read to prevent races)
TMP_MAILBOX="${MAILBOX}.read.$$"
mv "$MAILBOX" "$TMP_MAILBOX" 2>/dev/null || exit 0

MESSAGE=$(cat "$TMP_MAILBOX" 2>/dev/null || true)
rm -f "$TMP_MAILBOX"

[[ -z "$MESSAGE" ]] && exit 0

# Return the message as tool feedback via JSON on stdout
jq -n --arg msg "$MESSAGE" '{
  decision: "allow",
  reason: ("📬 Message from orchestrator:\n\n" + $msg + "\n\nPlease acknowledge and incorporate these instructions into your current work.")
}'
