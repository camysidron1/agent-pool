
## Documentation Rules — IMPORTANT

NEVER create documentation, design docs, plans, reviews, or markdown files inside the repository tree.
ALL non-code documentation must go in one of these locations:

- `agent-docs/` — YOUR private workspace for this task (plans, todos, notes, reviews)
  Example: agent-docs/todo.md, agent-docs/implementation-plan.md
- `shared-docs/` — shared across all agents (lessons learned, architecture decisions)
  Example: shared-docs/lessons.md

These are symlinked to a persistent store outside the repo. They survive clone refreshes and are visible to the orchestrator.

Do NOT write .md files to paths like documentation/, docs/, design/, state/, etc. within the repo.
Code comments and inline docs in source files are fine — this rule is about standalone documentation files.

## Project Structure

```
agent-pool              # CLI entrypoint — thin dispatcher (~70 lines)
agent-runner.sh         # Task runner daemon (polls tasks, launches claude)
finish-task.sh          # Marks task status from inside a Claude session
lib/
  project.sh            # Project config: resolve, read/write, field accessors, auto_migrate
  pool.sh               # Clone pool: ensure, read/write, lock/unlock, create, stale cleanup
  tasks.sh              # Task queue: ensure, read/write, lock/unlock
  cmd/
    approvals.sh        # cmd_approvals, cmd_approve, cmd_deny, cmd_watch
    clone.sh            # cmd_refresh, cmd_release, cmd_destroy
    docs.sh             # cmd_docs
    help.sh             # cmd_help
    launch.sh           # cmd_init, cmd_launch, launch_grid, launch_here_all
    project.sh          # cmd_project (add/list/remove/default/tracking/workflow)
    restart.sh          # cmd_restart
    start.sh            # cmd_start (interactive guided setup)
    status.sh           # cmd_status
    tasks.sh            # cmd_add, cmd_tasks, cmd_unblock, cmd_backlog, cmd_activate, cmd_set_status
hooks/
  approval-hook.sh      # PreToolUse hook for permission approval queue
tests/
  helpers.sh            # Test infra: setup/teardown, assertions, run_test
  test_*.sh             # Per-module test files
  run-all.sh            # Test runner: ./tests/run-all.sh [test_foo.sh]
```

## Key Conventions

- **No shebang in lib/ files** — they are sourced, not executed directly
- **Source order matters**: `lib/project.sh` → `lib/pool.sh` → `lib/tasks.sh` → then `lib/cmd/*.sh` (any order)
- **Globals**: `TOOL_DIR`, `DATA_DIR`, `PROJECTS_JSON`, `RUNNER_SCRIPT`, `PROJECT` are set by the main `agent-pool` script before sourcing
- **No top-level code in lib files** — each file only defines functions
- **JSON handling**: embedded Python one-liners via `/usr/bin/python3`

## How to Add a New Command

1. Create `lib/cmd/foo.sh` with a `cmd_foo()` function
2. Add a `foo) cmd_foo "$@" ;;` case entry in the main `agent-pool` dispatch block
3. Add the command to `cmd_help()` in `lib/cmd/help.sh`
4. Add tests in `tests/test_foo.sh`

## Running Tests

```bash
./tests/run-all.sh                  # Run all tests
./tests/run-all.sh test_tasks.sh    # Run specific test file
```
