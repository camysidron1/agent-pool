# Init, refresh, release, destroy tests

test_init_creates_project_clones() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo
  assert_dir_exists "$TEST_DIR/foo-00"
  assert_dir_exists "$TEST_DIR/foo-01"
}

test_init_uses_project_branch() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch stg --prefix foo
  "$AGENT_POOL" init 1 -p foo
  local branch
  branch=$(git -C "$TEST_DIR/foo-00" rev-parse --abbrev-ref HEAD)
  assert_eq "stg" "$branch" "clone should be on project branch"
}

test_init_runs_setup() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo --setup "touch setup-ran.marker"
  "$AGENT_POOL" init 1 -p foo
  assert_file_exists "$TEST_DIR/foo-00/setup-ran.marker" "setup command should have run"
}

test_pool_json_per_project() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo
  assert_file_exists "$TEST_DIR/pool-foo.json" "per-project pool file"
  assert_file_not_exists "$TEST_DIR/pool.json" "generic pool.json should not exist"
}

test_init_additive() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo

  assert_dir_exists "$TEST_DIR/foo-00"
  assert_dir_exists "$TEST_DIR/foo-01"

  # init 2 again should add 2 more (indexes 2,3), not recreate existing
  "$AGENT_POOL" init 2 -p foo

  assert_dir_exists "$TEST_DIR/foo-00"
  assert_dir_exists "$TEST_DIR/foo-01"
  assert_dir_exists "$TEST_DIR/foo-02"
  assert_dir_exists "$TEST_DIR/foo-03"

  local count
  count=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f: data = json.load(f)
print(len(data['clones']))
")
  assert_eq "4" "$count" "should have exactly 4 clones after two init 2 calls"
}

test_refresh_project_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch stg --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Create a dirty file
  echo "dirty" > "$TEST_DIR/foo-00/dirty.txt"

  "$AGENT_POOL" refresh 0 -p foo

  # Dirty file should be gone
  assert_file_not_exists "$TEST_DIR/foo-00/dirty.txt" "dirty file should be cleaned"

  # Should be on the project branch
  local branch
  branch=$(git -C "$TEST_DIR/foo-00" rev-parse --abbrev-ref HEAD)
  assert_eq "stg" "$branch" "should be on project branch after refresh"
}

test_refresh_all() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo

  # Create dirty files in both
  echo "dirty" > "$TEST_DIR/foo-00/dirty.txt"
  echo "dirty" > "$TEST_DIR/foo-01/dirty.txt"

  "$AGENT_POOL" refresh --all -p foo

  assert_file_not_exists "$TEST_DIR/foo-00/dirty.txt" "foo-00 dirty file should be cleaned"
  assert_file_not_exists "$TEST_DIR/foo-01/dirty.txt" "foo-01 dirty file should be cleaned"
}

test_refresh_unlocks_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Lock the clone
  local pool_file="$TEST_DIR/pool-foo.json"
  /usr/bin/python3 -c "
import json, time
with open('$pool_file') as f: data = json.load(f)
for c in data['clones']:
    if c['index'] == 0:
        c['locked'] = True
        c['workspace_id'] = 'test-ws'
        c['locked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
with open('$pool_file', 'w') as f: json.dump(data, f, indent=2)
"

  "$AGENT_POOL" refresh 0 -p foo

  local locked
  locked=$(/usr/bin/python3 -c "
import json
with open('$pool_file') as f: data = json.load(f)
print(data['clones'][0]['locked'])
")
  assert_eq "False" "$locked" "refresh should unlock the clone"
}

test_refresh_nonexistent_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Remove a clone directory to simulate missing clone
  rm -rf "$TEST_DIR/foo-00"

  local output
  output=$("$AGENT_POOL" refresh 00 -p foo 2>&1)
  assert_contains "$output" "missing, recreating" "should recreate missing clone"
  assert_dir_exists "$TEST_DIR/foo-00"
}

test_destroy_project() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main --prefix bar
  "$AGENT_POOL" init 2 -p foo
  "$AGENT_POOL" init 2 -p bar

  echo y | "$AGENT_POOL" destroy -p foo

  # foo clones gone
  [[ ! -d "$TEST_DIR/foo-00" ]] || { echo "    FAIL: foo-00 should be removed"; return 1; }
  [[ ! -d "$TEST_DIR/foo-01" ]] || { echo "    FAIL: foo-01 should be removed"; return 1; }

  # bar clones still there
  assert_dir_exists "$TEST_DIR/bar-00"
  assert_dir_exists "$TEST_DIR/bar-01"
}

test_destroy_force_flag() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo

  # --force should not prompt
  "$AGENT_POOL" destroy --force -p foo

  [[ ! -d "$TEST_DIR/foo-00" ]] || { echo "    FAIL: foo-00 should be removed"; return 1; }
  [[ ! -d "$TEST_DIR/foo-01" ]] || { echo "    FAIL: foo-01 should be removed"; return 1; }

  # Pool should be reset
  local count
  count=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f: data = json.load(f)
print(len(data['clones']))
")
  assert_eq "0" "$count" "pool should be empty after destroy"
}

test_destroy_nonexistent_project() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  if "$AGENT_POOL" destroy -p nonexistent 2>&1; then
    echo "    FAIL: expected non-zero exit for nonexistent project"
    return 1
  fi
}

test_release_unlocks_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Lock the clone manually
  local pool_file="$TEST_DIR/pool-foo.json"
  /usr/bin/python3 -c "
import json, time
with open('$pool_file') as f: data = json.load(f)
for c in data['clones']:
    if c['index'] == 0:
        c['locked'] = True
        c['workspace_id'] = 'test-ws'
        c['locked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
with open('$pool_file', 'w') as f: json.dump(data, f, indent=2)
"

  "$AGENT_POOL" release 0 -p foo

  local locked ws
  locked=$(/usr/bin/python3 -c "
import json
with open('$pool_file') as f: data = json.load(f)
print(data['clones'][0]['locked'])
")
  ws=$(/usr/bin/python3 -c "
import json
with open('$pool_file') as f: data = json.load(f)
print(data['clones'][0]['workspace_id'])
")
  assert_eq "False" "$locked" "clone should be unlocked"
  assert_eq "" "$ws" "workspace_id should be cleared"
}

test_release_no_index() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  if "$AGENT_POOL" release -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit when no index"
    return 1
  fi
}

run_test test_init_creates_project_clones
run_test test_init_uses_project_branch
run_test test_init_runs_setup
run_test test_pool_json_per_project
run_test test_init_additive
run_test test_refresh_project_clone
run_test test_refresh_all
run_test test_refresh_unlocks_clone
run_test test_refresh_nonexistent_clone
run_test test_destroy_project
run_test test_destroy_force_flag
run_test test_destroy_nonexistent_project
run_test test_release_unlocks_clone
run_test test_release_no_index
