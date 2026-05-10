# Phase 00 / p0-003 — Config Package With Env Validation

Date: 2026-05-08

## Summary

Added the shared config package skeleton with typed environment loading, explicit `AUTH_MODE=test` behavior, and deterministic test operator identity. The package stays browser/runtime-provider independent and does not import db, queue, runtime provider, web, or TUI code.

## Files/modules changed

- `packages/config/package.json` — added config package metadata, exports, and package-local scripts.
- `packages/config/tsconfig.json` — added TypeScript config for config source.
- `packages/config/src/config.ts` — added typed config/env loading, `ConfigError`, `AUTH_MODE` validation, and deterministic test operator identity.
- `packages/config/src/index.ts` — added public source entrypoint exports.
- `packages/config/tests/config.test.ts` — added Bun tests for test auth mode, non-test missing env rejection, and non-test operator loading.
- `package.json` — added root `test` command scoped to new packages so existing TUI tests/workflows remain untouched.
- `tsconfig.json` — included config package source and workspace path aliases.
- `agent-docs/implementation-phases/state/00-repository-tooling-foundation.json` — marked `p0-003` complete and advanced `currentTaskId` to `p0-004`.

## Commands/checks run

- `rtk git status --short`
- `rtk node agent-docs/implementation-phases/tools/check-phase.mjs 00`
- `rtk bash agent-docs/implementation-phases/tools/run-one.sh 00 p0-003`
- `rtk bun run typecheck` — passed.
- `rtk bun run test` — passed.

## Acceptance criteria status

- `packages/config` exposes typed env/config loading: passed.
- `AUTH_MODE=test` is supported for deterministic test identity setup: passed.
- Config validation rejects missing required env in non-test mode: passed.
- Config package does not import db, queue, runtime provider, or web code: passed.

## Known gaps/follow-ups

- Non-test auth config currently validates placeholder operator identity fields only; concrete external auth integration is deferred to later auth-focused tasks.
- Root tests are intentionally scoped to `packages` to avoid running existing `v2/` TUI tests during the new web/sandbox MVP foundation checks.

## Next task

`p0-004` is dependency-unblocked and set as the next current task. Work was intentionally stopped before implementing it.
