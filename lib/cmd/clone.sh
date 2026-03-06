# lib/cmd/clone.sh — Clone maintenance commands

cmd_refresh() {
  local target="$1"
  local proj
  proj=$(resolve_project)
  local pool_file prefix branch
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")
  branch=$(get_project_branch "$proj")

  ensure_pool_json "$pool_file"

  if [[ "$target" == "--all" ]]; then
    local indexes
    indexes=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data['clones']:
    print(c['index'])
")
    for idx in $indexes; do
      refresh_one "$proj" "$idx"
    done
  else
    refresh_one "$proj" "$target"
  fi
  printf "Refresh complete.\n"
}

refresh_one() {
  local proj="$1" idx="$2"
  local pool_file prefix branch setup_cmd clone_path
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")
  branch=$(get_project_branch "$proj")
  setup_cmd=$(get_project_setup "$proj")
  clone_path=$(get_clone_path "$prefix" "$idx")

  if [[ ! -d "$clone_path" ]]; then
    printf "  Clone %02d missing, recreating...\n" "$idx"
    create_clone "$proj" "$idx"
    return $?
  fi

  printf "Refreshing clone %02d...\n" "$idx"
  cd "$clone_path"

  git fetch origin -q 2>/dev/null || true
  git checkout "$branch" -q 2>/dev/null || true
  git reset --hard "origin/$branch" -q 2>/dev/null || git reset --hard "$branch" -q
  git clean -fd -q

  # Delete agent branches
  git branch | grep -E '^\s+agent-' | xargs -r git branch -D 2>/dev/null || true

  # Run setup if configured
  if [[ -n "$setup_cmd" ]]; then
    (cd "$clone_path" && eval "$setup_cmd") 2>/dev/null || true
  fi

  unlock_clone "$pool_file" "$idx"
  printf "  Clone %02d refreshed to %s.\n" "$idx" "$branch"
}

cmd_release() {
  local idx=$1
  if [[ -z "$idx" ]]; then
    echo "Usage: agent-pool release <clone-number>"
    exit 1
  fi
  local proj
  proj=$(resolve_project)
  local pool_file
  pool_file=$(get_pool_json_path "$proj")
  unlock_clone "$pool_file" "$idx"
  printf "Clone %02d released.\n" "$idx"
}

cmd_destroy() {
  local proj
  proj=$(resolve_project)
  local pool_file prefix
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")

  printf "Destroying all clones for project '%s'...\n" "$proj"
  read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data['clones']:
    print(c['index'])
" | while read -r idx; do
    local clone_path
    clone_path=$(get_clone_path "$prefix" "$idx")
    if [[ -d "$clone_path" ]]; then
      printf "  Removing %s...\n" "$clone_path"
      rm -rf "$clone_path"
    fi
  done
  echo '{"clones":[]}' > "$pool_file"
  printf "All clones for '%s' destroyed.\n" "$proj"
}
