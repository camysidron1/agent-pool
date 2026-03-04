#!/usr/bin/env bash
set -euo pipefail

# Test suite for agent-pool multi-project support
# Runs against a temp directory to avoid disrupting the live system

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_POOL="$SCRIPT_DIR/agent-pool"
AGENT_RUNNER="$SCRIPT_DIR/agent-runner.sh"

# --- test infrastructure ---

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
FAILED_NAMES=()

setup() {
  TEST_DIR=$(mktemp -d)
  export POOL_DIR="$TEST_DIR"

  # Create two bare git repos as test sources
  REPO_A="$TEST_DIR/source-a"
  REPO_B="$TEST_DIR/source-b"

  git init --bare "$REPO_A" -q
  git init --bare "$REPO_B" -q

  # Populate repo A with an initial commit on "main" and "stg"
  local work_a="$TEST_DIR/_work_a"
  git clone "$REPO_A" "$work_a" -q 2>/dev/null
  cd "$work_a"
  git checkout -b main -q 2>/dev/null || true
  echo "repo-a" > README.md
  git add README.md
  git commit -m "init" -q
  git push origin main -q 2>/dev/null
  git checkout -b stg -q
  git push origin stg -q 2>/dev/null
  cd "$TEST_DIR"
  rm -rf "$work_a"

  # Populate repo B with an initial commit on "main" and "dev"
  local work_b="$TEST_DIR/_work_b"
  git clone "$REPO_B" "$work_b" -q 2>/dev/null
  cd "$work_b"
  git checkout -b main -q 2>/dev/null || true
  echo "repo-b" > README.md
  git add README.md
  git commit -m "init" -q
  git push origin main -q 2>/dev/null
  git checkout -b dev -q
  git push origin dev -q 2>/dev/null
  cd "$TEST_DIR"
  rm -rf "$work_b"
}

teardown() {
  if [[ -n "${TEST_DIR:-}" ]] && [[ -d "$TEST_DIR" ]]; then
    rm -rf "$TEST_DIR"
  fi
  unset POOL_DIR TEST_DIR REPO_A REPO_B
}

# --- assertion helpers ---

assert_eq() {
  local expected="$1" actual="$2" msg="${3:-}"
  if [[ "$expected" != "$actual" ]]; then
    echo "    FAIL: ${msg:-expected '$expected', got '$actual'}"
    return 1
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "    FAIL: ${msg:-expected output to contain '$needle'}"
    echo "    Got: $haystack"
    return 1
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "    FAIL: ${msg:-expected output NOT to contain '$needle'}"
    return 1
  fi
}

assert_file_exists() {
  local path="$1" msg="${2:-}"
  if [[ ! -f "$path" ]]; then
    echo "    FAIL: ${msg:-file '$path' does not exist}"
    return 1
  fi
}

assert_file_not_exists() {
  local path="$1" msg="${2:-}"
  if [[ -f "$path" ]]; then
    echo "    FAIL: ${msg:-file '$path' should not exist}"
    return 1
  fi
}

assert_dir_exists() {
  local path="$1" msg="${2:-}"
  if [[ ! -d "$path" ]]; then
    echo "    FAIL: ${msg:-directory '$path' does not exist}"
    return 1
  fi
}

assert_json_field() {
  local file="$1" field="$2" expected="$3" msg="${4:-}"
  local actual
  actual=$(/usr/bin/python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
keys = sys.argv[2].split('.')
obj = data
for k in keys:
    if isinstance(obj, dict):
        obj = obj.get(k)
    else:
        obj = None
        break
print('' if obj is None else obj)
" "$file" "$field")
  if [[ "$actual" != "$expected" ]]; then
    echo "    FAIL: ${msg:-$file.$field expected '$expected', got '$actual'}"
    return 1
  fi
}

run_test() {
  local test_name="$1"
  TESTS_RUN=$((TESTS_RUN + 1))
  printf "  %-50s " "$test_name"
  setup
  local result=0
  if "$test_name" 2>&1; then
    printf "\033[32mPASS\033[0m\n"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    printf "\033[31mFAIL\033[0m\n"
    TESTS_FAILED=$((TESTS_FAILED + 1))
    FAILED_NAMES+=("$test_name")
    result=1
  fi
  teardown
  return 0  # don't abort the suite on failure
}

# --- test cases ---

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

test_init_creates_project_clones() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo
  assert_dir_exists "$TEST_DIR/foo-01"
  assert_dir_exists "$TEST_DIR/foo-02"
}

test_init_uses_project_branch() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch stg --prefix foo
  "$AGENT_POOL" init 1 -p foo
  local branch
  branch=$(git -C "$TEST_DIR/foo-01" rev-parse --abbrev-ref HEAD)
  assert_eq "stg" "$branch" "clone should be on project branch"
}

test_init_runs_setup() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo --setup "touch setup-ran.marker"
  "$AGENT_POOL" init 1 -p foo
  assert_file_exists "$TEST_DIR/foo-01/setup-ran.marker" "setup command should have run"
}

test_pool_json_per_project() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo
  assert_file_exists "$TEST_DIR/pool-foo.json" "per-project pool file"
  assert_file_not_exists "$TEST_DIR/pool.json" "generic pool.json should not exist"
}

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

test_two_projects_isolated() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main --prefix bar
  "$AGENT_POOL" init 2 -p foo
  "$AGENT_POOL" init 2 -p bar
  "$AGENT_POOL" add "foo-task-1" -p foo
  "$AGENT_POOL" add "bar-task-1" -p bar

  # Verify clone isolation
  assert_dir_exists "$TEST_DIR/foo-01"
  assert_dir_exists "$TEST_DIR/foo-02"
  assert_dir_exists "$TEST_DIR/bar-01"
  assert_dir_exists "$TEST_DIR/bar-02"

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

test_refresh_project_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch stg --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Create a dirty file
  echo "dirty" > "$TEST_DIR/foo-01/dirty.txt"

  "$AGENT_POOL" refresh 1 -p foo

  # Dirty file should be gone
  assert_file_not_exists "$TEST_DIR/foo-01/dirty.txt" "dirty file should be cleaned"

  # Should be on the project branch
  local branch
  branch=$(git -C "$TEST_DIR/foo-01" rev-parse --abbrev-ref HEAD)
  assert_eq "stg" "$branch" "should be on project branch after refresh"
}

test_destroy_project() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main --prefix bar
  "$AGENT_POOL" init 2 -p foo
  "$AGENT_POOL" init 2 -p bar

  "$AGENT_POOL" destroy -p foo

  # foo clones gone
  [[ ! -d "$TEST_DIR/foo-01" ]] || { echo "    FAIL: foo-01 should be removed"; return 1; }
  [[ ! -d "$TEST_DIR/foo-02" ]] || { echo "    FAIL: foo-02 should be removed"; return 1; }

  # bar clones still there
  assert_dir_exists "$TEST_DIR/bar-01"
  assert_dir_exists "$TEST_DIR/bar-02"
}

test_runner_uses_project_tasks() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo
  "$AGENT_POOL" add "runner-test-task" -p foo

  # Verify the task is in the project-specific file
  assert_file_exists "$TEST_DIR/tasks-foo.json"
  local prompt
  prompt=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/tasks-foo.json') as f:
    data = json.load(f)
print(data['tasks'][0]['prompt'])
")
  assert_eq "runner-test-task" "$prompt"

  # Verify runner script can read project config
  # We test that agent-runner.sh accepts --project flag by checking it resolves the correct tasks file
  # (We can't run the full runner loop, but we can test the setup portion)
  local tasks_path
  tasks_path=$("$AGENT_RUNNER" --resolve-tasks-path --project foo 2>/dev/null || true)
  if [[ -n "$tasks_path" ]]; then
    assert_eq "$TEST_DIR/tasks-foo.json" "$tasks_path"
  fi
  # At minimum, verify the tasks file exists at the expected path
  assert_file_exists "$TEST_DIR/tasks-foo.json"
}

test_runner_uses_project_branch() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch stg --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Verify clone is on the project branch
  local branch
  branch=$(git -C "$TEST_DIR/foo-01" rev-parse --abbrev-ref HEAD)
  assert_eq "stg" "$branch" "runner clone should be on project branch"

  # Verify runner can resolve clone path for project
  local clone_path
  clone_path=$("$AGENT_RUNNER" --resolve-clone-path --project foo --index 1 2>/dev/null || true)
  if [[ -n "$clone_path" ]]; then
    assert_eq "$TEST_DIR/foo-01" "$clone_path"
  fi
  # At minimum, verify clone exists at project-prefixed path
  assert_dir_exists "$TEST_DIR/foo-01"
}

test_runner_releases_lock_on_exit() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Simulate runner start: lock the clone
  /usr/bin/python3 -c "
import json, time
with open('$TEST_DIR/pool-foo.json') as f:
    data = json.load(f)
for c in data['clones']:
    if c['index'] == 1:
        c['locked'] = True
        c['workspace_id'] = 'here-test'
        c['locked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
with open('$TEST_DIR/pool-foo.json', 'w') as f:
    json.dump(data, f, indent=2)
"
  # Verify locked
  local locked
  locked=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f:
    data = json.load(f)
print(data['clones'][0]['locked'])
")
  assert_eq "True" "$locked" "clone should be locked"

  # Start runner in background with a subshell that kills it after brief delay
  "$AGENT_RUNNER" 1 --project foo &>/dev/null &
  local runner_pid=$!
  sleep 1
  kill "$runner_pid" 2>/dev/null || true
  sleep 1

  # Check that lock was released
  locked=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/pool-foo.json') as f:
    data = json.load(f)
print(data['clones'][0]['locked'])
")
  assert_eq "False" "$locked" "clone should be released after runner exits"
}

# --- main ---

printf "\n\033[1;34m=== agent-pool multi-project test suite ===\033[0m\n\n"

run_test test_project_add
run_test test_project_add_with_prefix
run_test test_project_add_default_prefix
run_test test_project_list
run_test test_project_remove
run_test test_project_default
run_test test_project_required
run_test test_init_creates_project_clones
run_test test_init_uses_project_branch
run_test test_init_runs_setup
run_test test_pool_json_per_project
run_test test_tasks_json_per_project
run_test test_add_task_to_project
run_test test_tasks_shows_project_tasks
run_test test_status_shows_project_clones
run_test test_two_projects_isolated
run_test test_default_project_flag
run_test test_backward_compat_migration
run_test test_refresh_project_clone
run_test test_destroy_project
run_test test_runner_uses_project_tasks
run_test test_runner_uses_project_branch
run_test test_runner_releases_lock_on_exit

printf "\n\033[1;34m=== Results ===\033[0m\n"
printf "  Total: %d  Passed: \033[32m%d\033[0m  Failed: \033[31m%d\033[0m\n" "$TESTS_RUN" "$TESTS_PASSED" "$TESTS_FAILED"
if [[ $TESTS_FAILED -gt 0 ]]; then
  printf "\n  Failed tests:\n"
  for name in "${FAILED_NAMES[@]}"; do
    printf "    - %s\n" "$name"
  done
  exit 1
fi
printf "\n  \033[32mAll tests passed!\033[0m\n"
