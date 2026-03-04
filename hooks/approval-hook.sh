#!/usr/bin/env bash
# PreToolUse hook: forwards permission requests to a shared approval queue.
# The driver can approve/deny via: agent-pool approvals | approve | deny
set -euo pipefail

APPROVALS_DIR="$HOME/.agent-pool/approvals"
mkdir -p "$APPROVALS_DIR"

# Read hook payload from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // {} | tostring' | head -c 200)

# Derive agent ID from CWD (e.g. /Users/x/.agent-pool/ap-05 → ap-05)
AGENT_ID=$(basename "$PWD")

# Build request
EPOCH=$(date +%s)
REQ_ID="req-${EPOCH}-${AGENT_ID}"
REQ_FILE="$APPROVALS_DIR/${REQ_ID}.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

jq -n \
  --arg id "$REQ_ID" \
  --arg agent "$AGENT_ID" \
  --arg tool "$TOOL_NAME" \
  --arg input "$TOOL_INPUT" \
  --arg ts "$TIMESTAMP" \
  '{id: $id, agent: $agent, tool: $tool, input: $input, timestamp: $ts, status: "pending", decided_at: null}' \
  > "$REQ_FILE"

# Poll for decision (max 300s)
WAITED=0
MAX_WAIT=300
while [[ $WAITED -lt $MAX_WAIT ]]; do
  if [[ ! -f "$REQ_FILE" ]]; then
    # File removed externally — treat as deny
    exit 2
  fi

  STATUS=$(jq -r '.status' "$REQ_FILE" 2>/dev/null || echo "pending")

  if [[ "$STATUS" == "approved" ]]; then
    rm -f "$REQ_FILE"
    exit 0
  elif [[ "$STATUS" == "denied" ]]; then
    rm -f "$REQ_FILE"
    echo "Permission denied by driver" >&2
    exit 2
  fi

  sleep 1
  WAITED=$((WAITED + 1))
done

# Timeout — deny by default
rm -f "$REQ_FILE"
echo "Approval request timed out after ${MAX_WAIT}s" >&2
exit 2
