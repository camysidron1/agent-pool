# Phase 00 p0-009: Add import-boundary proof

## Summary

Added a lightweight Bun test that scans source imports to enforce Phase 0 package boundaries for the web app and orchestrator.

## Files/modules changed

- `packages/shared/tests/import-boundaries.test.ts` — import-boundary proof that runs with the root `bun run test` command.
- `agent-docs/implementation-phases/state/00-repository-tooling-foundation.json` — marked `p0-009` completed and advanced `currentTaskId` to `p0-010`.

## Commands/checks run

- `rtk node agent-docs/implementation-phases/tools/check-phase.mjs 00`
- `rtk bash agent-docs/implementation-phases/tools/run-one.sh 00 p0-009`
- `rtk bun run typecheck`
- `rtk bun run test`

## Acceptance criteria status

- Web does not import `@agent-pool/db`, `@agent-pool/queue`, or `@agent-pool/runtime`: satisfied by the import-boundary test scanning `apps/web/src`.
- Orchestrator does not import `@agent-pool/db`: satisfied by the import-boundary test scanning `apps/orchestrator/src`.
- Import-boundary mechanism runs in `bun run test`: satisfied because root `bun run test` runs `bun test packages`, including `packages/shared/tests/import-boundaries.test.ts`.

## Known gaps/follow-ups

The check is intentionally lightweight and package-specifier based for Phase 0. Future phases can expand it if additional forbidden direct runtime/provider imports need automated enforcement.

## Next task

`p0-010` is unblocked, but was not started per operator instruction.
