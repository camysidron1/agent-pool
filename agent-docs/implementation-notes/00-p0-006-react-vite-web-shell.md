# Phase 00 p0-006: Add React/Vite web shell

## Summary

Added a minimal browser-only React/Vite web shell under `apps/web` and wired the root TypeScript project to typecheck the new web source.

## Files/modules changed

- `apps/web/package.json` — web workspace package metadata, scripts, and React/Vite dependencies.
- `apps/web/tsconfig.json` — web TypeScript configuration.
- `apps/web/index.html` — Vite HTML entrypoint.
- `apps/web/vite.config.ts` — minimal Vite React plugin configuration.
- `apps/web/src/App.tsx` — placeholder shell UI importing browser-safe shared task constants/types.
- `apps/web/src/main.tsx` — React root mount.
- `apps/web/src/styles.css` — minimal shell styling.
- `apps/web/src/vite-env.d.ts` — local type declarations for the shell while dependencies are not installed by this task.
- `apps/web/src/index.ts` — package source export.
- `tsconfig.json` — root typecheck includes web TS/TSX sources and DOM/JSX compiler options.
- `agent-docs/implementation-phases/state/00-repository-tooling-foundation.json` — marked p0-006 completed and advanced to p0-007.

## Commands/checks run

- `rtk node agent-docs/implementation-phases/tools/check-phase.mjs 00`
- `rtk bash agent-docs/implementation-phases/tools/run-one.sh 00 p0-006`
- `rtk bun run typecheck`

## Acceptance criteria status

- ✅ `apps/web` exists with a minimal React/Vite shell.
- ✅ Web shell imports browser-safe shared types/constants from `@agent-pool/shared`.
- ✅ Web shell does not import db, queue, runtime providers, or backend-only auth code.

## Known gaps/follow-ups

- The shell is intentionally static; product APIs, Kanban behavior, and backend integration are later-phase work.
- Local type shims keep Phase 0 typecheck deterministic before dependency-install tasks update the lockfile.

## Next task

p0-007 is unblocked.
