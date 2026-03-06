# Multi-project, status, misc tests

test_two_projects_isolated() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main --prefix bar
  "$AGENT_POOL" init 2 -p foo
  "$AGENT_POOL" init 2 -p bar
  "$AGENT_POOL" add "foo-task-1" -p foo
  "$AGENT_POOL" add "bar-task-1" -p bar

  # Verify clone isolation
  assert_dir_exists "$TEST_DIR/foo-00"
  assert_dir_exists "$TEST_DIR/foo-01"
  assert_dir_exists "$TEST_DIR/bar-00"
  assert_dir_exists "$TEST_DIR/bar-01"

  # Verify task isolation
  local foo_tasks bar_tasks
  foo_tasks=$("$AGENT_POOL" tasks -p foo)
  bar_tasks=$("$AGENT_POOL" tasks -p bar)
  assert_contains "$foo_tasks" "foo-task-1"
  assert_not_contains "$foo_tasks" "bar-task-1"
  assert_contains "$bar_tasks" "bar-task-1"
  assert_not_contains "$bar_tasks" "foo-task-1"

  # Verify pool file isolation
  assert_file_exists "$TEST_DIR/pool-foo.json"
  assert_file_exists "$TEST_DIR/pool-bar.json"
  local foo_count bar_count
  foo_count=$(/usr/bin/python3 -c "import json; print(len(json.load(open('$TEST_DIR/pool-foo.json'))['clones']))")
  bar_count=$(/usr/bin/python3 -c "import json; print(len(json.load(open('$TEST_DIR/pool-bar.json'))['clones']))")
  assert_eq "2" "$foo_count" "foo should have 2 clones"
  assert_eq "2" "$bar_count" "bar should have 2 clones"
}

test_default_project_flag() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project default foo
  # Commands without -p should use default
  "$AGENT_POOL" add "default-task"
  local output
  output=$("$AGENT_POOL" tasks)
  assert_contains "$output" "default-task"
  assert_file_exists "$TEST_DIR/tasks-foo.json"
}

test_backward_compat_migration() {
  # Simulate pre-upgrade state: pool.json and tasks.json exist, no projects.json
  echo '{"clones":[{"index":1,"locked":false,"workspace_id":"","locked_at":"","branch":"stg"}]}' > "$TEST_DIR/pool.json"
  echo '{"tasks":[{"id":"t-1","prompt":"old task","status":"pending","claimed_by":null,"created_at":"2024-01-01","started_at":null,"completed_at":null}]}' > "$TEST_DIR/tasks.json"

  # Running any command should trigger migration
  "$AGENT_POOL" project list

  # Should have created projects.json with nebari project
  assert_file_exists "$TEST_DIR/projects.json"
  assert_json_field "$TEST_DIR/projects.json" "default" "nebari"
  assert_json_field "$TEST_DIR/projects.json" "projects.nebari.prefix" "nebari"
  assert_json_field "$TEST_DIR/projects.json" "projects.nebari.branch" "stg"

  # Old files should be renamed
  assert_file_exists "$TEST_DIR/pool-nebari.json"
  assert_file_exists "$TEST_DIR/tasks-nebari.json"
  assert_file_not_exists "$TEST_DIR/pool.json"
  assert_file_not_exists "$TEST_DIR/tasks.json"
}

test_status_shows_project_clones() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main --prefix bar
  "$AGENT_POOL" init 1 -p foo
  "$AGENT_POOL" init 1 -p bar
  local output
  output=$("$AGENT_POOL" status -p foo)
  assert_contains "$output" "01"
  # Should only show foo's clones (1 clone), not bar's
  # bar also has 1 clone at index 1, so check that status uses project pool file
  local count
  count=$(echo "$output" | grep -c "free" || true)
  assert_eq "1" "$count" "should show exactly 1 clone for foo"
}

test_status_shows_locked_and_free() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo

  # Lock one clone
  local pool_file="$TEST_DIR/pool-foo.json"
  /usr/bin/python3 -c "
import json, time
with open('$pool_file') as f: data = json.load(f)
for c in data['clones']:
    if c['index'] == 0:
        c['locked'] = True
        c['workspace_id'] = 'here-0-test'
        c['locked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
with open('$pool_file', 'w') as f: json.dump(data, f, indent=2)
"

  local output
  output=$("$AGENT_POOL" status -p foo)
  assert_contains "$output" "LOCKED" "should show LOCKED for locked clone"
  assert_contains "$output" "free" "should show free for unlocked clone"
}

test_status_no_clones() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"clones":[]}' > "$TEST_DIR/pool-foo.json"

  local output
  output=$("$AGENT_POOL" status -p foo)
  assert_contains "$output" "no clones" "should indicate no clones"
}

test_resolve_multiple_no_default() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main --prefix bar
  # Remove default (set it to empty)
  /usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f: data = json.load(f)
data['default'] = ''
with open('$TEST_DIR/projects.json', 'w') as f: json.dump(data, f, indent=2)
"

  local output
  if output=$("$AGENT_POOL" status 2>&1); then
    echo "    FAIL: expected non-zero exit when multiple projects and no default"
    return 1
  fi
  assert_contains "$output" "project" "error should mention project"
}

test_resolve_invalid_project_flag() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo

  local output
  if output=$("$AGENT_POOL" status -p nonexistent 2>&1); then
    echo "    FAIL: expected non-zero exit for invalid -p value"
    return 1
  fi
  assert_contains "$output" "not found" "error should say project not found"
}

test_project_flag_before_command() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" add "test task" -p foo

  # -p before the command name
  local output
  output=$("$AGENT_POOL" -p foo tasks)
  assert_contains "$output" "test task"
}

test_unknown_command_shows_help() {
  local output
  if output=$("$AGENT_POOL" nonexistent 2>&1); then
    echo "    FAIL: expected non-zero exit for unknown command"
    return 1
  fi
  assert_contains "$output" "agent-pool" "error should reference agent-pool"
}

test_refresh_preserves_docs() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Create docs outside the clone
  mkdir -p "$TEST_DIR/docs/agents/agent-01"
  mkdir -p "$TEST_DIR/docs/shared"
  echo '# Important' > "$TEST_DIR/docs/agents/agent-01/plan.md"
  echo '# Shared' > "$TEST_DIR/docs/shared/lessons.md"

  # Refresh the clone
  "$AGENT_POOL" refresh 1 -p foo

  # Docs should still exist (they're outside the clone)
  assert_file_exists "$TEST_DIR/docs/agents/agent-01/plan.md" "agent docs should survive refresh"
  assert_file_exists "$TEST_DIR/docs/shared/lessons.md" "shared docs should survive refresh"
}

test_source_repo_tilde_expansion() {
  "$AGENT_POOL" project add foo --source "~/test-repo" --branch main --prefix foo
  PROJECTS_JSON="$TEST_DIR/projects.json"
  DATA_DIR="$TEST_DIR"
  source "$SCRIPT_DIR/lib/project.sh"
  local expanded
  expanded=$(get_source_repo "foo")
  assert_contains "$expanded" "$HOME" "tilde should be expanded"
  assert_not_contains "$expanded" "~" "no literal tilde should remain"
}

test_auto_migrate_no_op_when_no_old_files() {
  # No pool.json, no projects.json
  PROJECTS_JSON="$TEST_DIR/projects.json"
  DATA_DIR="$TEST_DIR"
  source "$SCRIPT_DIR/lib/project.sh"
  auto_migrate
  # projects.json should NOT be created (auto_migrate only triggers when pool.json exists)
  [[ ! -f "$TEST_DIR/projects.json" ]] || { echo "    FAIL: projects.json should not be created when no old files"; return 1; }
}

run_test test_two_projects_isolated
run_test test_default_project_flag
run_test test_backward_compat_migration
run_test test_status_shows_project_clones
run_test test_status_shows_locked_and_free
run_test test_status_no_clones
run_test test_resolve_multiple_no_default
run_test test_resolve_invalid_project_flag
run_test test_project_flag_before_command
run_test test_unknown_command_shows_help
run_test test_refresh_preserves_docs
run_test test_source_repo_tilde_expansion
run_test test_auto_migrate_no_op_when_no_old_files
