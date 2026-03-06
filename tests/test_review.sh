# Review command tests

test_review_help() {
  local output
  output=$("$AGENT_POOL" review --help)
  assert_contains "$output" "Usage: agent-pool review"
  assert_contains "$output" "--commits N"
  assert_contains "$output" "--branches"
  assert_contains "$output" "--auto"
}

test_review_creates_task_commits_mode() {
  # Register a project so resolve_project works
  "$AGENT_POOL" project add test-proj --source "$REPO_A" >/dev/null 2>&1
  "$AGENT_POOL" project default test-proj >/dev/null 2>&1

  local output
  output=$("$AGENT_POOL" review 2>&1)
  assert_contains "$output" "Added review task"
  assert_contains "$output" "pending"

  # Verify task exists in queue
  local tasks_output
  tasks_output=$("$AGENT_POOL" tasks 2>&1)
  assert_contains "$tasks_output" "review agent"
}

test_review_creates_task_branches_mode() {
  "$AGENT_POOL" project add test-proj --source "$REPO_A" >/dev/null 2>&1
  "$AGENT_POOL" project default test-proj >/dev/null 2>&1

  local output
  output=$("$AGENT_POOL" review --branches 2>&1)
  assert_contains "$output" "Added review task"

  local tasks_file="$TEST_DIR/tasks-test-proj.json"
  local prompt
  prompt=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f:
    data = json.load(f)
print(data['tasks'][-1]['prompt'][:80])
")
  assert_contains "$prompt" "agent branches"
}

test_review_custom_commits() {
  "$AGENT_POOL" project add test-proj --source "$REPO_A" >/dev/null 2>&1
  "$AGENT_POOL" project default test-proj >/dev/null 2>&1

  "$AGENT_POOL" review --commits 50 2>&1

  local tasks_file="$TEST_DIR/tasks-test-proj.json"
  local prompt
  prompt=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f:
    data = json.load(f)
print(data['tasks'][-1]['prompt'])
")
  assert_contains "$prompt" "50 most recent commits"
  assert_contains "$prompt" "git log --oneline -50"
}

test_review_auto_flag() {
  "$AGENT_POOL" project add test-proj --source "$REPO_A" >/dev/null 2>&1
  "$AGENT_POOL" project default test-proj >/dev/null 2>&1

  "$AGENT_POOL" review --auto 2>&1

  local tasks_file="$TEST_DIR/tasks-test-proj.json"
  local tags
  tags=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f:
    data = json.load(f)
tags = data['tasks'][-1].get('tags', [])
print(','.join(tags))
")
  assert_eq "auto-review" "$tags"
}

test_review_unknown_option() {
  "$AGENT_POOL" project add test-proj --source "$REPO_A" >/dev/null 2>&1
  "$AGENT_POOL" project default test-proj >/dev/null 2>&1

  local output rc=0
  output=$("$AGENT_POOL" review --bogus 2>&1) || rc=$?
  assert_contains "$output" "Unknown option"
  assert_eq "1" "$rc"
}

run_test test_review_help
run_test test_review_creates_task_commits_mode
run_test test_review_creates_task_branches_mode
run_test test_review_custom_commits
run_test test_review_auto_flag
run_test test_review_unknown_option
