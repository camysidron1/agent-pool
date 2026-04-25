#!/bin/bash
# Alert Digest Loop — runs every 2 hours via cron
# Queries Sentry for recent errors across all projects and Slacks a digest

PROMPT='Query Sentry for unresolved errors across all projects and environments.

Use the nenv-sentry CLI tool (at nebari/python/scripts/nenv-sentry):
  nenv-sentry api issues --env nomadic-nutmeg --query "is:unresolved" --limit 25
  nenv-sentry worker issues --env nomadic-nutmeg --query "is:unresolved" --limit 25
  nenv-sentry frontend issues --env nomadic-nutmeg --query "is:unresolved" --limit 25

Also check staging environments:
  nenv-sentry api issues --env stumpy-tangerine --query "is:unresolved" --limit 10
  nenv-sentry worker issues --env stumpy-tangerine --query "is:unresolved" --limit 10

For each issue:
1. Note: title, issue ID, error count, first/last seen, affected environment
2. For the top 5 highest-frequency issues, get details: nenv-sentry <project> issue <id>
3. Check if the error is NEW (first seen in last 2 hours) or ongoing

Compare against shared-docs/alert-digest-latest.md if it exists:
- Flag NEW errors not in the previous digest
- Flag RESOLVED errors that were in the previous digest but are no longer unresolved
- Flag SPIKES — errors whose count jumped significantly

Classify each issue:
- CRITICAL: Production errors with high frequency or user-facing impact
- WARNING: Staging errors, low-frequency production errors, or regressions
- INFO: Known/tracked issues with stable counts

IMPORTANT: Post to Slack using curl with $SLACK_BOT_TOKEN (do NOT use MCP Slack tools — they post as the wrong user):
  curl -s -X POST "https://slack.com/api/chat.postMessage" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"channel\": \"U091M6FLM61\", \"text\": \"<formatted digest>\"}"

Format the Slack message as:
  *Alert Digest — <date> <time>*
  Production: <N> unresolved | Staging: <N> unresolved

  *New Errors (last 2h):*
  - :red_circle: [<project>] <title> — <count> events, first seen <time>

  *Critical (ongoing):*
  - :red_circle: [<project>] <title> — <count> events since <date>

  *Warning:*
  - :large_yellow_circle: [<project>] <title> — <count> events

  *Resolved since last digest:*
  - :white_check_mark: [<project>] <title>

  If no new or critical errors: "All clear — <N> unresolved issues, no new errors in the last 2h"

Write the full analysis to shared-docs/alert-digest-latest.md with complete details, stack traces for new errors, and Sentry links.'

agent-pool -p nebari run -q --env local "$PROMPT"
