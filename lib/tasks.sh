# lib/tasks.sh — Task queue: JSON helpers and locking

ensure_tasks_json() {
  local tasks_file="$1"
  if [[ ! -f "$tasks_file" ]] || [[ ! -s "$tasks_file" ]]; then
    echo '{"tasks":[]}' > "$tasks_file"
  fi
}

read_tasks() {
  local tasks_file="$1"
  ensure_tasks_json "$tasks_file"
  cat "$tasks_file"
}

write_tasks() {
  local tasks_file="$1"
  local tmp="${tasks_file}.tmp"
  cat > "$tmp"
  mv "$tmp" "$tasks_file"
}

acquire_task_lock() {
  local tasks_file="$1"
  local lock_dir="${tasks_file}.lock"
  local pidfile="${lock_dir}/pid"
  local max_wait=5 waited=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    # Check for stale lock — if the holding PID is dead, remove it
    if [[ -f "$pidfile" ]]; then
      local holder_pid
      holder_pid=$(cat "$pidfile" 2>/dev/null || echo "")
      if [[ -n "$holder_pid" ]] && ! kill -0 "$holder_pid" 2>/dev/null; then
        rm -rf "$lock_dir"
        continue
      fi
    fi
    sleep 0.1
    waited=$((waited + 1))
    if [[ $waited -ge $((max_wait * 10)) ]]; then
      echo "Failed to acquire task lock" >&2
      echo "" >&2
      return 1
    fi
  done
  echo $$ > "$pidfile"
  trap "rm -rf '$lock_dir'" EXIT
}

release_task_lock() {
  local tasks_file="$1"
  local lock_dir="${tasks_file}.lock"
  rm -rf "$lock_dir"
}
