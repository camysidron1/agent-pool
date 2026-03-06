# Status command tests (lib/cmd/status.sh)

test_status_project_header() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  local output
  output=$("$AGENT_POOL" status -p foo)
  local first_line
  first_line=$(echo "$output" | head -n1)
  assert_eq "Project: foo" "$first_line" "first line should be project header"
}

test_status_column_headers() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  local output
  output=$("$AGENT_POOL" status -p foo)
  assert_contains "$output" "Clone" "should contain Clone header"
  assert_contains "$output" "Status" "should contain Status header"
  assert_contains "$output" "Branch" "should contain Branch header"
  assert_contains "$output" "Workspace" "should contain Workspace header"
}

test_status_shows_branch() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch stg --prefix foo
  "$AGENT_POOL" init 1 -p foo

  local output
  output=$("$AGENT_POOL" status -p foo)
  assert_contains "$output" "stg" "should show branch name stg"
}

test_status_workspace_display() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Lock clone 0 with a workspace_id
  # Use a non-"workspace:" prefix so cleanup_stale_locks doesn't auto-release
  # (cleanup only clears locks whose workspace_id starts with "workspace:")
  /usr/bin/python3 -c "
import json, time
with open('$TEST_DIR/pool-foo.json') as f: data = json.load(f)
for c in data['clones']:
    if c['index'] == 0:
        c['locked'] = True
        c['workspace_id'] = 'panel:5'
        c['locked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
with open('$TEST_DIR/pool-foo.json', 'w') as f: json.dump(data, f, indent=2)
"

  local output
  output=$("$AGENT_POOL" status -p foo)
  assert_contains "$output" "panel:5" "should display workspace_id"
  assert_contains "$output" "LOCKED" "should show LOCKED status"
}

test_status_workspace_dash_when_empty() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  local output
  output=$("$AGENT_POOL" status -p foo)
  # The clone line (not header/separator) should contain a dash for workspace
  local clone_line
  clone_line=$(echo "$output" | grep "^00")
  assert_contains "$clone_line" "-" "free clone should show dash for workspace"
}

test_status_multiple_clones() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 3 -p foo

  local output
  output=$("$AGENT_POOL" status -p foo)
  assert_contains "$output" "00" "should list clone 00"
  assert_contains "$output" "01" "should list clone 01"
  assert_contains "$output" "02" "should list clone 02"
}

test_status_empty_pool() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo

  local output
  output=$("$AGENT_POOL" status -p foo)
  assert_contains "$output" "no clones" "empty pool should say no clones"
}

run_test test_status_project_header
run_test test_status_column_headers
run_test test_status_shows_branch
run_test test_status_workspace_display
run_test test_status_workspace_dash_when_empty
run_test test_status_multiple_clones
run_test test_status_empty_pool
