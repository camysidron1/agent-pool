
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

## CLI Entrypoint

`agent-pool` now runs v2 (TypeScript/Bun). The v1 bash CLI is available as `agent-pool-v1`.

- v2 uses SQLite at `~/.agent-pool/data/agent-pool.db`
- Run `agent-pool migrate` to import v1 JSON data into SQLite
- The v1 runner (`agent-runner.sh`) still uses v1 JSON files directly

## Project Structure

```
agent-pool              # v2 wrapper — delegates to v2/src/index.ts via bun
agent-pool-v1           # v1 bash CLI (fallback)
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

## Task Dependencies

Tasks can declare dependencies on other tasks via `--depends-on`:

```bash
agent-pool add "Phase 1: extract interfaces"                     # → t-001
agent-pool add "Phase 1: write tests"                            # → t-002
agent-pool add --depends-on t-001,t-002 "Phase 2: implement"     # → t-003
agent-pool add --depends-on t-003 "Phase 3: migration guide"     # → t-004
```

- Agents skip pending tasks whose dependencies haven't completed
- `agent-pool tasks` shows `waiting (N)` for tasks with unmet deps
- Task JSON stores `depends_on: ["t-001", "t-002"]` (omitted when empty)
- Dependency IDs are validated at add time — unknown IDs are rejected

## Shipping Work — Push Branch + Create PR

Agents work on clones, not the main repo. **Every task that produces code changes must end with a PR.**

### For agents completing a task
1. **Commit** your changes on the clone's task branch
2. **Push** the branch to origin: `git push -u origin <branch-name>`
3. **Create a PR** to the project's base branch (usually `main`):
   ```bash
   gh pr create --title "Brief description" --body "What changed and why"
   ```
4. **Enable auto-merge** if the project workflow specifies it:
   ```bash
   gh pr merge --auto --squash
   ```
5. Run `/finish` to mark the task complete

### For the orchestrator
- When dispatching tasks, always include PR instructions in the prompt
- After tasks complete, check for open PRs: `gh pr list`
- For parallel tasks that may conflict, sequence the PRs or have the later agent rebase
- The `/finish` command already includes PR + auto-merge guidance — agents just need to follow it

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
./tests/run-all.sh                  # Run all tests (v1 bash)
./tests/run-all.sh test_tasks.sh    # Run specific test file (v1)
cd v2 && bun test                   # Run all v2 tests (236 tests)
```

## Project Memory & Documentation

Persistent project context lives in Claude Code's auto-memory system:

```
~/.claude/projects/-Users-camysidron--agent-pool/memory/
  MEMORY.md            # Project overview (auto-loaded every session)
  architecture.md      # v2 architecture, DI model, key types
  v2-status.md         # Phase tracking (what's done, what's next)
  research-index.md    # Index of all 36 docs in docs/
```

`MEMORY.md` is loaded into every conversation automatically. Check it first for project context before searching.
