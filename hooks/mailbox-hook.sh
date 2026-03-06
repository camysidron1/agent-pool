#!/usr/bin/env bash
# PreToolUse hook: checks for mailbox messages from the orchestrator.
# Fast path: if no mailbox file exists, exit immediately (< 1ms overhead).
# When a message is found, it's returned as feedback and the file is deleted.
set -euo pipefail

# Fast path: check for mailbox file using the agent ID from cwd
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
