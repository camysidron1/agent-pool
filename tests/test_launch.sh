# Tests for lib/cmd/launch.sh — cmd_init and cmd_launch option parsing
# Focuses on non-cmux functionality: clone creation, pool state, option parsing

test_init_default_count() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init -p foo

  assert_dir_exists "$TEST_DIR/foo-00"
  assert_dir_exists "$TEST_DIR/foo-01"
  assert_dir_exists "$TEST_DIR/foo-02"
  assert_dir_exists "$TEST_DIR/foo-03"

  local count
  count=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f:
    print(len(json.load(f)['clones']))
")
  assert_eq "4" "$count" "default init should create 4 clones"
}

test_init_custom_count() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo

  assert_dir_exists "$TEST_DIR/foo-00"
  assert_dir_exists "$TEST_DIR/foo-01"

  # Should NOT have created a third clone
  [[ ! -d "$TEST_DIR/foo-02" ]] || { echo "    FAIL: foo-02 should not exist"; return 1; }

  local count
  count=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f:
    print(len(json.load(f)['clones']))
")
  assert_eq "2" "$count" "init 2 should create exactly 2 clones"
}

test_init_skip_existing() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo

  # Pre-create clone dir manually (not a real git clone, just a directory)
  mkdir -p "$TEST_DIR/foo-00"

  local output
  output=$("$AGENT_POOL" init 2 -p foo 2>&1)

  assert_contains "$output" "already exists, skipping" "should report skipping existing clone"

  # The second clone should be created normally
  assert_dir_exists "$TEST_DIR/foo-01"

  # Even though foo-00 was skipped, it should be in the pool
  local count
  count=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f:
    print(len(json.load(f)['clones']))
")
  assert_eq "2" "$count" "pool should have 2 entries (skipped + created)"
}

test_init_pool_entries_match_clones() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 3 -p foo

  local count
  count=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f:
    print(len(json.load(f)['clones']))
")
  assert_eq "3" "$count" "pool should have 3 entries"

  # Verify indexes are 0, 1, 2
  local indexes
  indexes=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f:
    data = json.load(f)
print(','.join(str(c['index']) for c in sorted(data['clones'], key=lambda c: c['index'])))
")
  assert_eq "0,1,2" "$indexes" "pool entries should have indexes 0,1,2"
}

test_init_clones_on_correct_branch() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch stg --prefix foo
  "$AGENT_POOL" init 2 -p foo

  local branch0 branch1
  branch0=$(git -C "$TEST_DIR/foo-00" rev-parse --abbrev-ref HEAD)
  branch1=$(git -C "$TEST_DIR/foo-01" rev-parse --abbrev-ref HEAD)

  assert_eq "stg" "$branch0" "clone 00 should be on stg branch"
  assert_eq "stg" "$branch1" "clone 01 should be on stg branch"
}

test_init_runs_setup_command() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo --setup "touch marker.txt"
  "$AGENT_POOL" init 1 -p foo

  assert_file_exists "$TEST_DIR/foo-00/marker.txt" "setup command should have created marker.txt"
}

test_launch_unknown_option() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  if "$AGENT_POOL" launch --invalid -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for unknown option"
    return 1
  fi
}

test_init_no_launch_shows_status_hint() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo

  local output
  output=$("$AGENT_POOL" init 1 -p foo 2>&1)

  assert_contains "$output" "Run 'agent-pool status" "should show status hint when not launching"
}

test_init_additive_count() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo
  "$AGENT_POOL" init 2 -p foo

  local count
  count=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f:
    print(len(json.load(f)['clones']))
")
  assert_eq "4" "$count" "should have 4 clones after two init 2 calls"
  assert_dir_exists "$TEST_DIR/foo-02"
  assert_dir_exists "$TEST_DIR/foo-03"
}

test_init_clones_are_unlocked() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 3 -p foo

  local locked_count
  locked_count=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f:
    data = json.load(f)
print(sum(1 for c in data['clones'] if c.get('locked', False)))
")
  assert_eq "0" "$locked_count" "all clones should be unlocked after init"
}

test_init_clone_has_git_repo() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  local is_git
  is_git=$(git -C "$TEST_DIR/foo-00" rev-parse --is-inside-work-tree 2>/dev/null)
  assert_eq "true" "$is_git" "clone should be a valid git repo"
}

test_launch_cmd_build_no_queue() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Simulate what build_launch_cmd does in no_queue mode
  cd "$TEST_DIR/foo-00"
  git fetch origin -q 2>/dev/null || true
  local branch_name="agent-00-$(date +%s)"
  git checkout -B "$branch_name" "origin/main" -q 2>/dev/null || git checkout -B "$branch_name" "main" -q

  local current_branch
  current_branch=$(git -C "$TEST_DIR/foo-00" rev-parse --abbrev-ref HEAD)
  [[ "$current_branch" == agent-00-* ]] || { echo "    FAIL: branch should start with agent-00-, got '$current_branch'"; return 1; }
}

run_test test_init_default_count
run_test test_init_custom_count
run_test test_init_skip_existing
run_test test_init_pool_entries_match_clones
run_test test_init_clones_on_correct_branch
run_test test_init_runs_setup_command
run_test test_launch_unknown_option
run_test test_init_no_launch_shows_status_hint
run_test test_init_additive_count
run_test test_init_clones_are_unlocked
run_test test_init_clone_has_git_repo
run_test test_launch_cmd_build_no_queue
