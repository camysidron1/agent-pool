# lib/cmd/start.sh — Interactive guided setup

cmd_start() {
  ensure_projects_json

  # --- 1. Project selection (interactive via /dev/tty) ---
  local proj_names proj_count
  proj_names=$(read_projects | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for name in data.get('projects', {}):
    print(name)
")
  proj_count=$(echo "$proj_names" | grep -c .)

  if [[ "$proj_count" -eq 0 ]]; then
    echo "No projects registered. Run 'agent-pool project add' first." >&2
    exit 1
  fi

  local proj
  if [[ "$proj_count" -eq 1 ]]; then
    proj=$(echo "$proj_names" | head -1)
    printf "Using project: %s\n" "$proj"
  else
    printf "Available projects:\n"
    local i=1
    while IFS= read -r name; do
      printf "  %d) %s\n" "$i" "$name"
      i=$((i + 1))
    done <<< "$proj_names"
    printf "Select project [1]: "
    local choice
    read -r choice </dev/tty
    choice="${choice:-1}"
    proj=$(echo "$proj_names" | sed -n "${choice}p")
    if [[ -z "$proj" ]]; then
      echo "Invalid selection." >&2
      exit 1
    fi
    printf "Selected: %s\n" "$proj"
  fi

  # --- 2. Clone count ---
  printf "Number of agents [4]: "
  local count
  read -r count </dev/tty
  count="${count:-4}"
  if ! [[ "$count" =~ ^[0-9]+$ ]] || [[ "$count" -lt 1 ]]; then
    echo "Invalid count." >&2
    exit 1
  fi

  # --- 3. Skip permissions ---
  printf "Skip permissions? [y/N]: "
  local skip_answer
  read -r skip_answer </dev/tty
  local skip_perms=false
  [[ "$skip_answer" =~ ^[Yy] ]] && skip_perms=true

  # --- 4. Teardown existing sessions ---
  local pool_file prefix
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")
  ensure_pool_json "$pool_file"

  local clone_data
  clone_data=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data['clones']:
    if c.get('locked'):
        print(f\"{c['index']}\t{c.get('workspace_id', '')}\")
" 2>/dev/null || true)

  if [[ -n "$clone_data" ]]; then
    printf "Tearing down existing sessions...\n"

    # Group clones by workspace
    local grouped
    grouped=$(echo "$clone_data" | /usr/bin/python3 -c "
import sys
from collections import OrderedDict
groups = OrderedDict()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    idx, ws = line.split('\t', 1)
    groups.setdefault(ws, []).append(idx)
for ws, idxs in groups.items():
    print(ws + '|' + ','.join(idxs))
")

    while IFS='|' read -r ws idx_list; do
      [[ -z "$ws" ]] && continue

      if [[ "$ws" == surface:* ]]; then
        # Direct surface ref stored during --here launch
        local surface_ref="${ws#surface:}"
        cmux send --surface "$surface_ref" "\x03" 2>/dev/null || true
        sleep 0.2
        cmux send --surface "$surface_ref" "\x03" 2>/dev/null || true
        sleep 0.3
        cmux close-surface --surface "$surface_ref" 2>/dev/null || true
      elif [[ "$ws" != here-* ]]; then
        # Real workspace ref — list and close all surfaces
        local surfaces
        surfaces=$(cmux --json list-pane-surfaces --workspace "$ws" 2>/dev/null | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for s in data.get('surfaces', []):
    print(s['ref'])
" 2>/dev/null || true)

        if [[ -n "$surfaces" ]]; then
          while IFS= read -r surface; do
            cmux send --surface "$surface" "\x03" 2>/dev/null || true
            sleep 0.2
            cmux send --surface "$surface" "\x03" 2>/dev/null || true
          done <<< "$surfaces"
          sleep 0.5
          while IFS= read -r surface; do
            cmux close-surface --surface "$surface" 2>/dev/null || true
          done <<< "$surfaces"
        fi
      fi
      # else: here-* legacy IDs — can't reliably close; just release locks

      # Release all locks in this group
      IFS=',' read -ra idxs <<< "$idx_list"
      for clone_idx in "${idxs[@]}"; do
        unlock_clone "$pool_file" "$clone_idx"
        printf "  Released agent-%02d\n" "$clone_idx"
      done
    done <<< "$grouped"

    sleep 0.5
    printf "Teardown complete.\n"
  fi

  # --- 5a. Clean up stale task lock files ---
  local lock_file
  for lock_file in "${DATA_DIR}"/tasks-*.json.lock "${DATA_DIR}"/tasks.json.lock; do
    [[ -d "$lock_file" ]] || continue
    local pidfile="${lock_file}/pid"
    local holder_pid=""
    [[ -f "$pidfile" ]] && holder_pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [[ -z "$holder_pid" ]] || ! kill -0 "$holder_pid" 2>/dev/null; then
      rm -rf "$lock_file"
      printf "  Cleaned stale lock: %s\n" "$(basename "$lock_file")"
    fi
  done

  # --- 5. Reset pool and clean old clone directories ---
  # Remove all existing clone directories for this project
  local old_indexes
  old_indexes=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data['clones']:
    print(c['index'])
" 2>/dev/null || true)
  if [[ -n "$old_indexes" ]]; then
    while IFS= read -r old_idx; do
      local old_path
      old_path=$(get_clone_path "$prefix" "$old_idx")
      [[ -d "$old_path" ]] && rm -rf "$old_path"
    done <<< "$old_indexes"
  fi
  # Reset pool JSON so numbering starts from 0
  echo '{"clones":[]}' > "$pool_file"

  # --- 6. Close all other panes in this workspace ---
  local caller_surface
  caller_surface=$(cmux --json identify 2>/dev/null | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
c = data.get('caller') or data.get('focused', {})
print(c.get('surface_ref', ''))
" 2>/dev/null || true)

  if [[ -n "$caller_surface" ]]; then
    local all_surfaces
    all_surfaces=$(cmux --json list-panes 2>/dev/null | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for pane in data.get('panes', []):
    for s in pane.get('surface_refs', []):
        print(s)
" 2>/dev/null || true)

    if [[ -n "$all_surfaces" ]]; then
      while IFS= read -r surf; do
        [[ "$surf" == "$caller_surface" ]] && continue
        cmux close-surface --surface "$surf" 2>/dev/null || true
      done <<< "$all_surfaces"
    fi
  fi

  # --- 7. Init clones and launch ---
  printf "\nLaunching %d agents for '%s'...\n" "$count" "$proj"

  # Set PROJECT so resolve_project picks it up
  PROJECT="$proj"

  local init_args=("$count" "--here" "--launch")
  [[ "$skip_perms" == true ]] && init_args+=("--skip-permissions")
  cmd_init "${init_args[@]}"

  # Turn this pane into the driver: cd to source repo and exec claude
  local source_path
  source_path=$(get_source_repo "$proj")
  cd "$source_path"

  # Check pending tasks to give the orchestrator context
  local tasks_file pending_count
  tasks_file=$(get_tasks_json_path "$proj")
  pending_count=0
  if [[ -f "$tasks_file" ]]; then
    pending_count=$(/usr/bin/python3 -c "
import json, sys
data = json.load(open('$tasks_file'))
print(sum(1 for t in data.get('tasks', []) if t.get('status') == 'pending'))
" 2>/dev/null || echo 0)
  fi

  local startup_msg="agent-pool: ${count} agents active for project '${proj}'. ${pending_count} pending tasks in queue. Ready to receive tasks."

  if [[ "$skip_perms" == true ]]; then
    exec claude --dangerously-skip-permissions "$startup_msg"
  else
    exec claude "$startup_msg"
  fi
}
