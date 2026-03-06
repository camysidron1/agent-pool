---
description: "Mark the current agent-pool task with a status and end the session"
argument-hint: "[completed|blocked|pending|backlogged]"
allowed-tools: ["Bash"]
---

# Finish Task

Run the finish-task script to mark this task and end the session. The status defaults to `completed` if not specified.

**Valid statuses:** `completed`, `blocked`, `pending` (retry), `backlogged`

## Steps

1. Run the finish script:

```bash
"$AGENT_POOL_TOOL_DIR/finish-task.sh" $ARGUMENTS
```

2. After the script succeeds, print a brief confirmation message to the user.

3. **IMPORTANT**: After confirming, you are DONE. Do not do any more work. Do not ask follow-up questions. Simply stop responding so the session can end.
