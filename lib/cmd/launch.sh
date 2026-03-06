# lib/cmd/launch.sh — Clone initialization and agent launching

cmd_init() {
  local count=4 launch=false env_name="" no_queue=false launch_here=false skip_perms=false no_driver=false
  while [[ $# -gt 0 ]]; do
    case $1 in
      --launch) launch=true; shift ;;
      --env) env_name="$2"; shift 2 ;;
      --no-queue) no_queue=true; shift ;;
      --here) launch_here=true; launch=true; shift ;;
      --no-driver) no_driver=true; shift ;;
      --skip-permissions) skip_perms=true; shift ;;
      [0-9]*) count="$1"; shift ;;
      *) shift ;;
    esac
  done

  local proj
  proj=$(resolve_project)
  local pool_file prefix
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")

  ensure_pool_json "$pool_file"
  printf "Initializing %d clones for project '%s'...\n" "$count" "$proj"

  local start_idx created_indexes=()
  start_idx=$(next_index "$pool_file")
  for ((i = 0; i < count; i++)); do
    local idx=$((start_idx + i + 1))
    local clone_path
    clone_path=$(get_clone_path "$prefix" "$idx")
    if [[ -d "$clone_path" ]]; then
      printf "  Clone %02d already exists, skipping.\n" "$idx"
      local in_pool
      in_pool=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
print('yes' if any(c['index'] == int(sys.argv[1]) for c in data['clones']) else 'no')
" "$idx")
      [[ "$in_pool" == "no" ]] && add_clone_entry "$pool_file" "$idx" "$(get_project_branch "$proj")"
      created_indexes+=("$idx")
      continue
    fi
    create_clone "$proj" "$idx"
    created_indexes+=("$idx")
  done

  if [[ "$launch" == true ]] && [[ ${#created_indexes[@]} -gt 0 ]]; then
    if [[ "$launch_here" == true ]]; then
      launch_here_all "$proj" "$env_name" "$no_queue" "$skip_perms" "${created_indexes[@]}"
    else
      local driver_flag="true"
      [[ "$no_driver" == true ]] && driver_flag="false"
      launch_grid "$proj" "${env_name}" "$no_queue" "$skip_perms" "$driver_flag" "${created_indexes[@]}"
    fi
  else
    printf "Done. Run 'agent-pool status -p %s' to see pool.\n" "$proj"
  fi
}

# Launch agents in a 2x2 grid layout (up to 4 per workspace) + optional driver pane
launch_grid() {
  local proj="$1"; shift
  local env_name="$1"; shift
  local no_queue="$1"; shift
  local skip_perms="$1"; shift
  local driver="$1"; shift
  local indexes=("$@")
  local total=${#indexes[@]}

  local pool_file prefix branch
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")
  branch=$(get_project_branch "$proj")

  printf "Launching %d agents...\n" "$total"

  # Process in groups of 4 (one workspace per group)
  local group=0
  while [[ $((group * 4)) -lt $total ]]; do
    local start=$((group * 4))
    local end=$((start + 4))
    [[ $end -gt $total ]] && end=$total
    local batch=("${indexes[@]:$start:$((end - start))}")
    local batch_size=${#batch[@]}

    local perms_flag=""
    [[ "$skip_perms" == true ]] && perms_flag=" --dangerously-skip-permissions"
    local runner_perms_flag=""
    [[ "$skip_perms" == true ]] && runner_perms_flag=" --skip-permissions"

    build_launch_cmd() {
      local idx=$1 clone_path
      clone_path=$(get_clone_path "$prefix" "$idx")
      if [[ "$no_queue" == true ]]; then
        cd "$clone_path"
        git fetch origin -q 2>/dev/null || true
        local branch_name="agent-$(printf '%02d' "$idx")-$(date +%s)"
        git checkout -B "$branch_name" "origin/$branch" -q 2>/dev/null || git checkout -B "$branch_name" "$branch" -q
        if [[ -n "$env_name" ]]; then
          echo "cd $clone_path && ENV=$env_name nenv claude$perms_flag"
        else
          echo "cd $clone_path && claude$perms_flag"
        fi
      else
        if [[ -n "$env_name" ]]; then
          echo "cd $clone_path && $RUNNER_SCRIPT $idx --project $proj $env_name$runner_perms_flag"
        else
          echo "cd $clone_path && $RUNNER_SCRIPT $idx --project $proj$runner_perms_flag"
        fi
      fi
    }

    local first_idx=${batch[0]}
    local first_cmd
    first_cmd=$(build_launch_cmd "$first_idx")
    local ws_output
    ws_output=$(cmux new-workspace --command "$first_cmd" 2>&1)
    local workspace_uuid
    workspace_uuid=$(echo "$ws_output" | grep -oE '[0-9A-Fa-f-]{36}' | head -1 || true)

    local ws_ref=""
    if [[ -n "$workspace_uuid" ]]; then
      ws_ref=$(cmux --id-format both list-workspaces 2>/dev/null | grep -F "$workspace_uuid" | grep -oE 'workspace:[0-9]+' | head -1 || true)
      ws_ref="${ws_ref:-$workspace_uuid}"
    fi
    ws_ref="${ws_ref:-ws-grid-$(date +%s)}"

    local first_surface
    first_surface=$(cmux --json list-pane-surfaces --workspace "$ws_ref" 2>/dev/null | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data['surfaces'][0]['ref'])
" 2>/dev/null || true)

    lock_clone "$pool_file" "$first_idx" "$ws_ref"
    local label
    label=$(printf "Agent %02d" "$first_idx")
    printf "  %s (top-left)\n" "$label"

    if [[ $batch_size -ge 2 ]]; then
      local second_idx=${batch[1]}
      local second_cmd
      second_cmd=$(build_launch_cmd "$second_idx")
      local split_out
      split_out=$(cmux --json new-split right --workspace "$ws_ref" --surface "$first_surface" 2>&1)
      local second_surface
      second_surface=$(echo "$split_out" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin)['surface_ref'])" 2>/dev/null || true)
      if [[ -n "$second_surface" ]]; then
        cmux send --workspace "$ws_ref" --surface "$second_surface" "$second_cmd\\n" 2>/dev/null || true
      fi
      lock_clone "$pool_file" "$second_idx" "$ws_ref"
      label=$(printf "Agent %02d" "$second_idx")
      printf "  %s (top-right)\n" "$label"
    fi

    if [[ $batch_size -ge 3 ]]; then
      local third_idx=${batch[2]}
      local third_cmd
      third_cmd=$(build_launch_cmd "$third_idx")
      split_out=$(cmux --json new-split down --workspace "$ws_ref" --surface "$first_surface" 2>&1)
      local third_surface
      third_surface=$(echo "$split_out" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin)['surface_ref'])" 2>/dev/null || true)
      if [[ -n "$third_surface" ]]; then
        cmux send --workspace "$ws_ref" --surface "$third_surface" "$third_cmd\\n" 2>/dev/null || true
      fi
      lock_clone "$pool_file" "$third_idx" "$ws_ref"
      label=$(printf "Agent %02d" "$third_idx")
      printf "  %s (bottom-left)\n" "$label"
    fi

    if [[ $batch_size -ge 4 ]]; then
      local fourth_idx=${batch[3]}
      local fourth_cmd
      fourth_cmd=$(build_launch_cmd "$fourth_idx")
      split_out=$(cmux --json new-split down --workspace "$ws_ref" --surface "$second_surface" 2>&1)
      local fourth_surface
      fourth_surface=$(echo "$split_out" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin)['surface_ref'])" 2>/dev/null || true)
      if [[ -n "$fourth_surface" ]]; then
        cmux send --workspace "$ws_ref" --surface "$fourth_surface" "$fourth_cmd\\n" 2>/dev/null || true
      fi
      lock_clone "$pool_file" "$fourth_idx" "$ws_ref"
      label=$(printf "Agent %02d" "$fourth_idx")
      printf "  %s (bottom-right)\n" "$label"
    fi

    # Add driver pane as a 3rd column (full height) if enabled
    if [[ "$driver" == "true" ]]; then
      local source_path
      source_path=$(get_source_repo "$proj")
      local driver_split_out
      driver_split_out=$(cmux --json new-split right --workspace "$ws_ref" --surface "$first_surface" 2>&1)
      local driver_surface
      driver_surface=$(echo "$driver_split_out" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for key in ('surface_ref', 'ref', 'surface'):
    if key in data:
        print(data[key]); sys.exit(0)
" 2>/dev/null || true)
      if [[ -n "$driver_surface" ]]; then
        cmux send --workspace "$ws_ref" --surface "$driver_surface" "cd $source_path && claude\\n" 2>/dev/null || true
      fi
      printf "  Driver (right column)\n"
    fi

    if [[ $batch_size -eq 1 ]]; then
      cmux rename-workspace --workspace "$ws_ref" "Agent $(printf '%02d' "$first_idx")" >/dev/null 2>&1 || true
    else
      local last_idx=${batch[$((batch_size - 1))]}
      cmux rename-workspace --workspace "$ws_ref" "Agents $(printf '%02d' "$first_idx")-$(printf '%02d' "$last_idx")" >/dev/null 2>&1 || true
    fi

    group=$((group + 1))
  done

  printf "Done. %d agents launched.\n" "$total"
}

# Launch agents in the current workspace as splits (no new workspace tab)
# Layout: [driver | [agent1 | agent2] / [agent3 | agent4]]
launch_here_all() {
  local proj="$1"; shift
  local env_name="$1"; shift
  local no_queue="$1"; shift
  local skip_perms="$1"; shift
  local indexes=("$@")
  local total=${#indexes[@]}

  local pool_file prefix branch
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")
  branch=$(get_project_branch "$proj")

  printf "Launching %d agents in current workspace...\n" "$total"

  local perms_flag=""
  [[ "$skip_perms" == true ]] && perms_flag=" --dangerously-skip-permissions"
  local runner_perms_flag=""
  [[ "$skip_perms" == true ]] && runner_perms_flag=" --skip-permissions"

  build_launch_cmd_here() {
    local idx=$1 clone_path
    clone_path=$(get_clone_path "$prefix" "$idx")
    if [[ "$no_queue" == true ]]; then
      cd "$clone_path"
      git fetch origin -q 2>/dev/null || true
      local branch_name="agent-$(printf '%02d' "$idx")-$(date +%s)"
      git checkout -B "$branch_name" "origin/$branch" -q 2>/dev/null || git checkout -B "$branch_name" "$branch" -q
      if [[ -n "$env_name" ]]; then
        echo "cd $clone_path && ENV=$env_name nenv claude$perms_flag"
      else
        echo "cd $clone_path && claude$perms_flag"
      fi
    else
      if [[ -n "$env_name" ]]; then
        echo "cd $clone_path && $RUNNER_SCRIPT $idx --project $proj $env_name$runner_perms_flag"
      else
        echo "cd $clone_path && $RUNNER_SCRIPT $idx --project $proj$runner_perms_flag"
      fi
    fi
  }

  # Extract surface ref from cmux JSON output
  _extract_surface() {
    echo "$1" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for key in ('surface_ref', 'ref', 'surface'):
    if key in data:
        print(data[key]); sys.exit(0)
" 2>/dev/null || true
  }

  # Send command to surface and lock clone with surface ref
  _launch_in_surface() {
    local idx=$1 surface=$2 label=$3
    local cmd
    cmd=$(build_launch_cmd_here "$idx")
    if [[ -n "$surface" ]]; then
      cmux send --surface "$surface" "$cmd\\n" 2>/dev/null || true
      lock_clone "$pool_file" "$idx" "surface:$surface"
    else
      lock_clone "$pool_file" "$idx" "here-$(date +%s)"
    fi
    printf "  Agent %02d (%s)\n" "$idx" "$label"
  }

  local split_out
  local surfaces=()

  # Step 1: Split right from driver → agent-1 (top-left of grid)
  if [[ $total -ge 1 ]]; then
    split_out=$(cmux --json new-pane --direction right 2>&1)
    surfaces[0]=$(_extract_surface "$split_out")
    _launch_in_surface "${indexes[0]}" "${surfaces[0]}" "top-left"
  fi

  # Step 2: Split agent-1 right → agent-2 (top-right)
  if [[ $total -ge 2 ]]; then
    if [[ -n "${surfaces[0]}" ]]; then
      split_out=$(cmux --json new-split right --surface "${surfaces[0]}" 2>&1)
    else
      split_out=$(cmux --json new-pane --direction right 2>&1)
    fi
    surfaces[1]=$(_extract_surface "$split_out")
    _launch_in_surface "${indexes[1]}" "${surfaces[1]}" "top-right"
  fi

  # Step 3: Split agent-1 down → agent-3 (bottom-left)
  if [[ $total -ge 3 ]]; then
    if [[ -n "${surfaces[0]}" ]]; then
      split_out=$(cmux --json new-split down --surface "${surfaces[0]}" 2>&1)
    else
      split_out=$(cmux --json new-pane --direction down 2>&1)
    fi
    surfaces[2]=$(_extract_surface "$split_out")
    _launch_in_surface "${indexes[2]}" "${surfaces[2]}" "bottom-left"
  fi

  # Step 4: Split agent-2 down → agent-4 (bottom-right)
  if [[ $total -ge 4 ]]; then
    if [[ -n "${surfaces[1]}" ]]; then
      split_out=$(cmux --json new-split down --surface "${surfaces[1]}" 2>&1)
    else
      split_out=$(cmux --json new-pane --direction down 2>&1)
    fi
    surfaces[3]=$(_extract_surface "$split_out")
    _launch_in_surface "${indexes[3]}" "${surfaces[3]}" "bottom-right"
  fi

  # Additional agents beyond 4: cycle splits across existing grid cells
  local i=4
  while [[ $i -lt $total ]]; do
    local parent_idx=$(( (i - 4) % 4 ))
    if [[ -n "${surfaces[$parent_idx]}" ]]; then
      split_out=$(cmux --json new-split down --surface "${surfaces[$parent_idx]}" 2>&1)
    else
      split_out=$(cmux --json new-pane --direction down 2>&1)
    fi
    surfaces[$i]=$(_extract_surface "$split_out")
    _launch_in_surface "${indexes[$i]}" "${surfaces[$i]}" "extra-$((i+1))"
    i=$((i + 1))
  done

  printf "Done. %d agents launched in current workspace.\n" "$total"
}

cmd_launch() {
  local env_name="" mode="grid" direction="right" no_queue=false skip_perms=false no_driver=false
  while [[ $# -gt 0 ]]; do
    case $1 in
      --env) env_name="$2"; shift 2 ;;
      --panel) mode="panel"; shift ;;
      --workspace) mode="workspace"; shift ;;
      --here) mode="here"; shift ;;
      --down) direction="down"; shift ;;
      --right) direction="right"; shift ;;
      --no-queue) no_queue=true; shift ;;
      --no-driver) no_driver=true; shift ;;
      --skip-permissions) skip_perms=true; shift ;;
      *) echo "Unknown option: $1"; exit 1 ;;
    esac
  done

  local proj
  proj=$(resolve_project)
  local pool_file prefix branch
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")
  branch=$(get_project_branch "$proj")

  ensure_pool_json "$pool_file"
  cleanup_stale_locks "$pool_file"

  # Grid mode: collect up to 4 free clones and launch grid + driver
  if [[ "$mode" == "grid" ]]; then
    local grid_indexes=()
    for ((i = 0; i < 4; i++)); do
      local gidx
      if gidx=$(find_free_clone "$pool_file"); then
        grid_indexes+=("$gidx")
        # Temporarily lock so next find_free_clone skips it
        lock_clone "$pool_file" "$gidx" "grid-pending"
      else
        printf "Not enough free clones. Creating a new one...\n"
        gidx=$(( $(next_index "$pool_file") + 1))
        create_clone "$proj" "$gidx"
        grid_indexes+=("$gidx")
        lock_clone "$pool_file" "$gidx" "grid-pending"
      fi
    done
    # Unlock the temporary locks (launch_grid will re-lock with workspace ref)
    for gidx in "${grid_indexes[@]}"; do
      unlock_clone "$pool_file" "$gidx"
    done
    local driver_flag="true"
    [[ "$no_driver" == true ]] && driver_flag="false"
    launch_grid "$proj" "${env_name}" "$no_queue" "$skip_perms" "$driver_flag" "${grid_indexes[@]}"
    return
  fi

  local idx
  if ! idx=$(find_free_clone "$pool_file"); then
    printf "No free clones. Creating a new one...\n"
    idx=$(( $(next_index "$pool_file") + 1))
    create_clone "$proj" "$idx"
  fi

  local clone_path
  clone_path=$(get_clone_path "$prefix" "$idx")
  local label
  label=$(printf "Agent %02d" "$idx")

  local perms_flag=""
  [[ "$skip_perms" == true ]] && perms_flag=" --dangerously-skip-permissions"
  local runner_perms_flag=""
  [[ "$skip_perms" == true ]] && runner_perms_flag=" --skip-permissions"

  local launch_cmd
  if [[ "$no_queue" == true ]]; then
    cd "$clone_path"
    git fetch origin -q 2>/dev/null || true
    local branch_name="agent-$(printf '%02d' "$idx")-$(date +%s)"
    git checkout -B "$branch_name" "origin/$branch" -q 2>/dev/null || git checkout -B "$branch_name" "$branch" -q
    launch_cmd="cd $clone_path"
    if [[ -n "$env_name" ]]; then
      launch_cmd="$launch_cmd && ENV=$env_name nenv claude$perms_flag"
    else
      launch_cmd="$launch_cmd && claude$perms_flag"
    fi
  else
    launch_cmd="cd $clone_path"
    if [[ -n "$env_name" ]]; then
      launch_cmd="$launch_cmd && $RUNNER_SCRIPT $idx --project $proj $env_name$runner_perms_flag"
    else
      launch_cmd="$launch_cmd && $RUNNER_SCRIPT $idx --project $proj$runner_perms_flag"
    fi
  fi

  local workspace_id=""

  if [[ "$mode" == "here" ]]; then
    lock_clone "$pool_file" "$idx" "here-$idx-$(date +%s)"
    # Auto-release lock when this process exits (for --no-queue mode; runner has its own trap)
    trap "unlock_clone '$pool_file' '$idx' 2>/dev/null || true" EXIT
    printf "Launched %s in %s\n" "$label" "$clone_path"
    if [[ -n "$env_name" ]]; then
      printf "  Environment: %s\n" "$env_name"
    fi
    cd "$clone_path"
    if [[ "$no_queue" == true ]]; then
      if [[ -n "$env_name" ]]; then
        ENV="$env_name" nenv claude$perms_flag || true
      else
        claude$perms_flag || true
      fi
    else
      # Runner has its own release trap, so exec is fine here
      if [[ -n "$env_name" ]]; then
        exec "$RUNNER_SCRIPT" "$idx" --project "$proj" "$env_name"$runner_perms_flag
      else
        exec "$RUNNER_SCRIPT" "$idx" --project "$proj"$runner_perms_flag
      fi
    fi
  elif [[ "$mode" == "panel" ]]; then
    local pane_output
    pane_output=$(cmux --json new-pane --direction "$direction" 2>&1)
    local surface_ref
    surface_ref=$(echo "$pane_output" | /usr/bin/python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for key in ('surface_ref', 'ref', 'surface'):
        if key in data:
            print(data[key])
            sys.exit(0)
except:
    pass
" 2>/dev/null || true)

    if [[ -n "$surface_ref" ]]; then
      cmux send --surface "$surface_ref" "$launch_cmd\\n" 2>/dev/null || true
    else
      sleep 0.3
      cmux send "$launch_cmd\\n" 2>/dev/null || true
    fi
    workspace_id="panel-$idx-$(date +%s)"
  else
    local ws_output
    ws_output=$(cmux new-workspace --command "$launch_cmd" 2>&1)
    local workspace_uuid
    workspace_uuid=$(echo "$ws_output" | grep -oE '[0-9A-Fa-f-]{36}' | head -1 || true)

    if [[ -n "$workspace_uuid" ]]; then
      workspace_id=$(cmux --id-format both list-workspaces 2>/dev/null | grep -F "$workspace_uuid" | grep -oE 'workspace:[0-9]+' | head -1 || true)
      workspace_id="${workspace_id:-$workspace_uuid}"
    fi
    workspace_id="${workspace_id:-ws-$idx-$(date +%s)}"

    cmux rename-workspace --workspace "$workspace_id" "$label" >/dev/null 2>&1 || true
  fi

  lock_clone "$pool_file" "$idx" "$workspace_id"

  printf "Launched %s as %s in %s\n" "$label" "$mode" "$clone_path"
  if [[ -n "$env_name" ]]; then
    printf "  Environment: %s\n" "$env_name"
  fi
}
