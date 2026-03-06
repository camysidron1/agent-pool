---
description: "update agent, send message to agent, inject instructions, mailbox, /update"
argument-hint: "<clone-index> <message>"
allowed-tools: ["Bash"]
---

# Update Running Agent

Send a message to a running agent via its mailbox. The agent's PreToolUse hook will pick it up on the next tool call and incorporate the instructions.

## Usage

The user provides a clone index (or agent name) and a message. Parse $ARGUMENTS to extract:
- The clone index (first number, e.g. `0`, `01`, `3`)
- The message (everything after the index)

## Steps

1. Determine the clone path. Run:

```bash
~/.agent-pool/agent-pool status
```

to see active clones and their indices. The clone path follows the pattern: `~/.agent-pool/<prefix>-<NN>/`

2. Write the message to the agent's mailbox:

```bash
# Replace <clone-path> with the actual path
echo '<message>' > <clone-path>/.mailbox
```

3. Confirm to the user that the message was delivered. The agent will see it on its next tool call.

## Notes

- Messages are one-shot: the hook reads and deletes the file
- If the agent is between tool calls, there may be a brief delay
- Only one message at a time per agent — a new message overwrites any unread one
