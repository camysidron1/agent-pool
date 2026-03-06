# lib/cmd/project.sh — Project management commands

cmd_project() {
  local subcmd="${1:-}"
  shift || true

  case "$subcmd" in
    add)
      local name="" source="" branch="main" prefix="" setup=""
      while [[ $# -gt 0 ]]; do
        case $1 in
          --source) source="$2"; shift 2 ;;
          --branch) branch="$2"; shift 2 ;;
          --prefix) prefix="$2"; shift 2 ;;
          --setup) setup="$2"; shift 2 ;;
          *) name="$1"; shift ;;
        esac
      done
      if [[ -z "$name" ]] || [[ -z "$source" ]]; then
        echo "Usage: agent-pool project add <name> --source <path> [--branch <branch>] [--prefix <prefix>] [--setup \"<cmd>\"]"
        exit 1
      fi
      [[ -z "$prefix" ]] && prefix="$name"
      ensure_projects_json
      read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
name = sys.argv[1]
data['projects'][name] = {
    'source': sys.argv[2],
    'prefix': sys.argv[3],
    'branch': sys.argv[4],
    'setup': sys.argv[5] if sys.argv[5] else None
}
# If this is the first project, set as default
if not data.get('default'):
    data['default'] = name
json.dump(data, sys.stdout, indent=2)
" "$name" "$source" "$prefix" "$branch" "$setup" | write_projects
      printf "Added project '%s' (source: %s, branch: %s, prefix: %s)\n" "$name" "$source" "$branch" "$prefix"
      ;;

    list)
      ensure_projects_json
      read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
default = data.get('default', '')
projects = data.get('projects', {})
if not projects:
    print('  (no projects)')
    sys.exit(0)
print(f\"{'Name':<16} {'Prefix':<12} {'Branch':<12} {'Tracking':<16} {'Workflow':<16} {'Source'}\")
print(f\"{'----':<16} {'------':<12} {'------':<12} {'--------':<16} {'--------':<16} {'------'}\")
for name, p in projects.items():
    marker = ' *' if name == default else ''
    tracking = p.get('tracking')
    if tracking and tracking.get('type'):
        t = tracking['type'].capitalize()
        key = tracking.get('project_key', '')
        track_str = f'{t} ({key})' if key else t
    else:
        track_str = '-'
    gw = p.get('git_workflow')
    workflow_str = gw['type'] if gw and gw.get('type') else '-'
    print(f\"{name + marker:<16} {p.get('prefix',''):<12} {p.get('branch',''):<12} {track_str:<16} {workflow_str:<16} {p.get('source','')}\")
"
      ;;

    remove)
      local name="${1:-}"
      if [[ -z "$name" ]]; then
        echo "Usage: agent-pool project remove <name>"
        exit 1
      fi
      read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
name = sys.argv[1]
if name in data.get('projects', {}):
    del data['projects'][name]
    if data.get('default') == name:
        data['default'] = ''
    print(f\"Removed project '{name}'\", file=sys.stderr)
else:
    print(f\"Project '{name}' not found\", file=sys.stderr)
    sys.exit(1)
json.dump(data, sys.stdout, indent=2)
" "$name" | write_projects
      ;;

    default)
      local name="${1:-}"
      if [[ -z "$name" ]]; then
        echo "Usage: agent-pool project default <name>"
        exit 1
      fi
      read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
name = sys.argv[1]
if name not in data.get('projects', {}):
    print(f\"Project '{name}' not found\", file=sys.stderr)
    sys.exit(1)
data['default'] = name
json.dump(data, sys.stdout, indent=2)
" "$name" | write_projects
      printf "Default project set to '%s'\n" "$name"
      ;;

    set-tracking)
      local name="" tracking_type="" tracking_key="" tracking_label="" tracking_instructions=""
      while [[ $# -gt 0 ]]; do
        case $1 in
          --type) tracking_type="$2"; shift 2 ;;
          --key) tracking_key="$2"; shift 2 ;;
          --label) tracking_label="$2"; shift 2 ;;
          --instructions) tracking_instructions="$2"; shift 2 ;;
          *) name="$1"; shift ;;
        esac
      done
      if [[ -z "$name" ]] || [[ -z "$tracking_type" ]] || [[ -z "$tracking_key" ]]; then
        echo "Usage: agent-pool project set-tracking <name> --type <type> --key <project-key> [--label <label>] [--instructions \"...\"]"
        exit 1
      fi
      ensure_projects_json
      read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
name = sys.argv[1]
if name not in data.get('projects', {}):
    print(f\"Project '{name}' not found\", file=sys.stderr)
    sys.exit(1)
data['projects'][name]['tracking'] = {
    'type': sys.argv[2],
    'project_key': sys.argv[3],
    'label': sys.argv[4] if sys.argv[4] else None,
    'instructions': sys.argv[5] if sys.argv[5] else None
}
json.dump(data, sys.stdout, indent=2)
" "$name" "$tracking_type" "$tracking_key" "$tracking_label" "$tracking_instructions" | write_projects
      printf "Set tracking for '%s': %s (key: %s)\n" "$name" "$tracking_type" "$tracking_key"
      ;;

    clear-tracking)
      local name="${1:-}"
      if [[ -z "$name" ]]; then
        echo "Usage: agent-pool project clear-tracking <name>"
        exit 1
      fi
      ensure_projects_json
      read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
name = sys.argv[1]
if name not in data.get('projects', {}):
    print(f\"Project '{name}' not found\", file=sys.stderr)
    sys.exit(1)
data['projects'][name]['tracking'] = None
json.dump(data, sys.stdout, indent=2)
" "$name" | write_projects
      printf "Cleared tracking for '%s'\n" "$name"
      ;;

    set-workflow)
      local name="" workflow_type="" workflow_instructions=""
      while [[ $# -gt 0 ]]; do
        case $1 in
          --type) workflow_type="$2"; shift 2 ;;
          --instructions) workflow_instructions="$2"; shift 2 ;;
          *) name="$1"; shift ;;
        esac
      done
      if [[ -z "$name" ]] || [[ -z "$workflow_type" ]] || [[ -z "$workflow_instructions" ]]; then
        echo "Usage: agent-pool project set-workflow <name> --type <type> --instructions \"...\""
        exit 1
      fi
      ensure_projects_json
      read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
name = sys.argv[1]
if name not in data.get('projects', {}):
    print(f\"Project '{name}' not found\", file=sys.stderr)
    sys.exit(1)
data['projects'][name]['git_workflow'] = {
    'type': sys.argv[2],
    'instructions': sys.argv[3]
}
json.dump(data, sys.stdout, indent=2)
" "$name" "$workflow_type" "$workflow_instructions" | write_projects
      printf "Set git workflow for '%s': %s\n" "$name" "$workflow_type"
      ;;

    clear-workflow)
      local name="${1:-}"
      if [[ -z "$name" ]]; then
        echo "Usage: agent-pool project clear-workflow <name>"
        exit 1
      fi
      ensure_projects_json
      read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
name = sys.argv[1]
if name not in data.get('projects', {}):
    print(f\"Project '{name}' not found\", file=sys.stderr)
    sys.exit(1)
data['projects'][name]['git_workflow'] = None
json.dump(data, sys.stdout, indent=2)
" "$name" | write_projects
      printf "Cleared git workflow for '%s'\n" "$name"
      ;;

    *)
      echo "Usage: agent-pool project <add|list|remove|default|set-tracking|clear-tracking|set-workflow|clear-workflow> [args...]"
      exit 1
      ;;
  esac
}
