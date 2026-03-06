# Test Coverage Report — agent-pool

**Generated**: 2026-03-05
**Scope**: All source files vs all test files in the agent-pool repository

---

## Executive Summary

The test suite covers **core data operations well** (task CRUD, pool locking, project config, approval queue) but has **significant gaps** in command-level testing. Of the 10 command files in `lib/cmd/`, only 5 have dedicated test files. The most complex commands — `launch`, `restart`, `start`, and `status` — have minimal or no unit tests despite containing the most branching logic.

### Coverage Heatmap

| Module | Coverage | Notes |
|--------|----------|-------|
| `lib/tasks.sh` | **High** | Core operations well-tested |
| `lib/pool.sh` | **Medium** | Lock/unlock tested; creation, cleanup untested |
| `lib/project.sh` | **Medium** | CRUD tested; migration, edge cases gaps |
| `lib/cmd/tasks.sh` | **High** | add, list, unblock, backlog, activate tested |
| `lib/cmd/approvals.sh` | **High** | approve, deny, list tested; `watch` untested |
| `lib/cmd/clone.sh` | **High** | init, refresh, release, destroy tested |
| `lib/cmd/docs.sh` | **High** | All modes tested |
| `lib/cmd/project.sh` | **Medium** | CRUD tested; tracking/workflow untested |
| `lib/cmd/launch.sh` | **None** | Zero test coverage |
| `lib/cmd/restart.sh` | **None** | Zero test coverage |
| `lib/cmd/start.sh` | **None** | Zero test coverage |
| `lib/cmd/status.sh` | **Low** | Basic locked/free in integration tests only |
| `lib/cmd/help.sh` | **None** | No dedicated tests |
| `agent-runner.sh` | **Medium** | Task claiming/marking tested; main loop, clone setup, context building untested |
| `finish-task.sh` | **None** | Zero test coverage |
| `hooks/approval-hook.sh` | **High** | Allowlist, blocking, truncation tested |
| `agent-pool` (entrypoint) | **Low** | Flag parsing tested indirectly; dispatch not tested |

---

## Detailed Gap Analysis by Module

### 1. `lib/cmd/launch.sh` — P0: CRITICAL

**No test file exists.** This is the most complex command module (4 functions, ~250 lines) handling clone initialization, grid layout, cmux workspace management, and process launching.

| Function | Untested Behavior | Recommended Test |
|----------|-------------------|-----------------|
| `cmd_init()` | `--launch` flag triggers launch after init | Test that `--launch` calls launch functions |
| `cmd_init()` | `--no-queue` mode (direct claude, no runner) | Test branch creation and command building |
| `cmd_init()` | `--env NAME` passthrough | Test env variable appears in launched command |
| `cmd_init()` | Additive init (existing clones not recreated) | Partially covered in test_clone.sh — verify pool JSON correctness |
| `launch_grid()` | Grid layout: 4 panes in 2x2 + optional driver | Test cmux command sequence (can mock cmux) |
| `launch_grid()` | Clone locking with workspace UUID | Test pool JSON updated with workspace_id |
| `launch_grid()` | `--no-driver` omits driver pane | Test surface count without driver |
| `launch_here_all()` | Split pattern for 1-4+ agents | Test surface splitting sequence |
| `launch_here_all()` | Fallback surface ID when extraction fails | Test with missing surface_ref |
| `cmd_launch()` | `--grid` vs `--panel` vs `--workspace` vs `--here` modes | Test each mode selects correct path |
| `cmd_launch()` | Free clone collection + temp locking | Test concurrent clone allocation |

**Recommendation**: Create `tests/test_launch.sh`. Mock `cmux` commands (replace with stub that records calls) to test command building, clone selection, and pool state changes without requiring a real terminal multiplexer.

---

### 2. `lib/cmd/restart.sh` — P0: CRITICAL

**No test file exists.** Contains 5 functions handling process killing, clone refresh, cmux pane detection, and TTY matching — all with complex fallback paths.

| Function | Untested Behavior | Recommended Test |
|----------|-------------------|-----------------|
| `_kill_claude_in_clone()` | Process detection by clone path | Test with mock `ps` output |
| `_restart_here()` | Clone index detection from `$PWD` regex | Test regex extraction from various path formats |
| `_restart_here()` | Error when PWD doesn't match pattern | Test exits with error |
| `_restart_single()` | Pane index calculation from sorted clone list | Test index mapping with multiple clones |
| `_restart_single()` | Ctrl+C sending + command injection to surface | Test cmux command sequence |
| `_restart_single()` | Fallback when pane not found | Test manual command output |
| `_restart_all()` | TTY-based surface detection for clones without workspace | Test TTY matching logic |
| `_restart_all()` | Grouping by workspace_id | Test grouping with mixed workspace types |
| `_restart_all()` | Marker file cleanup | Test cleanup on success and failure |

**Recommendation**: Create `tests/test_restart.sh`. The TTY-matching logic in `_restart_all()` is particularly fragile and deserves thorough testing. Mock `cmux` and `ps` to test detection logic.

---

### 3. `finish-task.sh` — P0: CRITICAL

**No test file exists.** This script runs inside Claude sessions to mark tasks complete. Bugs here cause agents to silently fail to update task status.

| Behavior | Recommended Test |
|----------|-----------------|
| Environment validation (missing AGENT_POOL_TASK_ID) | Test exits with error when env vars missing |
| Status validation (invalid status string) | Test rejects "foo", accepts "completed", "blocked", "pending", "backlogged" |
| Lock acquisition timeout | Test exits when lock can't be acquired |
| Task status update (completed) | Test sets status + completed_at timestamp |
| Task status update (pending) | Test clears claimed_by, started_at, completed_at |
| Signal file creation | Test `.task-finished-${TASK_ID}` file written with correct content |
| Task not found in JSON | Test handles missing task gracefully |

**Recommendation**: Create `tests/test_finish.sh`. These are straightforward unit tests — set up task JSON, run finish-task.sh with environment variables, verify JSON mutation.

---

### 4. `lib/cmd/start.sh` — P1: IMPORTANT

**No test file exists.** Interactive guided setup with 7+ steps. Hard to test end-to-end due to `/dev/tty` reads, but individual steps can be validated.

| Behavior | Untested | Recommended Test |
|----------|----------|-----------------|
| Session teardown | Ctrl+C sending, surface closing, unlock sequence | Test pool state after teardown (mocked cmux) |
| Stale lock cleanup | Dead PID detection and lock removal | Test with fake lock dir + dead PID |
| Pool reset | Clone directory deletion + JSON reset | Test filesystem + JSON state |
| Pane closing | Current surface preservation | Test cmux command sequence |
| Task count display | Pending task counting for startup message | Test count with various task states |

**Recommendation**: Create `tests/test_start.sh`. Focus on the non-interactive parts (teardown, cleanup, pool reset) that can be tested without TTY input.

---

### 5. `agent-runner.sh` — P1: IMPORTANT (expand existing tests)

`test_runner.sh` covers task claiming/marking and hook installation, but the main execution loop and several functions are untested.

| Function/Behavior | Untested | Priority | Recommended Test |
|-------------------|----------|----------|-----------------|
| `resolve_runner_project()` | Fallback to default project | P1 | Test with no arg + default set |
| `get_runner_project_field()` | Field extraction, null handling | P1 | Test with various field types |
| `reset_to_project_branch()` | Git fetch + checkout + reset sequence | P2 | Test git state after reset |
| `acquire_lock()` / `release_lock()` | Timeout behavior, concurrent access | P1 | Test timeout returns error |
| `claim_task()` | Dependency checking (skip tasks with unmet deps) | P0 | Test with dependent tasks |
| `claim_task()` | WAITING:N stderr output | P1 | Test stderr message format |
| Post-claude exit handling | Exit 0 → auto-complete, non-zero → interactive prompt | P1 | Test status transitions on various exit codes |
| Tracking context building | LINEAR/JIRA context injection | P1 | Test prompt contains tracking instructions |
| Workflow context building | Git workflow instructions in prompt | P1 | Test prompt contains workflow instructions |
| Clone setup | Branch creation, origin fix, symlinks, .gitignore | P2 | Test filesystem state after setup |
| Signal file detection | `.task-finished-*` skips post-exit handling | P1 | Test with signal file present |

**Recommendation**: Add tests to existing `tests/test_runner.sh`. Priority is dependency-aware task claiming (P0) and context building (P1).

---

### 6. `lib/cmd/project.sh` — P1: IMPORTANT (expand existing tests)

`test_project.sh` covers basic CRUD but misses tracking and workflow configuration.

| Function | Untested | Priority | Recommended Test |
|----------|----------|----------|-----------------|
| `set-tracking` | Setting LINEAR/JIRA tracking config | P1 | Test tracking fields in projects.json |
| `clear-tracking` | Removing tracking config | P1 | Test tracking becomes null |
| `set-workflow` | Setting git workflow config | P1 | Test workflow fields in projects.json |
| `clear-workflow` | Removing workflow config | P1 | Test workflow becomes null |
| `set-tracking` | Missing `--type` or `--key` validation | P1 | Test exits with usage error |
| `set-workflow` | Missing `--type` or `--instructions` validation | P1 | Test exits with usage error |
| `add` | Duplicate project name | P2 | Test behavior with existing name |
| `remove` | Removing default project clears default | P1 | Test default field after removal |
| `add` | First project auto-becomes default | P1 | Test default set on first add |

**Recommendation**: Add tests to existing `tests/test_project.sh`.

---

### 7. `lib/cmd/status.sh` — P1: IMPORTANT (expand coverage)

Only tested indirectly via `test_integration.sh` (locked/free display). No dedicated test file.

| Behavior | Untested | Recommended Test |
|----------|----------|-----------------|
| Branch detection from git | Shows current branch per clone | Test with clones on different branches |
| Branch fallback to pool JSON | When git fails, shows pool branch | Test with missing clone dir |
| Stale lock cleanup trigger | `cleanup_stale_locks` called on status | Test stale lock cleaned |
| Empty pool display | "(no clones)" message | Covered in integration test |
| Workspace ID display | Shows workspace_id or "-" | Test with mixed workspace states |
| Table formatting | Column alignment | Test output format |

**Recommendation**: Add status-specific tests to `tests/test_integration.sh` or create `tests/test_status.sh`.

---

### 8. `lib/pool.sh` — P1: IMPORTANT (expand existing tests)

`test_pool.sh` only tests lock_clone, find_free_clone. Many functions untested.

| Function | Untested | Priority | Recommended Test |
|----------|----------|----------|-----------------|
| `ensure_pool_json()` | Creates file when missing | P2 | Test file creation |
| `next_index()` | Returns max index or -1 | P1 | Test with empty pool, 0-indexed, gaps |
| `add_clone_entry()` | Adds entry, sorts by index | P1 | Test ordering after add |
| `remove_clone_entry()` | Filters out entry by index | P1 | Test remaining entries correct |
| `create_clone()` | Full clone creation (git clone, symlinks, setup) | P1 | Test filesystem state after creation |
| `create_clone()` | Origin remote fix (local path → github) | P2 | Test remote URL after creation |
| `create_clone()` | Setup command execution | P2 | Test marker file from setup |
| `cleanup_stale_locks()` | Unlocks clones with dead workspaces | P1 | Test with mock cmux output |
| `unlock_clone()` | Clears lock fields | P2 | Test JSON state after unlock |

**Recommendation**: Expand `tests/test_pool.sh` with unit tests for `next_index`, `add_clone_entry`, `remove_clone_entry`, and `cleanup_stale_locks`.

---

### 9. `lib/tasks.sh` — P2: NICE-TO-HAVE (expand)

Core read/write/ensure tested indirectly. Locking tested in `test_tasks.sh`.

| Function | Untested | Priority | Recommended Test |
|----------|----------|----------|-----------------|
| `acquire_task_lock()` | Stale lock detection by dead PID | P1 | Already tested in test_tasks.sh (test_task_lock_stale_detection) |
| `acquire_task_lock()` | Timeout when lock held by live process | P2 | Test returns non-zero after timeout |
| `release_task_lock()` | Cleanup after release | P2 | Test lock dir removed |

---

### 10. `lib/cmd/help.sh` — P2: NICE-TO-HAVE

| Behavior | Recommended Test |
|----------|-----------------|
| All commands listed in help output | Grep help output for each command name |
| Help output matches actual dispatch table | Cross-reference help text with agent-pool case statement |

**Recommendation**: Add a static test in `tests/test_static.sh` that verifies every command in the dispatch table appears in help output.

---

### 11. `agent-pool` (entrypoint) — P2: NICE-TO-HAVE

| Behavior | Untested | Recommended Test |
|----------|----------|-----------------|
| `-p` flag before command | Covered in test_integration.sh |
| `-p` flag after command | Covered in test_integration.sh |
| Unknown command exits 1 + shows help | Covered in test_integration.sh |
| `auto_migrate()` called on every invocation | Covered in test_integration.sh |
| Source ordering (project → pool → tasks → cmd) | P2 | Static test verifying source order |

---

### 12. `hooks/approval-hook.sh` — P2: EXPAND

Well-tested. Minor gaps:

| Behavior | Untested | Recommended Test |
|----------|----------|-----------------|
| Polling loop (300s timeout) | Approval after delay | P2 — hard to test without long waits |
| Denial during polling | Status=denied mid-poll | P2 — test with background approval |
| Request file cleanup after decision | File removed | P1 | Test file doesn't exist after approve/deny |
| Notification (osascript) | Desktop notification fires | P2 — platform-specific, skip |
| `.notify.log` append | Log entry written | P1 | Test log contains request entry |

---

## Recommendations for New Test Files

### Priority Order

1. **`tests/test_finish.sh`** — P0. Simple to write, high impact. `finish-task.sh` is used by every agent session.
2. **`tests/test_launch.sh`** — P0. Most complex untested module. Requires cmux mocking.
3. **`tests/test_restart.sh`** — P0. Complex detection logic with many failure modes.
4. **`tests/test_start.sh`** — P1. Test non-interactive portions (teardown, cleanup).
5. **`tests/test_status.sh`** — P1. Straightforward to test (no cmux dependency for display).

### Additions to Existing Test Files

1. **`tests/test_runner.sh`** — Add dependency-aware claiming (P0), context building (P1), signal file detection (P1)
2. **`tests/test_project.sh`** — Add tracking/workflow CRUD (P1), first-project-default (P1), remove-default (P1)
3. **`tests/test_pool.sh`** — Add next_index, add/remove_clone_entry, cleanup_stale_locks (P1)
4. **`tests/test_approvals.sh`** — Add `.notify.log` check, request file cleanup (P1)
5. **`tests/test_static.sh`** — Add help/dispatch consistency check (P2)

---

## Test Infrastructure Recommendations

### 1. cmux Mocking (P0 for launch/restart tests)

The biggest testing barrier is `cmux` dependency. Create a mock:

```bash
# tests/mocks/cmux — stub that records calls
#!/bin/bash
echo "$@" >> "$TEST_DIR/cmux_calls.log"
case "$1 $2" in
  "new-workspace"*) echo '{"surface_ref":"mock-surface-1"}' ;;
  "new-split"*)     echo '{"surface_ref":"mock-surface-2"}' ;;
  "list-surfaces"*) echo '[{"ref":"mock-surface-1"},{"ref":"mock-surface-2"}]' ;;
  "list-workspaces"*) echo '[]' ;;
  "identify"*)      echo '{"surface_ref":"mock-surface-0"}' ;;
  *)                echo '{}' ;;
esac
```

Add to test setup: `export PATH="$TEST_DIR/mocks:$PATH"`

### 2. Process Mocking (P1 for restart tests)

For `_kill_claude_in_clone()`, mock `ps` output:

```bash
# tests/mocks/ps
echo "  PID TTY TIME CMD"
echo "12345 ?? 0:01 claude --some-flag /path/to/clone"
```

### 3. Helper: `assert_json_array_length()` (P2)

Several tests would benefit from asserting array lengths in JSON:

```bash
assert_json_array_length() {
  local file="$1" key="$2" expected="$3" msg="$4"
  local actual
  actual=$(/usr/bin/python3 -c "
import json, sys
data = json.load(open('$file'))
print(len(data.get('$key', [])))
")
  assert_eq "$actual" "$expected" "$msg"
}
```

### 4. Helper: `create_mock_pool()` (P2)

Many tests manually construct pool JSON. A helper would reduce boilerplate:

```bash
create_mock_pool() {
  local pool_file="$1" count="$2" prefix="$3"
  # Creates pool with N clones, all unlocked
}
```

### 5. Parallel Test Execution (P2)

`run-all.sh` sources test files sequentially. For faster CI, consider running test files in parallel subshells since each uses isolated `$TEST_DIR`.

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Source functions total | ~55 |
| Functions with test coverage | ~30 |
| Functions without any test coverage | ~25 |
| P0 gaps (critical) | 3 modules (launch, restart, finish-task) |
| P1 gaps (important) | 5 modules (start, status, runner expansion, project expansion, pool expansion) |
| P2 gaps (nice-to-have) | 3 modules (help, entrypoint, tasks lib) |
| New test files recommended | 5 |
| Existing test file expansions | 5 |
