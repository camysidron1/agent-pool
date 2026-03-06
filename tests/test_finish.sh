# Tests for finish-task.sh

test_finish_completed() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-fin" "in_progress" "agent-00"

  AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" completed

  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t['status'])
")
  assert_eq "completed" "$status" "task should be completed"

  local completed_at
  completed_at=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t.get('completed_at', ''))
")
  [[ -n "$completed_at" ]] || { echo "    FAIL: completed_at should be set"; return 1; }

  assert_file_exists "$TEST_DIR/.task-finished-t-fin" "signal file should exist"
}

test_finish_blocked() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-fin" "in_progress" "agent-00"

  AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" blocked

  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t['status'])
")
  assert_eq "blocked" "$status" "task should be blocked"

  local completed_at
  completed_at=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t.get('completed_at', ''))
")
  [[ -n "$completed_at" ]] || { echo "    FAIL: completed_at should be set for blocked"; return 1; }

  assert_file_exists "$TEST_DIR/.task-finished-t-fin" "signal file should exist"
}

test_finish_pending() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-fin" "in_progress" "agent-00"

  AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" pending

  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t['status'])
")
  assert_eq "pending" "$status" "task should be pending"

  local claimed_by
  claimed_by=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t.get('claimed_by', ''))
")
  assert_eq "" "$claimed_by" "claimed_by should be cleared"

  local started_at
  started_at=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t.get('started_at', 'MISSING'))
")
  assert_eq "MISSING" "$started_at" "started_at should be removed"

  local completed_at
  completed_at=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t.get('completed_at', 'MISSING'))
")
  assert_eq "MISSING" "$completed_at" "completed_at should be removed"
}

test_finish_backlogged() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-fin" "in_progress" "agent-00"

  AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" backlogged

  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t['status'])
")
  assert_eq "backlogged" "$status" "task should be backlogged"

  local claimed_by
  claimed_by=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t.get('claimed_by', ''))
")
  assert_eq "" "$claimed_by" "claimed_by should be cleared"

  local started_at
  started_at=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t.get('started_at', 'MISSING'))
")
  assert_eq "MISSING" "$started_at" "started_at should be removed"

  local completed_at
  completed_at=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t.get('completed_at', 'MISSING'))
")
  assert_eq "MISSING" "$completed_at" "completed_at should be removed"
}

test_finish_default_status() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-fin" "in_progress" "agent-00"

  AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh"

  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-fin': print(t['status'])
")
  assert_eq "completed" "$status" "default status should be completed"
}

test_finish_invalid_status() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-fin" "in_progress" "agent-00"

  if AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" invalid 2>&1; then
    echo "    FAIL: expected non-zero exit for invalid status"
    return 1
  fi
}

test_finish_missing_env_vars() {
  if AGENT_POOL_TASK_ID="" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" completed 2>&1; then
    echo "    FAIL: expected non-zero exit when AGENT_POOL_TASK_ID is empty"
    return 1
  fi

  local output
  if output=$(AGENT_POOL_PROJECT="" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" completed 2>&1); then
    echo "    FAIL: expected non-zero exit when AGENT_POOL_PROJECT is empty"
    return 1
  fi
  assert_contains "$output" "ERROR" "should show error message"

  if output=$(AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" completed 2>&1); then
    echo "    FAIL: expected non-zero exit when AGENT_POOL_PROJECT is unset"
    return 1
  fi
  assert_contains "$output" "ERROR" "should show error message"
}

test_finish_missing_tasks_file() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  # Do NOT create a tasks file — it should not exist yet

  if AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" completed 2>&1; then
    echo "    FAIL: expected non-zero exit when tasks file is missing"
    return 1
  fi
}

test_finish_signal_file() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-fin" "in_progress" "agent-00"

  AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" blocked

  assert_file_exists "$TEST_DIR/.task-finished-t-fin" "signal file should exist"
  local sig_content
  sig_content=$(cat "$TEST_DIR/.task-finished-t-fin")
  assert_eq "blocked" "$sig_content" "signal file should contain status"
}

test_finish_task_not_found() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-other" "in_progress" "agent-00"

  # Task t-fin does not exist in JSON, but script doesn't validate this — it should still exit 0
  AGENT_POOL_TASK_ID="t-fin" AGENT_POOL_PROJECT="foo" AGENT_POOL_DATA_DIR="$TEST_DIR" \
    "$SCRIPT_DIR/finish-task.sh" completed

  # The original task should be unchanged
  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-other': print(t['status'])
")
  assert_eq "in_progress" "$status" "other task should be unchanged"

  # Signal file should still be written
  assert_file_exists "$TEST_DIR/.task-finished-t-fin" "signal file should exist even for unknown task"
}

run_test test_finish_completed
run_test test_finish_blocked
run_test test_finish_pending
run_test test_finish_backlogged
run_test test_finish_default_status
run_test test_finish_invalid_status
run_test test_finish_missing_env_vars
run_test test_finish_missing_tasks_file
run_test test_finish_signal_file
run_test test_finish_task_not_found
