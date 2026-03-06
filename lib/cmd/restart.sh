# lib/cmd/restart.sh — Agent restart commands

cmd_restart() {
  local skip_perms=false env_name="" clone_idx="" here_mode=false
  while [[ $# -gt 0 ]]; do
    case $1 in
      --skip-permissions) skip_perms=true; shift ;;
      --env) env_name="$2"; shift 2 ;;
      --here) here_mode=true; shift ;;
      [0-9]|[0-9][0-9]) clone_idx="$1"; shift ;;
      *) echo "Unknown option: $1"; exit 1 ;;
    esac
  done

  local proj
  proj=$(resolve_project)
  local pool_file prefix
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")

  ensure_pool_json "$pool_file"

  # Build runner flags
  local runner_perms_flag=""
  [[ "$skip_perms" == true ]] && runner_perms_flag=" --skip-permissions"
  local runner_env_flag=""
  [[ -n "$env_name" ]] && runner_env_flag=" $env_name"

  # --here mode: detect clone from cwd and restart in current shell
  if [[ "$here_mode" == true ]]; then
    _restart_here "$proj" "$prefix" "$pool_file" "$runner_perms_flag" "$runner_env_flag"
    return
  fi

  # Single clone restart
  if [[ -n "$clone_idx" ]]; then
    _restart_single "$proj" "$prefix" "$pool_file" "$clone_idx" "$runner_perms_flag" "$runner_env_flag"
    return
  fi

  # No index, no --here: restart all (original behavior)
  _restart_all "$proj" "$prefix" "$pool_file" "$runner_perms_flag" "$runner_env_flag"
}

# Kill claude processes specifically tied to a clone path
_kill_claude_in_clone() {
  local clone_path="$1"
  # Find claude processes whose command line references this clone path
  local pids
  pids=$(ps ax -o pid,command | grep -E "claude" | grep -F "$clone_path" | grep -v grep | awk '{print $1}' || true)
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      printf "  Killing claude process %s in %s\n" "$pid" "$clone_path"
      kill "$pid" 2>/dev/null || true
    done
    sleep 1
    # Force kill any stragglers
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

_restart_here() {
  local proj="$1" prefix="$2" pool_file="$3" runner_perms_flag="$4" runner_env_flag="$5"

  # Detect clone index from cwd
  local cwd="$PWD"
  local clone_idx=""
  clone_idx=$(/usr/bin/python3 -c "
import re, sys
cwd = sys.argv[1]
prefix = sys.argv[2]
# Match prefix-NN at end of path or as a directory component
m = re.search(r'/' + re.escape(prefix) + r'-(\d+)(?:/|$)', cwd)
if m:
    print(int(m.group(1)))
else:
    sys.exit(1)
" "$cwd" "$prefix" 2>/dev/null) || {
    echo "Error: could not detect clone index from current directory ($cwd)." >&2
    echo "Expected a path containing ${prefix}-NN" >&2
    exit 1
  }

  local clone_path
  clone_path=$(get_clone_path "$prefix" "$clone_idx")
  printf "Detected clone %02d from cwd\n" "$clone_idx"

  # Kill, refresh, unlock, exec
  _kill_claude_in_clone "$clone_path"
  refresh_one "$proj" "$clone_idx"

  local runner_cmd="$RUNNER_SCRIPT $clone_idx --project $proj${runner_env_flag}${runner_perms_flag}"
  printf "Exec: %s\n" "$runner_cmd"
  cd "$clone_path"
  exec $runner_cmd
}

_restart_single() {
  local proj="$1" prefix="$2" pool_file="$3" clone_idx="$4" runner_perms_flag="$5" runner_env_flag="$6"

  local clone_path
  clone_path=$(get_clone_path "$prefix" "$clone_idx")
  if [[ ! -d "$clone_path" ]]; then
    echo "Error: clone directory $clone_path does not exist." >&2
    exit 1
  fi

  printf "Restarting agent-%02d...\n" "$clone_idx"

  # Kill any running claude in this clone
  _kill_claude_in_clone "$clone_path"

  # Refresh the clone (resets to project branch, cleans, unlocks)
  refresh_one "$proj" "$clone_idx"

  # Build the runner command
  local runner_cmd="cd $clone_path && $RUNNER_SCRIPT $clone_idx --project $proj${runner_env_flag}${runner_perms_flag}"

  # Try to find the cmux pane for this clone and send the command
  local workspace_id
  workspace_id=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
idx = int(sys.argv[1])
for c in data['clones']:
    if c['index'] == idx:
        print(c.get('workspace_id', ''))
        break
" "$clone_idx" 2>/dev/null || true)

  local sent=false
  if [[ -n "$workspace_id" ]]; then
    local surfaces
    surfaces=$(cmux --json list-pane-surfaces --workspace "$workspace_id" 2>/dev/null | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for s in data.get('surfaces', []):
    print(s['ref'])
" 2>/dev/null || true)

    if [[ -n "$surfaces" ]]; then
      # Find the pane for this clone index within the workspace
      # Use the clone's position among locked clones in this workspace
      local pane_idx
      pane_idx=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
target = int(sys.argv[1])
ws = sys.argv[2]
i = 0
for c in sorted(data['clones'], key=lambda x: x['index']):
    if c.get('locked') and c.get('workspace_id', '') == ws:
        if c['index'] == target:
            print(i)
            break
        i += 1
" "$clone_idx" "$workspace_id" 2>/dev/null || true)

      local surface_line
      surface_line=$(echo "$surfaces" | sed -n "$((${pane_idx:-0} + 1))p")
      if [[ -n "$surface_line" ]]; then
        cmux send --surface "$surface_line" "\x03" 2>/dev/null || true
        sleep 0.3
        cmux send --surface "$surface_line" "\x03" 2>/dev/null || true
        sleep 0.5
        cmux send --surface "$surface_line" "$runner_cmd\\n" 2>/dev/null || true
        printf "  Restarted agent-%02d on %s\n" "$clone_idx" "$surface_line"
        sent=true
      fi
    fi
  fi

  if [[ "$sent" != true ]]; then
    printf "  Could not find tmux/cmux pane for agent-%02d.\n" "$clone_idx"
    printf "  Run manually:\n    %s\n" "$runner_cmd"
  fi
}

_restart_all() {
  local proj="$1" prefix="$2" pool_file="$3" runner_perms_flag="$4" runner_env_flag="$5"

  local clone_data
  clone_data=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data['clones']:
    # Include locked clones OR any clone with a running runner process
    print(f\"{c['index']}\t{c.get('workspace_id', '')}\")
")

  if [[ -z "$clone_data" ]]; then
    printf "No clones to restart.\n"
    return
  fi

  # Group clones by workspace using python (avoids bash 4+ associative arrays)
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

  local restarted=0

  while IFS='|' read -r ws idx_list; do
    [[ -z "$ws" ]] && continue
    local surfaces
    surfaces=$(cmux --json list-pane-surfaces --workspace "$ws" 2>/dev/null | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for s in data.get('surfaces', []):
    print(s['ref'])
" 2>/dev/null || true)

    if [[ -z "$surfaces" ]]; then
      printf "  Warning: no surfaces found for workspace %s, skipping\n" "$ws"
      continue
    fi

    IFS=',' read -ra idxs <<< "$idx_list"
    local i=0
    while IFS= read -r surface; do
      if [[ $i -ge ${#idxs[@]} ]]; then
        break
      fi
      local cidx=${idxs[$i]}
      local clone_path
      clone_path=$(get_clone_path "$prefix" "$cidx")
      local runner_cmd="cd $clone_path && $RUNNER_SCRIPT $cidx --project $proj${runner_env_flag}${runner_perms_flag}"

      cmux send --surface "$surface" "\x03" 2>/dev/null || true
      sleep 0.3
      cmux send --surface "$surface" "\x03" 2>/dev/null || true
      sleep 0.5
      cmux send --surface "$surface" "$runner_cmd\\n" 2>/dev/null || true

      printf "  Restarted agent-%02d on %s\n" "$cidx" "$surface"
      restarted=$((restarted + 1))
      i=$((i + 1))
    done <<< "$surfaces"
  done <<< "$grouped"

  printf "Restarted %d agents.\n" "$restarted"
}
