# lib/pool.sh — Clone pool management: JSON helpers, locking, creation, stale cleanup

ensure_pool_json() {
  local pool_file="$1"
  if [[ ! -f "$pool_file" ]] || [[ ! -s "$pool_file" ]]; then
    echo '{"clones":[]}' > "$pool_file"
  fi
}

read_pool() {
  local pool_file="$1"
  ensure_pool_json "$pool_file"
  cat "$pool_file"
}

write_pool() {
  local pool_file="$1"
  local tmp="${pool_file}.tmp"
  cat > "$tmp"
  mv "$tmp" "$pool_file"
}

next_index() {
  local pool_file="$1"
  local max
  max=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
indexes = [c['index'] for c in data['clones']]
print(max(indexes) if indexes else -1)
")
  echo "$max"
}

find_free_clone() {
  local pool_file="$1"
  read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data['clones']:
    if not c.get('locked', False):
        print(c['index'])
        sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

get_clone_path() {
  local prefix="$1" idx="$2"
  printf '%s/%s-%02d' "$DATA_DIR" "$prefix" "$idx"
}

lock_clone() {
  local pool_file="$1" idx="$2" workspace_id="$3"
  read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys, time
data = json.load(sys.stdin)
idx = int(sys.argv[1])
ws = sys.argv[2]
for c in data['clones']:
    if c['index'] == idx:
        c['locked'] = True
        c['workspace_id'] = ws
        c['locked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        break
json.dump(data, sys.stdout, indent=2)
" "$idx" "$workspace_id" | write_pool "$pool_file"
}

unlock_clone() {
  local pool_file="$1" idx="$2"
  read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
idx = int(sys.argv[1])
for c in data['clones']:
    if c['index'] == idx:
        c['locked'] = False
        c['workspace_id'] = ''
        c['locked_at'] = ''
        break
json.dump(data, sys.stdout, indent=2)
" "$idx" | write_pool "$pool_file"
}

add_clone_entry() {
  local pool_file="$1" idx="$2" branch="$3"
  read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
idx = int(sys.argv[1])
branch = sys.argv[2]
data['clones'].append({
    'index': idx,
    'locked': False,
    'workspace_id': '',
    'locked_at': '',
    'branch': branch
})
data['clones'].sort(key=lambda c: c['index'])
json.dump(data, sys.stdout, indent=2)
" "$idx" "$branch" | write_pool "$pool_file"
}

remove_clone_entry() {
  local pool_file="$1" idx="$2"
  read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
idx = int(sys.argv[1])
data['clones'] = [c for c in data['clones'] if c['index'] != idx]
json.dump(data, sys.stdout, indent=2)
" "$idx" | write_pool "$pool_file"
}

create_clone() {
  local proj="$1" idx="$2"
  local prefix source_repo branch setup_cmd pool_file clone_path
  prefix=$(get_clone_prefix "$proj")
  source_repo=$(get_source_repo "$proj")
  branch=$(get_project_branch "$proj")
  setup_cmd=$(get_project_setup "$proj")
  pool_file=$(get_pool_json_path "$proj")
  clone_path=$(get_clone_path "$prefix" "$idx")

  printf "Creating clone %02d at %s...\n" "$idx" "$clone_path"

  # Clone with hardlinks (fast, minimal extra disk for git objects)
  git clone --local "$source_repo" "$clone_path" --no-checkout -q
  cd "$clone_path"

  # Point remote at GitHub (local clone sets origin to filesystem path, breaking gh)
  local github_url
  github_url=$(git -C "$source_repo" remote get-url origin 2>/dev/null || echo "")
  if [[ -n "$github_url" ]]; then
    git remote set-url origin "$github_url"
  fi

  git checkout "$branch" -q

  # Trust mise config so tools resolve correctly
  mise trust "$clone_path/mise.toml" 2>/dev/null || true

  # Symlink .claude credentials
  mkdir -p .claude
  if [[ -e "$source_repo/.claude/session" ]]; then
    ln -sf "$source_repo/.claude/session" .claude/session
  fi
  if [[ -d "$source_repo/.claude/sessions" ]]; then
    ln -sf "$source_repo/.claude/sessions" .claude/sessions
  fi

  # Run setup command if configured
  if [[ -n "$setup_cmd" ]]; then
    printf "  Running setup...\n"
    (cd "$clone_path" && eval "$setup_cmd") 2>/dev/null || true
  fi

  add_clone_entry "$pool_file" "$idx" "$branch"
  printf "  Clone %02d ready.\n" "$idx"
}

# Detect stale locks by checking if cmux workspace still exists
cleanup_stale_locks() {
  local pool_file="$1"
  local active_workspaces
  active_workspaces=$(cmux list-workspaces 2>/dev/null || echo "")

  read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
active = sys.argv[1]
changed = False
for c in data['clones']:
    if c.get('locked') and c.get('workspace_id'):
        ws = c['workspace_id']
        # Only check workspace refs (workspace:N) against cmux — skip here/panel locks
        if ws.startswith('workspace:') and ws not in active:
            c['locked'] = False
            c['workspace_id'] = ''
            c['locked_at'] = ''
            changed = True
            print(f\"  Auto-released clone {c['index']:02d} (workspace gone)\", file=sys.stderr)
json.dump(data, sys.stdout, indent=2)
" "$active_workspaces" | write_pool "$pool_file"
}
