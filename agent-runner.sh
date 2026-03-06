#!/usr/bin/env bash
set -euo pipefail

# Agent runner — polls tasks-<project>.json, claims pending tasks, runs claude -p
# Usage: agent-runner.sh <clone-index> [--project <name>] [env-name] [--skip-permissions]
#        agent-runner.sh --resolve-tasks-path --project <name>
#        agent-runner.sh --resolve-clone-path --project <name> --index <n>

TOOL_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-${POOL_DIR:-$HOME/.agent-pool}}"

PROJECTS_JSON="$DATA_DIR/projects.json"

# --- resolve helpers (can be called standalone for testing) ---

resolve_runner_project() {
  local proj="$1"
  if [[ -z "$proj" ]]; then
    # Fall back to default project
    proj=$(/usr/bin/python3 -c "
import json
with open('$PROJECTS_JSON') as f:
    data = json.load(f)
print(data.get('default', ''))
" 2>/dev/null || true)
  fi
  echo "$proj"
}

get_runner_project_field() {
  local proj="$1" field="$2"
  /usr/bin/python3 -c "
import json, sys
with open('$PROJECTS_JSON') as f:
    data = json.load(f)
p = data.get('projects', {}).get(sys.argv[1], {})
val = p.get(sys.argv[2], '')
print('' if val is None else val)
" "$proj" "$field" 2>/dev/null || true
}

# --- parse args ---

CLONE_INDEX=""
PROJECT_NAME=""
SKIP_PERMS=false
ENV_NAME=""
RESOLVE_MODE=""
RESOLVE_INDEX=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --project) PROJECT_NAME="$2"; shift 2 ;;
    --skip-permissions) SKIP_PERMS=true; shift ;;
    --resolve-tasks-path) RESOLVE_MODE="tasks"; shift ;;
    --resolve-clone-path) RESOLVE_MODE="clone"; shift ;;
    --index) RESOLVE_INDEX="$2"; shift 2 ;;
    [0-9]*) [[ -z "$CLONE_INDEX" ]] && CLONE_INDEX="$1"; shift ;;
    *) [[ -z "$ENV_NAME" ]] && ENV_NAME="$1"; shift ;;
  esac
done

PROJECT_NAME=$(resolve_runner_project "$PROJECT_NAME")

# Handle resolve modes (for testing)
if [[ "$RESOLVE_MODE" == "tasks" ]]; then
  echo "$DATA_DIR/tasks-${PROJECT_NAME}.json"
  exit 0
fi
if [[ "$RESOLVE_MODE" == "clone" ]]; then
  prefix=$(get_runner_project_field "$PROJECT_NAME" "prefix")
  printf '%s/%s-%02d\n' "$DATA_DIR" "$prefix" "$RESOLVE_INDEX"
  exit 0
fi

# Normal runner mode requires clone index
if [[ -z "$CLONE_INDEX" ]]; then
  echo "Usage: agent-runner.sh <clone-index> [--project <name>] [env-name] [--skip-permissions]" >&2
  exit 1
fi

# Derive paths from project config
PREFIX=$(get_runner_project_field "$PROJECT_NAME" "prefix")
BRANCH=$(get_runner_project_field "$PROJECT_NAME" "branch")
TASKS_JSON="$DATA_DIR/tasks-${PROJECT_NAME}.json"
LOCK_DIR="$TASKS_JSON.lock"
AGENT_ID="agent-$(printf '%02d' "$CLONE_INDEX")"
CLONE_PATH="$DATA_DIR/${PREFIX}-$(printf '%02d' "$CLONE_INDEX")"

# Rename the cmux tab title (no-op outside cmux)
rename_pane() {
  local title="$1"
  if [[ -n "${CMUX_SURFACE_ID:-}" ]]; then
    cmux rename-tab "$title" 2>/dev/null || true
  fi
}

# Build a short pane title from task id + first line of prompt
generate_pane_title() {
  local task_id="$1" prompt="$2"
  local first_line max_len=40
  first_line=$(echo "$prompt" | head -1 | sed 's/^[[:space:]]*//')
  if [[ ${#first_line} -gt $max_len ]]; then
    first_line="${first_line:0:$max_len}..."
  fi
  echo "${task_id}: ${first_line}"
}

poll_interval=3

# Reset clone to project's default branch (best-effort, never fails the loop)
reset_to_project_branch() {
  printf "\033[1;36m%s\033[0m resetting to %s...\n" "$AGENT_ID" "$BRANCH"
  cd "$CLONE_PATH"
  git fetch origin -q 2>/dev/null || true
  git checkout -B "$BRANCH" "origin/$BRANCH" -q 2>/dev/null || true
  git reset --hard "origin/$BRANCH" 2>/dev/null || true
}

acquire_lock() {
  local max_wait=50  # 5 seconds at 0.1s intervals
  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    sleep 0.1
    waited=$((waited + 1))
    if [[ $waited -ge $max_wait ]]; then
      return 1
    fi
  done
}

release_lock() {
  rm -rf "$LOCK_DIR"
}

claim_task() {
  acquire_lock || return 1
  local result
  result=$(/usr/bin/python3 -c "
import json, sys, time, os
with open('$TASKS_JSON', 'r') as f:
    data = json.load(f)
completed_ids = {t['id'] for t in data['tasks'] if t.get('status') == 'completed'}
waiting_count = 0
for t in data['tasks']:
    if t['status'] == 'pending':
        deps = t.get('depends_on', [])
        if deps:
            unmet = [d for d in deps if d not in completed_ids]
            if unmet:
                waiting_count += 1
                continue
        t['status'] = 'in_progress'
        t['claimed_by'] = '$AGENT_ID'
        t['started_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        tmp = '$TASKS_JSON' + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=2)
        os.rename(tmp, '$TASKS_JSON')
        print(t['id'] + '\n' + t['prompt'])
        sys.exit(0)
if waiting_count > 0:
    print(f'WAITING:{waiting_count}', file=sys.stderr)
sys.exit(1)
" 2>/dev/null) || { release_lock; return 1; }
  release_lock
  echo "$result"
}

mark_task() {
  local task_id=$1 new_status=$2
  acquire_lock || return 1
  /usr/bin/python3 -c "
import json, sys, time, os
with open('$TASKS_JSON', 'r') as f:
    data = json.load(f)
for t in data['tasks']:
    if t['id'] == sys.argv[1]:
        t['status'] = sys.argv[2]
        if sys.argv[2] in ('completed', 'blocked'):
            t['completed_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        if sys.argv[2] in ('pending', 'backlogged'):
            t['claimed_by'] = ''
            t.pop('started_at', None)
            t.pop('completed_at', None)
        break
tmp = '$TASKS_JSON' + '.tmp'
with open(tmp, 'w') as f:
    json.dump(data, f, indent=2)
os.rename(tmp, '$TASKS_JSON')
" "$task_id" "$new_status"
  release_lock
}

# Auto-release clone lock on exit (Ctrl+C, kill, normal exit)
CLONE_RELEASED=false
release_clone_lock() {
  [[ "$CLONE_RELEASED" == true ]] && return
  CLONE_RELEASED=true
  local pool_json="$DATA_DIR/pool-${PROJECT_NAME}.json"
  if [[ -f "$pool_json" ]]; then
    /usr/bin/python3 -c "
import json, sys, os
with open(sys.argv[1], 'r') as f:
    data = json.load(f)
idx = int(sys.argv[2])
for c in data['clones']:
    if c['index'] == idx:
        c['locked'] = False
        c['workspace_id'] = ''
        c['locked_at'] = ''
        break
tmp = sys.argv[1] + '.tmp'
with open(tmp, 'w') as f:
    json.dump(data, f, indent=2)
os.rename(tmp, sys.argv[1])
" "$pool_json" "$CLONE_INDEX" 2>/dev/null || true
    printf "\033[1;36m%s\033[0m released clone %02d\n" "$AGENT_ID" "$CLONE_INDEX" 2>/dev/null || true
  fi
}
trap release_clone_lock EXIT
trap 'release_clone_lock; exit 130' INT
trap 'release_clone_lock; exit 143' TERM

printf "\033[1;36m%s\033[0m ready — polling for tasks (project: %s)...\n" "$AGENT_ID" "$PROJECT_NAME"
rename_pane "$AGENT_ID: idle"

# Portable interruptible sleep
isleep() {
  sleep "$1"
}

last_waiting_msg=""
while true; do
  claim_stderr=$(mktemp)
  result=$(claim_task 2>"$claim_stderr") || {
    waiting_info=$(cat "$claim_stderr" 2>/dev/null)
    rm -f "$claim_stderr"
    if [[ "$waiting_info" == WAITING:* ]]; then
      n="${waiting_info#WAITING:}"
      msg="$n task(s) waiting on dependencies"
      if [[ "$msg" != "$last_waiting_msg" ]]; then
        printf "\033[1;36m%s\033[0m %s\n" "$AGENT_ID" "$msg"
        last_waiting_msg="$msg"
      fi
    else
      last_waiting_msg=""
    fi
    isleep "$poll_interval"
    continue
  }
  rm -f "$claim_stderr"
  last_waiting_msg=""

  task_id=$(echo "$result" | head -1)
  prompt=$(echo "$result" | tail -n +2)

  printf "\033[1;33m%s\033[0m claimed task %s\n" "$AGENT_ID" "$task_id"
  pane_title=$(generate_pane_title "$task_id" "$prompt")
  rename_pane "$pane_title"

  # Checkout fresh branch from project branch
  cd "$CLONE_PATH"

  # Ensure origin points to a real remote, not a local filesystem path
  origin_url=$(git remote get-url origin 2>/dev/null || true)
  if [[ "$origin_url" == /* ]]; then
    # Local path — fix it using the source repo's origin
    source_repo=$(get_runner_project_field "$PROJECT_NAME" "source")
    github_url=$(git -C "$source_repo" remote get-url origin 2>/dev/null || true)
    if [[ -n "$github_url" ]]; then
      git remote set-url origin "$github_url"
      printf "\033[1;33m%s\033[0m fixed origin remote: %s\n" "$AGENT_ID" "$github_url"
    fi
  fi

  git fetch origin -q 2>/dev/null || true
  local_branch="${AGENT_ID}-${task_id}"
  git checkout -B "$local_branch" "origin/$BRANCH" -q 2>/dev/null || git checkout -B "$local_branch" "$BRANCH" -q

  # Install approval hook (unless --skip-permissions)
  if [[ "$SKIP_PERMS" != true ]]; then
    settings_file="$CLONE_PATH/.claude/settings.json"
    mkdir -p "$(dirname "$settings_file")"
    hook_entry="{\"hooks\":{\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"${TOOL_DIR}/hooks/approval-hook.sh\",\"timeout\":310000}]}]}}"
    if [[ -f "$settings_file" ]]; then
      # Merge: add our hook entry to existing PreToolUse array (or create it)
      merged=$(jq --argjson entry "$hook_entry" '
        .hooks //= {} |
        .hooks.PreToolUse //= [] |
        # Remove any existing approval-hook entries to avoid duplicates
        .hooks.PreToolUse = [.hooks.PreToolUse[] | select(
          (.hooks // []) | all(.command | test("approval-hook\\.sh") | not)
        )] |
        .hooks.PreToolUse += $entry.hooks.PreToolUse
      ' "$settings_file") && echo "$merged" > "$settings_file"
    else
      echo "$hook_entry" | jq '.' > "$settings_file"
    fi
  fi

  # Set up centralized docs directories
  mkdir -p "$DATA_DIR/docs/agents/$AGENT_ID"
  mkdir -p "$DATA_DIR/docs/shared"

  # Symlink into clone for convenience (absolute paths)
  ln -sfn "$DATA_DIR/docs/agents/$AGENT_ID" "$CLONE_PATH/agent-docs"
  ln -sfn "$DATA_DIR/docs/shared" "$CLONE_PATH/shared-docs"

  # Ensure symlinks are in .gitignore
  for entry in agent-docs shared-docs CLAUDE.md; do
    if ! grep -qxF "$entry" "$CLONE_PATH/.gitignore" 2>/dev/null; then
      echo "$entry" >> "$CLONE_PATH/.gitignore"
    fi
  done

  # Install /finish command into clone
  mkdir -p "$CLONE_PATH/.claude/commands"
  cp "$TOOL_DIR/commands/finish.md" "$CLONE_PATH/.claude/commands/finish.md"
  if ! grep -qxF ".claude/commands/finish.md" "$CLONE_PATH/.gitignore" 2>/dev/null; then
    echo ".claude/commands/finish.md" >> "$CLONE_PATH/.gitignore"
  fi

  # Export context so /finish command can mark the task from inside the session
  export AGENT_POOL_TASK_ID="$task_id"
  export AGENT_POOL_PROJECT="$PROJECT_NAME"
  export AGENT_POOL_DATA_DIR="$DATA_DIR"
  export AGENT_POOL_TOOL_DIR="$TOOL_DIR"
  export AGENT_POOL_AGENT_ID="$AGENT_ID"

  # Append documentation rules to CLAUDE.md (idempotent)
  if ! grep -qF '## Documentation Rules' "$CLONE_PATH/CLAUDE.md" 2>/dev/null; then
    cat >> "$CLONE_PATH/CLAUDE.md" <<'DOCEOF'

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
DOCEOF
  fi

  # Build tracking context prefix for the prompt
  tracking_prefix=""
  tracking_json=$(get_runner_project_field "$PROJECT_NAME" "tracking")

  if [[ -n "$tracking_json" && "$tracking_json" != "None" && "$tracking_json" != "null" && "$tracking_json" != "" ]]; then
    tracking_prefix=$(/usr/bin/python3 -c "
import json, sys
with open('$PROJECTS_JSON') as f:
    data = json.load(f)
tracking = data.get('projects', {}).get(sys.argv[1], {}).get('tracking')
if tracking and tracking.get('type'):
    t = tracking['type'].upper()
    key = tracking.get('project_key', '')
    label = tracking.get('label', '')
    instructions = tracking.get('instructions', '')
    lines = [f'[PROJECT TRACKING — {t}]']
    lines.append(f'This project uses {t} for issue tracking (project: {key}' + (f', label: {label}' if label else '') + ').')
    lines.append('- Search for existing tickets before creating new ones')
    lines.append('- Use appropriate CLI commands for ticket operations')
    lines.append(f'- Prefix commit messages with the ticket key (e.g. {key}-123: ...)')
    if instructions:
        lines.append(instructions)
    lines.append('---')
    print(chr(10).join(lines))
" "$PROJECT_NAME" 2>/dev/null || true)
  else
    tracking_prefix="[PROJECT TRACKING — NONE]
This project does NOT use issue tracking. Do NOT create, search, or reference Jira tickets or any other tracking system.
---"
  fi

  # Build git workflow context for the prompt
  workflow_prefix=""
  workflow_json=$(get_runner_project_field "$PROJECT_NAME" "git_workflow")

  if [[ -n "$workflow_json" && "$workflow_json" != "None" && "$workflow_json" != "null" && "$workflow_json" != "" ]]; then
    workflow_prefix=$(/usr/bin/python3 -c "
import json, sys
with open('$PROJECTS_JSON') as f:
    data = json.load(f)
gw = data.get('projects', {}).get(sys.argv[1], {}).get('git_workflow')
if gw and gw.get('type'):
    t = gw['type'].upper()
    instructions = gw.get('instructions', '')
    lines = [f'[GIT WORKFLOW — {t}]']
    if instructions:
        lines.append(instructions)
    lines.append('---')
    print(chr(10).join(lines))
" "$PROJECT_NAME" 2>/dev/null || true)
  else
    workflow_prefix="[GIT WORKFLOW]
Commit your changes with a descriptive message when your task is complete. Do not create PRs or merge unless specifically asked in the task prompt.
---"
  fi

  # Prepend tracking and workflow context to prompt
  context_prefix=""
  if [[ -n "$tracking_prefix" ]]; then
    context_prefix="${tracking_prefix}
"
  fi
  if [[ -n "$workflow_prefix" ]]; then
    context_prefix="${context_prefix}${workflow_prefix}
"
  fi
  if [[ -n "$context_prefix" ]]; then
    prompt="${context_prefix}${prompt}"
  fi

  # Run claude interactively with the task prompt
  claude_args=("$prompt")
  [[ "$SKIP_PERMS" == true ]] && claude_args+=(--dangerously-skip-permissions)

  set +e
  if [[ -n "$ENV_NAME" ]]; then
    ENV="$ENV_NAME" nenv claude "${claude_args[@]}"
  else
    claude "${claude_args[@]}"
  fi
  exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    mark_task "$task_id" "completed"
    printf "\033[1;32m%s\033[0m completed task %s\n" "$AGENT_ID" "$task_id"
  else
    printf "\n\033[1;33m%s\033[0m exited with code %d on task %s\n" "$AGENT_ID" "$exit_code" "$task_id"
    printf "  Mark task as:\n"
    printf "  \033[1mc\033[0m) completed   \033[1mb\033[0m) blocked   \033[1mp\033[0m) pending (retry)   \033[1mk\033[0m) backlogged\n"
    printf "  > "
    choice=""
    read -r choice </dev/tty 2>/dev/null || choice="b"
    case "$choice" in
      c|completed)
        mark_task "$task_id" "completed"
        printf "\033[1;32m%s\033[0m marked task %s as completed\n" "$AGENT_ID" "$task_id"
        ;;
      p|pending)
        mark_task "$task_id" "pending"
        printf "\033[1;36m%s\033[0m returned task %s to pending (will be retried)\n" "$AGENT_ID" "$task_id"
        ;;
      k|backlog|backlogged)
        mark_task "$task_id" "backlogged"
        printf "\033[1;35m%s\033[0m backlogged task %s\n" "$AGENT_ID" "$task_id"
        ;;
      *)
        mark_task "$task_id" "blocked"
        printf "\033[1;31m%s\033[0m blocked on task %s\n" "$AGENT_ID" "$task_id"
        ;;
    esac
  fi

  reset_to_project_branch

  printf "\033[1;36m%s\033[0m polling for next task...\n" "$AGENT_ID"
  rename_pane "$AGENT_ID: idle"
done
