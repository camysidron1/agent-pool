# lib/cmd/help.sh — Help text

cmd_help() {
  cat <<'HELP'
agent-pool — manage a warm pool of isolated repo clones for parallel Claude sessions

Commands:
  project add <name>    Register a new project
                          --source PATH     Source git repository (required)
                          --branch BRANCH   Default branch (default: main)
                          --prefix PREFIX   Clone directory prefix (default: name)
                          --setup "CMD"     Post-clone setup command
  project list          List all registered projects
  project remove <name> Remove a project
  project default <name> Set the default project

  start                 Interactive guided setup: pick project, count, permissions,
                          tear down stale sessions, and launch agents
  init [n]              Create n warm clones (default: 4)
                          --launch     Also launch all clones in 2x2 grid(s) + driver
                          --here       Launch as splits in current workspace
                          --no-queue   Launch claude directly (skip task runner)
                          --no-driver  Skip the driver pane when launching grid
                          --env NAME   Inject env vars via nenv
                          --skip-permissions  Pass --dangerously-skip-permissions to claude
  launch [opts]         Launch agents (default: 4-agent grid + driver pane)
                          --panel      Single-agent panel mode (old default)
                          --here       Launch in current terminal (replaces shell)
                          --workspace  Open as new workspace tab instead
                          --no-queue   Launch claude directly (skip task runner)
                          --no-driver  Skip the driver pane in grid mode
                          --down       Split downward instead of right (panel mode)
                          --right      Split rightward (panel mode, default)
                          --env NAME   Inject env vars via nenv
                          --skip-permissions  Pass --dangerously-skip-permissions to claude
  status                Show all clones and their state

  Task Queue:
  add "<prompt>"        Add a pending task to the queue
                          --backlog              Add as backlogged instead
                          --depends-on id1,id2   Only run after listed tasks complete
  tasks                 List all tasks with status
  unblock <id>          Move blocked → pending
  backlog <id>          Move any → backlogged
  activate <id>         Move backlogged → pending
  set-status <id> <status>  Set task status (pending|in_progress|completed|blocked|backlogged)

  Approval Queue:
  approvals             List pending approval requests
  approve <id|--all>    Approve a pending request (or all)
  deny <id>             Deny a pending request
  watch [interval]      Watch for new approval requests in real-time (default: 2s)

  Documentation:
  docs                  List all agent doc directories with file counts
  docs <agent-id>       Show files and .md contents for an agent
  docs shared           Show shared documentation files

  Review:
  review                Dispatch a review agent to assess recent work quality
                          --commits N        Commits to review (default: 20)
                          --branches         Review open agent branches instead
                          --auto             Mark as auto-review (for cron use)

  Maintenance:
  refresh <n|--all>     Reset clone(s) to project branch, clean branches, run setup
  release <n>           Manually free a locked clone
  restart [n] [opts]    Kill and relaunch agent(s) in their current panels
                          n                   Restart only clone n (omit for all)
                          --here              Detect clone from cwd, restart in current shell
                          --skip-permissions  Pass --dangerously-skip-permissions to claude
                          --env NAME          Inject env vars via nenv
  destroy               Remove all clones for a project
  help                  Show this help

Global flags:
  -p, --project NAME    Specify which project to operate on
HELP
}
