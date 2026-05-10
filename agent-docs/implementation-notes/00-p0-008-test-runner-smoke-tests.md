# Phase 00 p0-008: Add test runner smoke tests

## Summary

Added a deterministic Bun smoke test that exercises the shared package exports and verifies the tiny fixture repository path exists.

## Files/modules changed

- `packages/shared/tests/smoke.test.ts` — workspace smoke test for shared exports and fixture path visibility.
- `test-fixtures/tiny-repo/.gitkeep` — minimal fixture repository path for future tests.
- `agent-docs/implementation-phases/state/00-repository-tooling-foundation.json` — marked `p0-008` completed and advanced `currentTaskId` to `p0-009`.

## Commands/checks run

- `rtk node agent-docs/implementation-phases/tools/check-phase.mjs 00`
- `rtk bash agent-docs/implementation-phases/tools/run-one.sh 00 p0-008`
- `rtk bun run typecheck`
- `rtk bun run test`

## Acceptance criteria status

- `bun run test` executes deterministic smoke tests: satisfied.
- Config/env tests cover `AUTH_MODE=test` and non-test missing env rejection: already covered by `packages/config/tests/config.test.ts`, verified by `bun run test`.
- Tiny fixture repo path exists or test setup can create it: satisfied by `test-fixtures/tiny-repo/.gitkeep` and the shared smoke test assertion.

## Known gaps/follow-ups

None.

## Next task

`p0-009` is unblocked.
