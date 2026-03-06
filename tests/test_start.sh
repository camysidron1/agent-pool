# Tests for non-interactive parts of lib/cmd/start.sh
# cmd_start is interactive (reads from /dev/tty), so we test the
# individual behaviors it orchestrates by simulating them directly.

test_start_no_projects_fails() {
  local output rc=0
  output=$("$AGENT_POOL" status 2>&1) || rc=$?
  [[ $rc -ne 0 ]] || { echo "    FAIL: expected non-zero exit"; return 1; }
  assert_contains "$output" "project"
}

test_start_teardown_unlocks_clones() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo
  local pool_file="$TEST_DIR/pool-foo.json"

  # Lock both clones with here-* workspace IDs (legacy IDs that start teardown handles)
  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  lock_clone "$pool_file" 0 "here-0-12345"
  lock_clone "$pool_file" 1 "here-1-12345"

  # Verify locked
  local locked0 locked1
  locked0=$(/usr/bin/python3 -c "import json; print(json.load(open('$pool_file'))['clones'][0]['locked'])")
  assert_eq "True" "$locked0" "clone 0 should be locked"

  # Simulate teardown: unlock all (what start does for here-* IDs)
  unlock_clone "$pool_file" 0
  unlock_clone "$pool_file" 1

  locked0=$(/usr/bin/python3 -c "import json; print(json.load(open('$pool_file'))['clones'][0]['locked'])")
  locked1=$(/usr/bin/python3 -c "import json; print(json.load(open('$pool_file'))['clones'][1]['locked'])")
  assert_eq "False" "$locked0" "clone 0 should be unlocked after teardown"
  assert_eq "False" "$locked1" "clone 1 should be unlocked after teardown"
}

test_start_stale_lock_cleanup() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo

  # Create a stale lock with dead PID
  local lock_dir="$TEST_DIR/tasks-foo.json.lock"
  mkdir -p "$lock_dir"
  echo "99999" > "$lock_dir/pid"

  # Run the cleanup logic
  local lock_file
  for lock_file in "${TEST_DIR}"/tasks-*.json.lock "${TEST_DIR}"/tasks.json.lock; do
    [[ -d "$lock_file" ]] || continue
    local pidfile="${lock_file}/pid"
    local holder_pid=""
    [[ -f "$pidfile" ]] && holder_pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [[ -z "$holder_pid" ]] || ! kill -0 "$holder_pid" 2>/dev/null; then
      rm -rf "$lock_file"
    fi
  done

  # Lock should be cleaned
  [[ ! -d "$lock_dir" ]] || { echo "    FAIL: stale lock should be removed"; return 1; }
}

test_start_pool_reset() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo

  local pool_file="$TEST_DIR/pool-foo.json"

  # Verify clones exist
  assert_dir_exists "$TEST_DIR/foo-00"
  assert_dir_exists "$TEST_DIR/foo-01"

  # Simulate pool reset: remove clone dirs and reset JSON
  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  local prefix="foo"
  local old_indexes
  old_indexes=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data['clones']:
    print(c['index'])
")
  while IFS= read -r old_idx; do
    local old_path
    old_path=$(printf '%s/%s-%02d' "$TEST_DIR" "$prefix" "$old_idx")
    [[ -d "$old_path" ]] && rm -rf "$old_path"
  done <<< "$old_indexes"
  echo '{"clones":[]}' > "$pool_file"

  # Verify clones removed and pool empty
  [[ ! -d "$TEST_DIR/foo-00" ]] || { echo "    FAIL: foo-00 should be removed"; return 1; }
  [[ ! -d "$TEST_DIR/foo-01" ]] || { echo "    FAIL: foo-01 should be removed"; return 1; }
  local count
  count=$(/usr/bin/python3 -c "import json; print(len(json.load(open('$pool_file'))['clones']))")
  assert_eq "0" "$count" "pool should be empty after reset"
}

test_start_pending_task_count() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-1" "pending"
  _add_task_with_status "$tasks_file" "t-2" "completed" "agent-01"
  _add_task_with_status "$tasks_file" "t-3" "pending"
  _add_task_with_status "$tasks_file" "t-4" "blocked" "agent-02"

  local pending_count
  pending_count=$(/usr/bin/python3 -c "
import json
data = json.load(open('$tasks_file'))
print(sum(1 for t in data.get('tasks', []) if t.get('status') == 'pending'))
")
  assert_eq "2" "$pending_count" "should count 2 pending tasks"
}

test_start_stale_lock_keeps_live() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local lock_dir="$TEST_DIR/tasks-foo.json.lock"
  mkdir -p "$lock_dir"
  # Use our own PID (which is alive)
  echo "$$" > "$lock_dir/pid"

  # Run cleanup logic
  local lock_file
  for lock_file in "${TEST_DIR}"/tasks-*.json.lock; do
    [[ -d "$lock_file" ]] || continue
    local pidfile="${lock_file}/pid"
    local holder_pid=""
    [[ -f "$pidfile" ]] && holder_pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [[ -z "$holder_pid" ]] || ! kill -0 "$holder_pid" 2>/dev/null; then
      rm -rf "$lock_file"
    fi
  done

  # Lock should still exist (our PID is alive)
  [[ -d "$lock_dir" ]] || { echo "    FAIL: live lock should NOT be removed"; return 1; }
  # Clean up
  rm -rf "$lock_dir"
}

run_test test_start_no_projects_fails
run_test test_start_teardown_unlocks_clones
run_test test_start_stale_lock_cleanup
run_test test_start_pool_reset
run_test test_start_pending_task_count
run_test test_start_stale_lock_keeps_live
