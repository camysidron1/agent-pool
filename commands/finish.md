---
description: "Mark the current agent-pool task with a status and end the session"
argument-hint: "[completed|blocked|pending|backlogged]"
allowed-tools: ["Bash"]
---

# Finish Task

Run the finish-task script to mark this task and end the session. The status defaults to `completed` if not specified.

**Valid statuses:** `completed`, `blocked`, `pending` (retry), `backlogged`

## Steps

1. If you created a PR with `gh pr create` and your workflow instructions mention auto-merge, enable it now:

```bash
gh pr merge --auto --squash
```

Use the merge method specified in your workflow instructions (squash, merge, or rebase). If this fails, log a warning (e.g. "Auto-merge not available for this repo") and continue — do not block the task.

2. Run the finish script:

```bash
"$AGENT_POOL_TOOL_DIR/finish-task.sh" $ARGUMENTS
```

3. After the script succeeds, print a brief confirmation message including the PR URL if one was created.

4. **IMPORTANT**: After confirming, you are DONE. Do not do any more work. Do not ask follow-up questions. Simply stop responding so the session can end.
