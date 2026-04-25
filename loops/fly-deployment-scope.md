# Agent Pool — Fly.io Always-On Deployment

## What we're deploying

A single Fly.io machine running agent-pool with 2 runners that poll the task queue and execute Claude Code agents. Cron (or the agent-pool daemon) creates recurring tasks on schedule. Results are Slacked.

## Architecture

```
┌─ Fly.io Machine (shared-1x-cpu, 512MB) ─────────────┐
│                                                       │
│  crond                                                │
│  ├─ */30 * * * *  loops/pr-triage.sh                 │
│  ├─ 0 */2 * * *   loops/alert-digest.sh             │
│  └─ 0 7 * * *     loops/morning-briefing.sh         │
│                                                       │
│  agent-runner.sh × 2  (poll task queue)              │
│  ├─ claims task from SQLite                          │
│  ├─ spawns: claude -p "<prompt>"                     │
│  └─ marks task complete/blocked                      │
│                                                       │
│  Volume: /data (1GB)                                  │
│  ├─ agent-pool.db       (SQLite)                     │
│  ├─ clones/             (Git clones, 2)              │
│  └─ shared-docs/        (cross-task output)          │
└───────────────────────────────────────────────────────┘
```

## Secrets (via `fly secrets set`)

- `ANTHROPIC_API_KEY` — Claude API access
- `GITHUB_TOKEN` — gh CLI auth (PAT with repo scope)
- `SLACK_BOT_TOKEN` — from 1Password: op://Environments/Slack/integration/bot_token
- `SSH_PRIVATE_KEY` — for git clone over SSH (or use HTTPS + GITHUB_TOKEN)

## Dockerfile sketch

```dockerfile
FROM oven/bun:1.3-alpine

# System deps
RUN apk add --no-cache git bash curl openssh-client cron python3

# GitHub CLI
RUN apk add --no-cache github-cli

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Agent pool
COPY . /opt/agent-pool
WORKDIR /opt/agent-pool

# Data lives on the persistent volume
ENV AGENT_POOL_DATA_DIR=/data
ENV AGENT_POOL_TOOL_DIR=/opt/agent-pool

# Cron jobs
COPY loops/crontab /etc/crontabs/root

# Entrypoint: start crond + 2 agent runners
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
```

## entrypoint.sh sketch

```bash
#!/bin/bash
set -e

# Set up git credentials
mkdir -p ~/.ssh
echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
ssh-keyscan github.com >> ~/.ssh/known_hosts

# Configure gh
echo "$GITHUB_TOKEN" | gh auth login --with-token

# Initialize agent-pool project if first run
if [ ! -f /data/agent-pool.db ]; then
  agent-pool project add nebari \
    --source https://github.com/your-org/nebari-mvp \
    --branch stg
  agent-pool init -p nebari --count 2
fi

# Start cron
crond -b

# Start 2 runners in background
./agent-runner.sh --agent 0 --project nebari &
./agent-runner.sh --agent 1 --project nebari &

# Wait for any to exit
wait -n
```

## fly.toml sketch

```toml
app = "agent-pool-loops"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[[mounts]]
  source = "agent_pool_data"
  destination = "/data"
  initial_size = "1gb"

[[vm]]
  size = "shared-cpu-1x"
  memory = 512
  auto_stop_machines = "off"    # must stay running for cron
  auto_start_machines = true

[env]
  AGENT_POOL_DATA_DIR = "/data"
```

## Estimated cost

- Machine: ~$3.19/mo (shared-1x-cpu, 512MB, always-on)
- Volume: ~$0.15/mo (1GB)
- **Total infra: ~$3.34/mo**
- Claude API: depends on task frequency/complexity (budget ~$20-50/mo for 7 recurring loops)

## Steps to deploy

1. `fly apps create agent-pool-loops`
2. `fly volumes create agent_pool_data --size 1 --region iad`
3. Set secrets:
   ```bash
   fly secrets set ANTHROPIC_API_KEY="..."
   fly secrets set GITHUB_TOKEN="..."
   fly secrets set SLACK_BOT_TOKEN="..."
   fly secrets set SSH_PRIVATE_KEY="$(cat ~/.ssh/id_ed25519)"
   ```
4. `fly deploy`
5. Verify: `fly ssh console` → `agent-pool status`

## Open questions

- [ ] Do we want auto-stop when no tasks are pending? Saves cost but adds cold-start latency (~5s).
- [ ] Should the Fly machine pull loop configs from a git repo (config-as-code) or manage them locally?
- [ ] Do we need log shipping (Fly logs are ephemeral)? Could ship to Grafana/Datadog.
- [ ] 1 machine with 2 runners, or 2 machines with 1 runner each? (1 machine is simpler and cheaper)
