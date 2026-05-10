# Phase 00 p0-010: Add optional Docker Compose skeleton

## Summary

Added a minimal Docker Compose skeleton for local web/sandbox infrastructure. The skeleton wires the backend API, orchestrator, RabbitMQ, MinIO-backed local blob storage, and Prometheus without requiring real E2B credentials or paid provider calls.

## Files/modules changed

- `deploy/compose/docker-compose.yml` — local Compose services for API, orchestrator, RabbitMQ, MinIO, and Prometheus.
- `deploy/compose/prometheus.yml` — scrape configuration for API and orchestrator placeholder metrics endpoints.
- `agent-docs/implementation-phases/state/00-repository-tooling-foundation.json` — marked `p0-010` and Phase 00 completed.

## Commands/checks run

- `rtk node agent-docs/implementation-phases/tools/check-phase.mjs 00`
- `rtk bash agent-docs/implementation-phases/tools/run-one.sh 00 p0-010`
- `rtk bun run typecheck`
- `rtk bun run test`

## Acceptance criteria status

- Compose skeleton exists for backend, orchestrator, RabbitMQ, local blob storage, and Prometheus: satisfied.
- Compose deferred reason documented if deferred: not applicable; Compose was implemented.
- Compose skeleton does not require real E2B or paid providers: satisfied. Services run with `AUTH_MODE=test`, MinIO local storage, and `RUNTIME_PROVIDER=stub`.

## Known gaps/follow-ups

This is a Phase 0 skeleton only. It starts current placeholder services and supporting infrastructure, but does not implement future runtime provider, queue, storage, or database behavior.

## Next task

No Phase 0 task remains. Phase 1 was not started.
