# Task queue tests

test_tasks_json_per_project() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" add "test task" -p foo
  assert_file_exists "$TEST_DIR/tasks-foo.json" "per-project tasks file"
  assert_file_not_exists "$TEST_DIR/tasks.json" "generic tasks.json should not exist"
}

test_add_task_to_project() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" add "fix the bug" -p foo
  local prompt
  prompt=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/tasks-foo.json') as f:
    data = json.load(f)
print(data['tasks'][0]['prompt'])
")
  assert_eq "fix the bug" "$prompt"
}

test_tasks_shows_project_tasks() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main --prefix bar
  "$AGENT_POOL" add "foo-task" -p foo
  "$AGENT_POOL" add "bar-task" -p bar
  local output
  output=$("$AGENT_POOL" tasks -p foo)
  assert_contains "$output" "foo-task"
  assert_not_contains "$output" "bar-task"
}

test_add_backlog_flag() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" add --backlog "backlogged task" -p foo
  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/tasks-foo.json') as f:
    data = json.load(f)
print(data['tasks'][0]['status'])
")
  assert_eq "backlogged" "$status" "task should be backlogged"
}

test_task_id_format() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" add "test task" -p foo
  local task_id
  task_id=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/tasks-foo.json') as f:
    data = json.load(f)
print(data['tasks'][0]['id'])
")
  [[ "$task_id" =~ ^t-[0-9]+$ ]] || { echo "    FAIL: task id '$task_id' doesn't match t-<timestamp>"; return 1; }
}

test_unblock_blocked_task() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-100" "blocked" "agent-01"

  "$AGENT_POOL" unblock t-100 -p foo 2>&1

  local status claimed
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['status'])
")
  claimed=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['claimed_by'])
")
  assert_eq "pending" "$status" "task should be pending after unblock"
  assert_eq "None" "$claimed" "claimed_by should be cleared"
}

test_unblock_not_blocked() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-101" "pending"

  if "$AGENT_POOL" unblock t-101 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for non-blocked task"
    return 1
  fi
}

test_unblock_not_found() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"

  if "$AGENT_POOL" unblock t-999 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for missing task"
    return 1
  fi
}

test_backlog_task() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-200" "in_progress" "agent-02"

  "$AGENT_POOL" backlog t-200 -p foo 2>&1

  local status claimed
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['status'])
")
  claimed=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['claimed_by'])
")
  assert_eq "backlogged" "$status" "task should be backlogged"
  assert_eq "None" "$claimed" "claimed_by should be cleared"
}

test_backlog_not_found() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"

  if "$AGENT_POOL" backlog t-999 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for missing task"
    return 1
  fi
}

test_activate_backlogged() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-300" "backlogged"

  "$AGENT_POOL" activate t-300 -p foo 2>&1

  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['status'])
")
  assert_eq "pending" "$status" "task should be pending after activate"
}

test_activate_not_backlogged() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-301" "pending"

  if "$AGENT_POOL" activate t-301 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for non-backlogged task"
    return 1
  fi
}

test_activate_not_found() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"

  if "$AGENT_POOL" activate t-999 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for missing task"
    return 1
  fi
}

test_add_no_prompt_shows_usage() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local output
  if output=$("$AGENT_POOL" add -p foo 2>&1); then
    echo "    FAIL: expected non-zero exit when no prompt"
    return 1
  fi
  assert_contains "$output" "Usage" "should show usage"
}

test_task_lock_stale_detection() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  echo '{"tasks":[]}' > "$tasks_file"

  # Create a stale lock with a dead PID
  local lock_dir="${tasks_file}.lock"
  mkdir -p "$lock_dir"
  echo "99999" > "$lock_dir/pid"

  # Adding a task should succeed (stale lock detected and removed)
  "$AGENT_POOL" add "test after stale" -p foo

  local prompt
  prompt=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['prompt'])
")
  assert_eq "test after stale" "$prompt" "should add task after clearing stale lock"
}

run_test test_tasks_json_per_project
run_test test_add_task_to_project
run_test test_tasks_shows_project_tasks
run_test test_add_backlog_flag
run_test test_task_id_format
run_test test_unblock_blocked_task
run_test test_unblock_not_blocked
run_test test_unblock_not_found
run_test test_backlog_task
run_test test_backlog_not_found
run_test test_activate_backlogged
run_test test_activate_not_backlogged
run_test test_activate_not_found
run_test test_add_no_prompt_shows_usage
run_test test_task_lock_stale_detection
