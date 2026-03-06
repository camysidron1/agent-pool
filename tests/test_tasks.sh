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

test_set_status_to_completed() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-ss1" "in_progress" "agent-00"

  "$AGENT_POOL" set-status t-ss1 completed -p foo 2>&1

  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-ss1': print(t['status'])
")
  assert_eq "completed" "$status"

  # completed_at should be set
  local completed_at
  completed_at=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-ss1': print(t.get('completed_at', ''))
")
  [[ -n "$completed_at" && "$completed_at" != "None" ]] || { echo "    FAIL: completed_at should be set"; return 1; }
}

test_set_status_to_pending_clears() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-ss2" "in_progress" "agent-01"

  "$AGENT_POOL" set-status t-ss2 pending -p foo 2>&1

  local claimed
  claimed=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-ss2': print(t.get('claimed_by') or '')
")
  assert_eq "" "$claimed" "claimed_by should be cleared"
}

test_set_status_invalid() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-ss3" "pending"

  if "$AGENT_POOL" set-status t-ss3 invalid_status -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for invalid status"
    return 1
  fi
}

test_set_status_not_found() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"

  if "$AGENT_POOL" set-status t-999 completed -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for missing task"
    return 1
  fi
}

test_add_with_depends_on() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" add "first task" -p foo
  # Get the ID of the first task
  local first_id
  first_id=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/tasks-foo.json') as f: data = json.load(f)
print(data['tasks'][0]['id'])
")

  sleep 1  # Ensure different timestamp for second task ID
  "$AGENT_POOL" add --depends-on "$first_id" "second task" -p foo

  # Verify depends_on is set on the second task
  local deps
  deps=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/tasks-foo.json') as f: data = json.load(f)
t = data['tasks'][1]
print(','.join(t.get('depends_on', [])))
")
  assert_eq "$first_id" "$deps" "second task should depend on first"
}

test_add_depends_on_invalid_id() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"

  if "$AGENT_POOL" add --depends-on "t-nonexistent" "dependent task" -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for unknown dependency ID"
    return 1
  fi
}

test_tasks_display_waiting() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-dep1" "pending"
  # Add t-dep2 with depends_on t-dep1 (which is still pending, not completed)
  _add_task_with_status "$tasks_file" "t-dep2" "pending"
  /usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-dep2':
        t['depends_on'] = ['t-dep1']
with open('$tasks_file', 'w') as f: json.dump(data, f, indent=2)
"

  local output
  output=$("$AGENT_POOL" tasks -p foo)
  assert_contains "$output" "waiting" "should show waiting for task with unmet deps"
}

test_tasks_display_deps_suffix() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-a" "completed" "agent-01"
  _add_task_with_status "$tasks_file" "t-b" "pending"
  /usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-b':
        t['depends_on'] = ['t-a']
with open('$tasks_file', 'w') as f: json.dump(data, f, indent=2)
"

  local output
  output=$("$AGENT_POOL" tasks -p foo)
  assert_contains "$output" "[deps: t-a]" "should show deps suffix"
}

test_set_status_no_args() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local output
  if output=$("$AGENT_POOL" set-status -p foo 2>&1); then
    echo "    FAIL: expected non-zero exit with no args"
    return 1
  fi
  assert_contains "$output" "Usage"
}

test_tasks_empty_list() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"
  local output
  output=$("$AGENT_POOL" tasks -p foo)
  assert_contains "$output" "no tasks"
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
run_test test_set_status_to_completed
run_test test_set_status_to_pending_clears
run_test test_set_status_invalid
run_test test_set_status_not_found
run_test test_add_with_depends_on
run_test test_add_depends_on_invalid_id
run_test test_tasks_display_waiting
run_test test_tasks_display_deps_suffix
run_test test_set_status_no_args
run_test test_tasks_empty_list
