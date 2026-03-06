---
description: "update agent, send message to agent, inject instructions, mailbox, /update"
argument-hint: "<clone-index|all> <message>"
allowed-tools: ["Bash"]
---

# Update Running Agent

Send a message to a running agent. Works regardless of task status — agents can be mid-task, idle after /finish, or polling for work.

## Usage

The user provides a clone index (or "all") and a message. Parse $ARGUMENTS to extract:
- The target: a clone index (e.g. `0`, `01`, `3`) or `all` for every active clone
- The message (everything after the target)

## Steps

1. Determine the project and clone paths. Run:

```bash
~/.agent-pool/agent-pool status
```

The clone path follows the pattern: `~/.agent-pool/<prefix>-<NN>/`

2. For each target clone, deliver the message using TWO methods (both are needed for reliability):

**Method A — Mailbox file** (picked up if agent is actively making tool calls):
```bash
echo '<message>' > <clone-path>/.mailbox
```

**Method B — Direct pane input** (picked up if agent is idle/waiting for input):
Find the agent's cmux surface and send the message as user input:
```bash
# List all workspace surfaces
for ws in $(cmux --json list-workspaces 2>/dev/null | python3 -c "import json,sys; [print(w['ref']) for w in json.load(sys.stdin).get('workspaces',[])]"); do
  for surf in $(cmux --json list-pane-surfaces --workspace "$ws" 2>/dev/null | python3 -c "import json,sys; [print(s['ref']) for s in json.load(sys.stdin).get('surfaces',[])]"); do
    # Check if this surface's working directory matches the clone
    cmux send --surface "$surf" "" 2>/dev/null || continue
    # We can't perfectly identify surfaces, so use a targeted approach:
    # Read recent pane content to see if it contains the agent ID
    content=$(cmux read --surface "$surf" --lines 5 2>/dev/null || true)
    if echo "$content" | grep -qF "<agent-id-or-clone-path>"; then
      cmux send --surface "$surf" '<message>' 2>/dev/null
    fi
  done
done
```

If cmux surface detection is unreliable, fall back to writing the mailbox only and inform the user they may need to manually type a message in the agent's pane to wake it up.

3. Confirm delivery to the user. If using "all", report how many agents were updated.

## Handling "all"

When the target is `all`, iterate over every clone shown in `agent-pool status` and deliver the message to each one.

## Notes

- This works regardless of task status — completed, in_progress, blocked, or idle
- The mailbox is one-shot: the hook reads and deletes the file
- The direct pane input wakes up idle agents that stopped after /finish
- Only one mailbox message at a time per agent — a new message overwrites any unread one
- If an agent is truly dead (session ended, runner exited), the message won't be received — inform the user to restart that agent instead
