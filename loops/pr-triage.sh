#!/bin/bash
# PR Triage Loop — runs every 30 minutes via cron
# Creates an agent-pool task that triages recent PRs and Slacks a concise digest

PROMPT='Find PRs opened or updated in the last 24 hours targeting stg:
  gh pr list --state open --base stg --json number,title,headRefName,createdAt,updatedAt,author,additions,deletions,changedFiles,files

FILTER: Only include PRs where createdAt is within the last 24 hours. Skip anything older.

For each qualifying PR, read the diff: gh pr diff <number>

Only flag PRs that touch sensitive areas:
  - Auth/security: nebari/ts/apps/security/src/app/(auth)/, nebari/python/worker/agents/
  - Data models/migrations: nebari/python/db/, drizzle schema files
  - Infrastructure: infra/, Dockerfiles, terraform
  - API contracts: tRPC routers, OpenAPI specs
  - CI/CD: .github/workflows/

IMPORTANT: Post to Slack using curl with $SLACK_BOT_TOKEN (do NOT use MCP Slack tools — they post as the wrong user):
  curl -s -X POST "https://slack.com/api/chat.postMessage" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"channel\": \"U091M6FLM61\", \"text\": \"<formatted digest>\"}"

Format — keep it SHORT. No filler. Just signal:

  *PR Triage — <date>*
  <N> new PRs in last 24h

  *Flagged:*
  - #<num> <title> — <what sensitive area it touches and why it matters>

  *Clean:*
  <N> PRs with no sensitive-area changes (list numbers only: #101, #102, #103)

If zero new PRs in 24h, send: "No new PRs against stg in the last 24h"
If no PRs are flagged, skip the Flagged section entirely.

Write full analysis to shared-docs/pr-triage-latest.md.'

agent-pool -p nebari run -q --env local "$PROMPT"
