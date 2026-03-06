# Project CRUD tests

test_project_add() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main
  assert_file_exists "$TEST_DIR/projects.json"
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.source" "$REPO_A"
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.branch" "main"
}

test_project_add_with_prefix() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix myfoo
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.prefix" "myfoo"
}

test_project_add_default_prefix() {
  "$AGENT_POOL" project add bar --source "$REPO_A" --branch main
  assert_json_field "$TEST_DIR/projects.json" "projects.bar.prefix" "bar"
}

test_project_list() {
  "$AGENT_POOL" project add alpha --source "$REPO_A" --branch main
  "$AGENT_POOL" project add beta --source "$REPO_B" --branch main
  local output
  output=$("$AGENT_POOL" project list)
  assert_contains "$output" "alpha"
  assert_contains "$output" "beta"
}

test_project_remove() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main
  "$AGENT_POOL" project remove foo
  local output
  output=$("$AGENT_POOL" project list)
  assert_not_contains "$output" "foo"
  assert_contains "$output" "bar"
}

test_project_default() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main
  "$AGENT_POOL" project default bar
  assert_json_field "$TEST_DIR/projects.json" "default" "bar"
}

test_project_required() {
  # No projects exist — commands should fail gracefully
  local output
  if output=$("$AGENT_POOL" status 2>&1); then
    echo "    FAIL: expected non-zero exit"
    return 1
  fi
  assert_contains "$output" "project" "error should mention project"
}

test_project_set_tracking() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-tracking foo --type linear --key PROJ-123
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.tracking.type" "linear"
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.tracking.project_key" "PROJ-123"
}

test_project_set_tracking_with_label() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-tracking foo --type jira --key TEAM --label "backend"
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.tracking.type" "jira"
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.tracking.project_key" "TEAM"
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.tracking.label" "backend"
}

test_project_clear_tracking() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-tracking foo --type linear --key PROJ
  "$AGENT_POOL" project clear-tracking foo
  local is_null
  is_null=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f: data = json.load(f)
print('yes' if data['projects']['foo'].get('tracking') is None else 'no')
")
  assert_eq "yes" "$is_null" "tracking should be null after clear"
}

test_project_set_workflow() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-workflow foo --type trunk --instructions "Always rebase"
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.git_workflow.type" "trunk"
  assert_json_field "$TEST_DIR/projects.json" "projects.foo.git_workflow.instructions" "Always rebase"
}

test_project_clear_workflow() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-workflow foo --type trunk --instructions "test"
  "$AGENT_POOL" project clear-workflow foo
  local is_null
  is_null=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f: data = json.load(f)
print('yes' if data['projects']['foo'].get('git_workflow') is None else 'no')
")
  assert_eq "yes" "$is_null" "git_workflow should be null after clear"
}

test_project_set_tracking_missing_args() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  if "$AGENT_POOL" project set-tracking foo --type linear 2>&1; then
    echo "    FAIL: expected non-zero exit for missing --key"
    return 1
  fi
  if "$AGENT_POOL" project set-tracking foo --key PROJ 2>&1; then
    echo "    FAIL: expected non-zero exit for missing --type"
    return 1
  fi
}

test_project_set_workflow_missing_args() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  if "$AGENT_POOL" project set-workflow foo --type trunk 2>&1; then
    echo "    FAIL: expected non-zero exit for missing --instructions"
    return 1
  fi
  if "$AGENT_POOL" project set-workflow foo --instructions "test" 2>&1; then
    echo "    FAIL: expected non-zero exit for missing --type"
    return 1
  fi
}

test_project_first_becomes_default() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main
  assert_json_field "$TEST_DIR/projects.json" "default" "foo"
}

test_project_remove_clears_default() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main
  "$AGENT_POOL" project remove foo
  local default_val
  default_val=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f: data = json.load(f)
print(data.get('default', ''))
")
  assert_eq "" "$default_val" "default should be empty after removing default project"
}

test_project_tracking_shows_in_list() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-tracking foo --type linear --key PROJ
  local output
  output=$("$AGENT_POOL" project list)
  assert_contains "$output" "Linear"
}

run_test test_project_add
run_test test_project_add_with_prefix
run_test test_project_add_default_prefix
run_test test_project_list
run_test test_project_remove
run_test test_project_default
run_test test_project_required
run_test test_project_set_tracking
run_test test_project_set_tracking_with_label
run_test test_project_clear_tracking
run_test test_project_set_workflow
run_test test_project_clear_workflow
run_test test_project_set_tracking_missing_args
run_test test_project_set_workflow_missing_args
run_test test_project_first_becomes_default
run_test test_project_remove_clears_default
run_test test_project_tracking_shows_in_list
