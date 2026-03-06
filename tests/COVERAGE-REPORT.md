# Test Coverage Report — agent-pool

**Generated**: 2026-03-05 (final)
**Total tests**: 191 passing across 14 test files

---

## Executive Summary

The test suite provides **191 passing tests** across 14 test files, up from ~80 tests across 11 files at the start. All P0 critical gaps have been closed and nearly all P1 gaps addressed.

### What was done

- **5 new test files created**: `test_finish.sh` (10), `test_launch.sh` (12), `test_restart.sh` (12), `test_status.sh` (7), `test_start.sh` (6)
- **8 existing files expanded**: `test_runner.sh` (+6), `test_project.sh` (+15), `test_pool.sh` (+9), `test_tasks.sh` (+10), `test_approvals.sh` (+8), `test_clone.sh` (+4), `test_docs.sh` (+5), `test_integration.sh` (+2), `test_static.sh` (+1)
- **Infrastructure**: `assert_json_array_length()` helper added to `helpers.sh`

### Coverage Heatmap

| Module | Coverage | Notes |
|--------|----------|-------|
| `lib/tasks.sh` | **High** | Core operations well-tested |
| `lib/pool.sh` | **High** | Lock/unlock, next_index, add/remove entry, cleanup, ensure, get_clone_path |
| `lib/project.sh` | **High** | CRUD + tracking + workflow + edge cases |
| `lib/cmd/tasks.sh` | **High** | add, list, unblock, backlog, activate, deps, set-status, empty list |
| `lib/cmd/approvals.sh` | **High** | approve, deny, list, notify.log, age format, agent detection |
| `lib/cmd/clone.sh` | **High** | refresh (cleans branches, runs setup, preserves pool), release, destroy |
| `lib/cmd/docs.sh` | **High** | All modes: empty, non-md, multiple agents, shared empty/missing |
| `lib/cmd/project.sh` | **High** | CRUD + tracking/workflow CRUD + edge cases + nonexistent + no-subcommand |
| `lib/cmd/launch.sh` | **Medium** | Init paths tested; cmux grid/panel paths need mocking |
| `lib/cmd/restart.sh` | **Medium** | Error paths + regex detection + refresh + grouping; cmux paths need mocking |
| `lib/cmd/start.sh` | **Medium** | Teardown, stale cleanup, pool reset, task count, live lock preservation |
| `lib/cmd/status.sh` | **High** | Headers, branch, workspace, multi-clone, empty pool |
| `lib/cmd/help.sh` | **Medium** | Dispatch consistency verified in static tests |
| `agent-runner.sh` | **High** | Task claiming (with deps), context building, signal files, hook install |
| `finish-task.sh` | **High** | All statuses, validation, signal files, edge cases |
| `hooks/approval-hook.sh` | **High** | Allowlist, blocking, truncation, notify, age format |
| `agent-pool` (entrypoint) | **Medium** | Flag parsing, dispatch consistency, tilde expansion, auto_migrate |

---

## Remaining Gaps

### cmux-dependent paths (P2 — requires mocking infrastructure)

These are the primary remaining untested paths. They require a cmux mock to test:

- `launch_grid()` / `launch_here_all()` — grid layout, surface splitting, workspace creation
- `_restart_single()` / `_restart_all()` — Ctrl+C sending, TTY-based surface detection
- `cmd_start()` — interactive guided setup (TTY reads)
- `_kill_claude_in_clone()` — process detection by clone path

### Minor gaps (P2)

- `acquire_task_lock()` timeout when lock held by live process
- `create_clone()` origin remote URL fix (local → github)
- Source ordering static verification in entrypoint
- Polling loop in approval hook (300s timeout)

---

## Test File Summary

| File | Tests | Coverage |
|------|-------|----------|
| `test_approvals.sh` | 22 | approve, deny, list, allowlist, blocking, truncation, notify, age |
| `test_clone.sh` | 18 | refresh, release, destroy, agent branch cleanup, setup, pool preservation |
| `test_docs.sh` | 10 | all agent/shared doc modes |
| `test_finish.sh` | 10 | all statuses, validation, signal files, missing env/task |
| `test_integration.sh` | 13 | multi-project isolation, flag parsing, tilde expansion, auto_migrate |
| `test_launch.sh` | 12 | init count/branch/setup/additive/skip/unlock, launch options |
| `test_pool.sh` | 12 | lock, find_free, next_index, add/remove entry, unlock, stale cleanup, ensure, get_path |
| `test_project.sh` | 22 | CRUD, tracking, workflow, defaults, edge cases, nonexistent |
| `test_restart.sh` | 12 | options, regex detection, refresh, fallback, grouping |
| `test_runner.sh` | 20 | claiming, marking, deps, context, signal files, hooks, gitignore |
| `test_start.sh` | 6 | teardown, stale cleanup, pool reset, task count, live locks |
| `test_static.sh` | 2 | no top-level `local`, help/dispatch consistency |
| `test_status.sh` | 7 | headers, branch, workspace, multi-clone, empty pool |
| `test_tasks.sh` | 25 | add, list, unblock, backlog, activate, set-status, deps, empty |
| **Total** | **191** | |
