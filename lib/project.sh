# lib/project.sh — Project configuration and accessors

ensure_projects_json() {
  if [[ ! -f "$PROJECTS_JSON" ]]; then
    echo '{"default":"","projects":{}}' > "$PROJECTS_JSON"
  fi
}

auto_migrate() {
  # Backward compat: if pool.json exists but projects.json doesn't, migrate
  if [[ -f "$DATA_DIR/pool.json" ]] && [[ ! -f "$PROJECTS_JSON" ]]; then
    local source_repo="$HOME/Documents/GitHub/nebari-mvp"
    /usr/bin/python3 -c "
import json, os
projects = {
    'default': 'nebari',
    'projects': {
        'nebari': {
            'source': os.path.expanduser('$source_repo'),
            'prefix': 'nebari',
            'branch': 'stg',
            'setup': None
        }
    }
}
tmp = '$PROJECTS_JSON' + '.tmp'
with open(tmp, 'w') as f:
    json.dump(projects, f, indent=2)
os.rename(tmp, '$PROJECTS_JSON')
"
    # Rename state files
    [[ -f "$DATA_DIR/pool.json" ]] && mv "$DATA_DIR/pool.json" "$DATA_DIR/pool-nebari.json"
    [[ -f "$DATA_DIR/tasks.json" ]] && mv "$DATA_DIR/tasks.json" "$DATA_DIR/tasks-nebari.json"
  fi
}

read_projects() {
  ensure_projects_json
  cat "$PROJECTS_JSON"
}

write_projects() {
  local tmp="$PROJECTS_JSON.tmp"
  cat > "$tmp"
  mv "$tmp" "$PROJECTS_JSON"
}

get_project_field() {
  local project_name="$1" field="$2"
  read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
p = data.get('projects', {}).get(sys.argv[1], {})
val = p.get(sys.argv[2], '')
print('' if val is None else val)
" "$project_name" "$field"
}

resolve_project() {
  # If PROJECT is already set (from -p flag), use it. Otherwise use default.
  if [[ -n "${PROJECT:-}" ]]; then
    # Verify it exists
    local exists
    exists=$(read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
print('yes' if sys.argv[1] in data.get('projects', {}) else 'no')
" "$PROJECT")
    if [[ "$exists" != "yes" ]]; then
      echo "Error: project '$PROJECT' not found. Run 'agent-pool project list' to see available projects." >&2
      exit 1
    fi
    echo "$PROJECT"
    return
  fi

  # Check for a default project first
  local default_proj
  default_proj=$(read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('default', ''))
")

  # If no default and multiple projects, require explicit -p flag
  if [[ -z "$default_proj" ]]; then
    local proj_count
    proj_count=$(read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
print(len(data.get('projects', {})))
")
    if [[ "$proj_count" -gt 1 ]]; then
      echo "Error: multiple projects registered and no default set — you must specify -p <project>. Run 'agent-pool project list' to see available projects." >&2
      exit 1
    fi
  fi
  if [[ -z "$default_proj" ]]; then
    echo "Error: no project specified and no default set. Use -p <project> or run 'agent-pool project default <name>'." >&2
    exit 1
  fi
  echo "$default_proj"
}

# --- per-project state accessors ---

get_pool_json_path() {
  local proj="$1"
  echo "$DATA_DIR/pool-${proj}.json"
}

get_tasks_json_path() {
  local proj="$1"
  echo "$DATA_DIR/tasks-${proj}.json"
}

get_clone_prefix() {
  local proj="$1"
  get_project_field "$proj" "prefix"
}

get_source_repo() {
  local proj="$1"
  local source
  source=$(get_project_field "$proj" "source")
  # Expand ~ manually
  echo "${source/#\~/$HOME}"
}

get_project_branch() {
  local proj="$1"
  get_project_field "$proj" "branch"
}

get_project_setup() {
  local proj="$1"
  get_project_field "$proj" "setup"
}
