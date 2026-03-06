# lib/cmd/tasks.sh — Task queue commands

cmd_add() {
  local status="pending" prompt="" depends_on=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --backlog) status="backlogged"; shift ;;
      --depends-on) depends_on="$2"; shift 2 ;;
      *) prompt="$1"; shift ;;
    esac
  done
  if [[ -z "$prompt" ]]; then
    echo "Usage: agent-pool add [--backlog] [--depends-on id1,id2,...] \"<prompt>\""
    exit 1
  fi

  local proj
  proj=$(resolve_project)
  local tasks_file
  tasks_file=$(get_tasks_json_path "$proj")

  ensure_tasks_json "$tasks_file"
  acquire_task_lock "$tasks_file"
  read_tasks "$tasks_file" | /usr/bin/python3 -c "
import json, sys, time
data = json.load(sys.stdin)
deps_str = sys.argv[3]
deps = [d.strip() for d in deps_str.split(',') if d.strip()] if deps_str else []
if deps:
    existing_ids = {t['id'] for t in data['tasks']}
    missing = [d for d in deps if d not in existing_ids]
    if missing:
        print(f\"Error: unknown task IDs in --depends-on: {', '.join(missing)}\", file=sys.stderr)
        sys.exit(1)
task = {
    'id': 't-' + str(int(time.time())),
    'prompt': sys.argv[1],
    'status': sys.argv[2],
    'claimed_by': None,
    'created_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
    'started_at': None,
    'completed_at': None
}
if deps:
    task['depends_on'] = deps
data['tasks'].append(task)
json.dump(data, sys.stdout, indent=2)
dep_info = f' (depends on: {\", \".join(deps)})' if deps else ''
print(f\"Added task {task['id']} ({task['status']}){dep_info}\", file=sys.stderr)
" "$prompt" "$status" "$depends_on" | write_tasks "$tasks_file"
  release_task_lock "$tasks_file"
}

cmd_tasks() {
  local proj
  proj=$(resolve_project)
  local tasks_file
  tasks_file=$(get_tasks_json_path "$proj")

  ensure_tasks_json "$tasks_file"
  read_tasks "$tasks_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
if not data['tasks']:
    print('  (no tasks)')
    sys.exit(0)
colors = {
    'pending': '\033[33m',
    'in_progress': '\033[36m',
    'completed': '\033[32m',
    'blocked': '\033[31m',
    'backlogged': '\033[90m',
}
reset = '\033[0m'
print(f\"{'ID':<18} {'Status':<14} {'Claimed By':<12} {'Prompt'}\")
print(f\"{'--':<18} {'------':<14} {'----------':<12} {'------'}\")
completed_ids = {t['id'] for t in data['tasks'] if t.get('status') == 'completed'}
for t in data['tasks']:
    s = t['status']
    deps = t.get('depends_on', [])
    if deps and s == 'pending':
        unmet = [d for d in deps if d not in completed_ids]
        if unmet:
            s_display = f'waiting ({len(unmet)})'
            color = '\033[90m'
        else:
            s_display = s
            color = colors.get(s, '')
    else:
        s_display = s
        color = colors.get(s, '')
    claimed = t.get('claimed_by') or '-'
    prompt = t['prompt'][:60] + ('...' if len(t['prompt']) > 60 else '')
    suffix = ''
    if deps:
        dep_str = ','.join(deps)
        suffix = f'  [deps: {dep_str}]'
    print(f\"{t['id']:<18} {color}{s_display:<14}{reset} {claimed:<12} {prompt}{suffix}\")
"
}

cmd_unblock() {
  local task_id="${1:-}"
  if [[ -z "$task_id" ]]; then
    echo "Usage: agent-pool unblock <task-id>"
    exit 1
  fi
  local proj
  proj=$(resolve_project)
  local tasks_file
  tasks_file=$(get_tasks_json_path "$proj")

  ensure_tasks_json "$tasks_file"
  acquire_task_lock "$tasks_file"
  read_tasks "$tasks_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
tid = sys.argv[1]
found = False
for t in data['tasks']:
    if t['id'] == tid:
        if t['status'] != 'blocked':
            print(f\"Task {tid} is {t['status']}, not blocked.\", file=sys.stderr)
            sys.exit(1)
        t['status'] = 'pending'
        t['claimed_by'] = None
        t['started_at'] = None
        t['completed_at'] = None
        found = True
        print(f'Unblocked {tid} → pending', file=sys.stderr)
        break
if not found:
    print(f'Task {tid} not found', file=sys.stderr)
    sys.exit(1)
json.dump(data, sys.stdout, indent=2)
" "$task_id" | write_tasks "$tasks_file"
  release_task_lock "$tasks_file"
}

cmd_backlog() {
  local task_id="${1:-}"
  if [[ -z "$task_id" ]]; then
    echo "Usage: agent-pool backlog <task-id>"
    exit 1
  fi
  local proj
  proj=$(resolve_project)
  local tasks_file
  tasks_file=$(get_tasks_json_path "$proj")

  ensure_tasks_json "$tasks_file"
  acquire_task_lock "$tasks_file"
  read_tasks "$tasks_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
tid = sys.argv[1]
for t in data['tasks']:
    if t['id'] == tid:
        t['status'] = 'backlogged'
        t['claimed_by'] = None
        print(f'Backlogged {tid}', file=sys.stderr)
        break
else:
    print(f'Task {tid} not found', file=sys.stderr)
    sys.exit(1)
json.dump(data, sys.stdout, indent=2)
" "$task_id" | write_tasks "$tasks_file"
  release_task_lock "$tasks_file"
}

cmd_activate() {
  local task_id="${1:-}"
  if [[ -z "$task_id" ]]; then
    echo "Usage: agent-pool activate <task-id>"
    exit 1
  fi
  local proj
  proj=$(resolve_project)
  local tasks_file
  tasks_file=$(get_tasks_json_path "$proj")

  ensure_tasks_json "$tasks_file"
  acquire_task_lock "$tasks_file"
  read_tasks "$tasks_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
tid = sys.argv[1]
for t in data['tasks']:
    if t['id'] == tid:
        if t['status'] != 'backlogged':
            print(f\"Task {tid} is {t['status']}, not backlogged.\", file=sys.stderr)
            sys.exit(1)
        t['status'] = 'pending'
        print(f'Activated {tid} → pending', file=sys.stderr)
        break
else:
    print(f'Task {tid} not found', file=sys.stderr)
    sys.exit(1)
json.dump(data, sys.stdout, indent=2)
" "$task_id" | write_tasks "$tasks_file"
  release_task_lock "$tasks_file"
}

cmd_set_status() {
  local task_id="${1:-}"
  local new_status="${2:-}"
  if [[ -z "$task_id" || -z "$new_status" ]]; then
    echo "Usage: agent-pool set-status <task-id> <status>"
    echo "  Valid statuses: pending, in_progress, completed, blocked, backlogged"
    exit 1
  fi
  case "$new_status" in
    pending|in_progress|completed|blocked|backlogged) ;;
    *) echo "Invalid status: $new_status"; echo "  Valid statuses: pending, in_progress, completed, blocked, backlogged"; exit 1 ;;
  esac
  local proj
  proj=$(resolve_project)
  local tasks_file
  tasks_file=$(get_tasks_json_path "$proj")

  ensure_tasks_json "$tasks_file"
  acquire_task_lock "$tasks_file"
  read_tasks "$tasks_file" | /usr/bin/python3 -c "
import json, sys, datetime
data = json.load(sys.stdin)
tid = sys.argv[1]
new_status = sys.argv[2]
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
for t in data['tasks']:
    if t['id'] == tid:
        old_status = t['status']
        t['status'] = new_status
        if new_status in ('pending', 'backlogged'):
            t['claimed_by'] = None
            t['started_at'] = None
            t['completed_at'] = None
        elif new_status in ('completed', 'blocked'):
            t['completed_at'] = now
        print(f'Task {tid} status changed to {new_status}', file=sys.stderr)
        break
else:
    print(f'Task {tid} not found', file=sys.stderr)
    sys.exit(1)
json.dump(data, sys.stdout, indent=2)
" "$task_id" "$new_status" | write_tasks "$tasks_file"
  release_task_lock "$tasks_file"
}
