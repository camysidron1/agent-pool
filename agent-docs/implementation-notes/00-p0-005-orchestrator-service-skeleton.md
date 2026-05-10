# Phase 00 / p0-005 — Orchestrator Service Skeleton

Date: 2026-05-08

## Summary

Added the orchestrator workspace skeleton with a Bun service entrypoint, health endpoint, and placeholder metrics endpoint. The orchestrator imports only `@agent-pool/config` and `@agent-pool/shared`, and it does not import `packages/db`, open SQLite, or depend on TUI code.

## Files/modules changed

- `apps/orchestrator/package.json` — added orchestrator package metadata, scripts, and workspace dependency declarations.
- `apps/orchestrator/tsconfig.json` — added TypeScript config for orchestrator source.
- `apps/orchestrator/src/server.ts` — added fetch handler, `/health`, `/metrics`, and Bun.serve startup helper.
- `apps/orchestrator/src/index.ts` — added Bun service entrypoint and public exports.
- `tsconfig.json` — included orchestrator source in root typecheck.
- `agent-docs/implementation-phases/state/00-repository-tooling-foundation.json` — marked `p0-005` complete and advanced `currentTaskId` to `p0-006`.

## Commands/checks run

- `rtk git status --short`
- `rtk node agent-docs/implementation-phases/tools/check-phase.mjs 00`
- `rtk bash agent-docs/implementation-phases/tools/run-one.sh 00 p0-005`
- `rtk bun run typecheck` — passed.
- `rtk bun run test` — passed.

## Acceptance criteria status

- `apps/orchestrator` exists with Bun service entrypoint: passed.
- Orchestrator exposes health/metrics endpoint or documented stubs: passed with `GET /health` and `GET /metrics`.
- Orchestrator imports config/shared only at this phase: passed.
- Orchestrator does not import `packages/db` or open SQLite: passed.

## Known gaps/follow-ups

- The orchestrator currently exposes only skeleton health/metrics behavior; task claiming, RabbitMQ wakeups, runtime providers, and backend internal API calls are deferred to later tasks.
- The metrics endpoint is a placeholder and intentionally does not expose real counters yet.

## Next task

`p0-006` is dependency-unblocked and set as the next current task. Work was intentionally stopped before implementing it.
