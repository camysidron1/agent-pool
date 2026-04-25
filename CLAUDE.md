
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

`agent-pool` runs v2 (TypeScript/Bun), delegating to `v2/src/index.ts` via `bun`.

- SQLite database at `~/.agent-pool/data/agent-pool.db`

## Project Structure

```
agent-pool              # v2 wrapper — delegates to v2/src/index.ts via bun
v2/
  src/                  # TypeScript source (commands, services, stores, adapters, runner)
  tests/                # Unit and e2e tests — run with `cd v2 && bun test`
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

## How to Add a New Command

1. Create `v2/src/commands/foo.ts` with a `registerFooCommand()` function
2. Register it in `v2/src/app.ts`
3. Add the command to `registerHelpCommand()` in `v2/src/commands/help.ts`
4. Add tests in `v2/tests/`

## Running Tests

```bash
cd v2 && bun test                   # Run all v2 tests
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
