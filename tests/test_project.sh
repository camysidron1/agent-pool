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

run_test test_project_add
run_test test_project_add_with_prefix
run_test test_project_add_default_prefix
run_test test_project_list
run_test test_project_remove
run_test test_project_default
run_test test_project_required
