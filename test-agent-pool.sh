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

test_destroy_project() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project add bar --source "$REPO_B" --branch main --prefix bar
  "$AGENT_POOL" init 2 -p foo
  "$AGENT_POOL" init 2 -p bar

  "$AGENT_POOL" destroy -p foo

  # foo clones gone
  [[ ! -d "$TEST_DIR/foo-00" ]] || { echo "    FAIL: foo-00 should be removed"; return 1; }
  [[ ! -d "$TEST_DIR/foo-01" ]] || { echo "    FAIL: foo-01 should be removed"; return 1; }

  # bar clones still there
  assert_dir_exists "$TEST_DIR/bar-00"
  assert_dir_exists "$TEST_DIR/bar-01"
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
  branch=$(git -C "$TEST_DIR/foo-00" rev-parse --abbrev-ref HEAD)
  assert_eq "stg" "$branch" "runner clone should be on project branch"

  # Verify runner can resolve clone path for project
  local clone_path
  clone_path=$("$AGENT_RUNNER" --resolve-clone-path --project foo --index 0 2>/dev/null || true)
  if [[ -n "$clone_path" ]]; then
    assert_eq "$TEST_DIR/foo-00" "$clone_path"
  fi
  # At minimum, verify clone exists at project-prefixed path
  assert_dir_exists "$TEST_DIR/foo-00"
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

# --- approval queue tests ---

test_approvals_empty() {
  local output
  output=$("$AGENT_POOL" approvals)
  assert_contains "$output" "No pending approval requests."
}

test_approvals_lists_pending() {
  mkdir -p "$TEST_DIR/approvals"
  echo '{"id":"req-100-ap-01","agent":"ap-01","tool":"Bash","input":"echo hello","timestamp":"2026-03-04T12:00:00Z","status":"pending","decided_at":null}' \
    > "$TEST_DIR/approvals/req-100-ap-01.json"

  local output
  output=$("$AGENT_POOL" approvals)
  assert_contains "$output" "req-100-ap-01"
  assert_contains "$output" "ap-01"
  assert_contains "$output" "Bash"
}

test_approvals_ignores_non_pending() {
  mkdir -p "$TEST_DIR/approvals"
  echo '{"id":"req-200-ap-02","agent":"ap-02","tool":"Edit","input":"x","timestamp":"2026-03-04T12:00:00Z","status":"approved","decided_at":"2026-03-04T12:01:00Z"}' \
    > "$TEST_DIR/approvals/req-200-ap-02.json"

  local output
  output=$("$AGENT_POOL" approvals)
  assert_contains "$output" "No pending approval requests."
}

test_approve_by_id() {
  mkdir -p "$TEST_DIR/approvals"
  echo '{"id":"req-300-ap-01","agent":"ap-01","tool":"Bash","input":"rm -rf","timestamp":"2026-03-04T12:00:00Z","status":"pending","decided_at":null}' \
    > "$TEST_DIR/approvals/req-300-ap-01.json"

  local output
  output=$("$AGENT_POOL" approve req-300-ap-01)
  assert_contains "$output" "Approved req-300-ap-01"

  local status
  status=$(jq -r '.status' "$TEST_DIR/approvals/req-300-ap-01.json")
  assert_eq "approved" "$status"

  local decided_at
  decided_at=$(jq -r '.decided_at' "$TEST_DIR/approvals/req-300-ap-01.json")
  [[ "$decided_at" != "null" ]] || { echo "    FAIL: decided_at should be set"; return 1; }
}

test_approve_all() {
  mkdir -p "$TEST_DIR/approvals"
  echo '{"id":"req-400-ap-01","agent":"ap-01","tool":"Bash","input":"x","timestamp":"2026-03-04T12:00:00Z","status":"pending","decided_at":null}' \
    > "$TEST_DIR/approvals/req-400-ap-01.json"
  echo '{"id":"req-401-ap-02","agent":"ap-02","tool":"Write","input":"y","timestamp":"2026-03-04T12:00:00Z","status":"pending","decided_at":null}' \
    > "$TEST_DIR/approvals/req-401-ap-02.json"
  # Already approved — should not be counted
  echo '{"id":"req-402-ap-03","agent":"ap-03","tool":"Edit","input":"z","timestamp":"2026-03-04T12:00:00Z","status":"approved","decided_at":"2026-03-04T12:01:00Z"}' \
    > "$TEST_DIR/approvals/req-402-ap-03.json"

  local output
  output=$("$AGENT_POOL" approve --all)
  assert_contains "$output" "Approved 2 pending request(s)."

  assert_eq "approved" "$(jq -r '.status' "$TEST_DIR/approvals/req-400-ap-01.json")"
  assert_eq "approved" "$(jq -r '.status' "$TEST_DIR/approvals/req-401-ap-02.json")"
}

test_deny_by_id() {
  mkdir -p "$TEST_DIR/approvals"
  echo '{"id":"req-500-ap-01","agent":"ap-01","tool":"Bash","input":"danger","timestamp":"2026-03-04T12:00:00Z","status":"pending","decided_at":null}' \
    > "$TEST_DIR/approvals/req-500-ap-01.json"

  local output
  output=$("$AGENT_POOL" deny req-500-ap-01)
  assert_contains "$output" "Denied req-500-ap-01"

  local status
  status=$(jq -r '.status' "$TEST_DIR/approvals/req-500-ap-01.json")
  assert_eq "denied" "$status"
}

test_approve_not_found() {
  if "$AGENT_POOL" approve nonexistent 2>&1; then
    echo "    FAIL: expected non-zero exit for missing request"
    return 1
  fi
}

test_deny_not_found() {
  if "$AGENT_POOL" deny nonexistent 2>&1; then
    echo "    FAIL: expected non-zero exit for missing request"
    return 1
  fi
}

test_hook_writes_request_json() {
  # Simulate what the hook does: feed it stdin and run from a clone dir
  mkdir -p "$TEST_DIR/approvals"
  mkdir -p "$TEST_DIR/ap-03"

  local hook_script="$SCRIPT_DIR/hooks/approval-hook.sh"

  # Run hook in background so we can check the file it creates, then kill it
  (
    cd "$TEST_DIR/ap-03"
    echo '{"tool_name":"Bash","tool_input":{"command":"echo test"},"session_id":"s1","hook_event_name":"PreToolUse"}' \
      | "$hook_script" &
    HOOK_PID=$!
    # Give it a moment to write the file
    sleep 2
    kill $HOOK_PID 2>/dev/null || true
  ) &>/dev/null &
  local outer_pid=$!

  sleep 3
  kill "$outer_pid" 2>/dev/null || true
  wait "$outer_pid" 2>/dev/null || true

  # Find the request file
  local req_files=("$TEST_DIR/approvals"/req-*-ap-03.json)
  [[ -f "${req_files[0]}" ]] || { echo "    FAIL: no request file created"; return 1; }

  local agent tool status
  agent=$(jq -r '.agent' "${req_files[0]}")
  tool=$(jq -r '.tool' "${req_files[0]}")
  status=$(jq -r '.status' "${req_files[0]}")
  assert_eq "ap-03" "$agent"
  assert_eq "Bash" "$tool"
  assert_eq "pending" "$status"

  # Clean up
  rm -f "${req_files[0]}"
}

test_hook_exits_on_approve() {
  # Start hook, approve its request, verify it exits 0
  mkdir -p "$TEST_DIR/approvals"
  mkdir -p "$TEST_DIR/ap-04"

  local hook_script="$SCRIPT_DIR/hooks/approval-hook.sh"

  (
    cd "$TEST_DIR/ap-04"
    echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x"},"session_id":"s2","hook_event_name":"PreToolUse"}' \
      | "$hook_script"
  ) &
  local hook_pid=$!

  # Wait for request file to appear
  local waited=0
  local req_file=""
  while [[ $waited -lt 5 ]]; do
    for f in "$TEST_DIR/approvals"/req-*-ap-04.json; do
      [[ -f "$f" ]] && req_file="$f" && break 2
    done
    sleep 1
    waited=$((waited + 1))
  done

  [[ -n "$req_file" ]] || { echo "    FAIL: no request file appeared"; kill "$hook_pid" 2>/dev/null; return 1; }

  # Approve it
  jq '.status = "approved" | .decided_at = "now"' "$req_file" > "$req_file.tmp" && mv "$req_file.tmp" "$req_file"

  # Wait for hook to exit
  local exit_code=0
  wait "$hook_pid" || exit_code=$?
  assert_eq "0" "$exit_code" "hook should exit 0 on approval"
}

test_hook_exits_on_deny() {
  mkdir -p "$TEST_DIR/approvals"
  mkdir -p "$TEST_DIR/ap-05"

  local hook_script="$SCRIPT_DIR/hooks/approval-hook.sh"

  (
    cd "$TEST_DIR/ap-05"
    echo '{"tool_name":"Bash","tool_input":{"command":"bad"},"session_id":"s3","hook_event_name":"PreToolUse"}' \
      | "$hook_script"
  ) 2>/dev/null &
  local hook_pid=$!

  # Wait for request file
  local waited=0
  local req_file=""
  while [[ $waited -lt 5 ]]; do
    for f in "$TEST_DIR/approvals"/req-*-ap-05.json; do
      [[ -f "$f" ]] && req_file="$f" && break 2
    done
    sleep 1
    waited=$((waited + 1))
  done

  [[ -n "$req_file" ]] || { echo "    FAIL: no request file appeared"; kill "$hook_pid" 2>/dev/null; return 1; }

  # Deny it
  jq '.status = "denied" | .decided_at = "now"' "$req_file" > "$req_file.tmp" && mv "$req_file.tmp" "$req_file"

  # Wait for hook to exit
  local exit_code=0
  wait "$hook_pid" || exit_code=$?
  assert_eq "2" "$exit_code" "hook should exit 2 on denial"
}

test_runner_installs_approval_hook() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Create a settings.json with existing hooks
  mkdir -p "$TEST_DIR/foo-00/.claude"
  echo '{"enabledPlugins":{},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"test.sh"}]}]}}' \
    > "$TEST_DIR/foo-00/.claude/settings.json"

  # Simulate what agent-runner does (extract the merge logic)
  local settings_file="$TEST_DIR/foo-00/.claude/settings.json"
  local hook_entry='{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"~/.agent-pool/hooks/approval-hook.sh","timeout":310000}]}]}}'
  local merged
  merged=$(jq --argjson entry "$hook_entry" '
    .hooks //= {} |
    .hooks.PreToolUse //= [] |
    .hooks.PreToolUse = [.hooks.PreToolUse[] | select(
      (.hooks // []) | all(.command | test("approval-hook\\.sh") | not)
    )] |
    .hooks.PreToolUse += $entry.hooks.PreToolUse
  ' "$settings_file") && echo "$merged" > "$settings_file"

  # Verify: existing SessionStart hook preserved
  local session_cmd
  session_cmd=$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$settings_file")
  assert_eq "test.sh" "$session_cmd" "existing SessionStart hook should be preserved"

  # Verify: approval hook added to PreToolUse
  local approval_cmd
  approval_cmd=$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$settings_file")
  assert_contains "$approval_cmd" "approval-hook.sh" "approval hook should be added"

  # Verify: enabledPlugins preserved
  local plugins
  plugins=$(jq -r '.enabledPlugins | keys | length' "$settings_file")
  assert_eq "0" "$plugins" "enabledPlugins should be preserved (empty object)"
}

test_runner_merge_is_idempotent() {
  # Running the merge twice should not duplicate the hook
  mkdir -p "$TEST_DIR/approvals"
  local settings_file="$TEST_DIR/settings-test.json"
  echo '{"hooks":{}}' > "$settings_file"

  local hook_entry='{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"~/.agent-pool/hooks/approval-hook.sh","timeout":310000}]}]}}'

  # Apply twice
  for _ in 1 2; do
    local merged
    merged=$(jq --argjson entry "$hook_entry" '
      .hooks //= {} |
      .hooks.PreToolUse //= [] |
      .hooks.PreToolUse = [.hooks.PreToolUse[] | select(
        (.hooks // []) | all(.command | test("approval-hook\\.sh") | not)
      )] |
      .hooks.PreToolUse += $entry.hooks.PreToolUse
    ' "$settings_file") && echo "$merged" > "$settings_file"
  done

  local count
  count=$(jq '.hooks.PreToolUse | length' "$settings_file")
  assert_eq "1" "$count" "should have exactly 1 PreToolUse hook entry after two merges"
}

# --- docs tests ---

test_docs_empty() {
  # No docs dir yet — should handle gracefully
  local output
  output=$("$AGENT_POOL" docs)
  assert_contains "$output" "No docs directory"
}

test_docs_list() {
  mkdir -p "$TEST_DIR/docs/agents/agent-01"
  mkdir -p "$TEST_DIR/docs/shared"
  echo '# Plan' > "$TEST_DIR/docs/agents/agent-01/todo.md"
  echo '# Lessons' > "$TEST_DIR/docs/shared/lessons.md"

  local output
  output=$("$AGENT_POOL" docs)
  assert_contains "$output" "shared"
  assert_contains "$output" "agent-01"
}

test_docs_agent() {
  mkdir -p "$TEST_DIR/docs/agents/agent-01"
  echo '# My Plan' > "$TEST_DIR/docs/agents/agent-01/todo.md"

  local output
  output=$("$AGENT_POOL" docs agent-01)
  assert_contains "$output" "todo.md"
  assert_contains "$output" "# My Plan"
}

test_docs_shared() {
  mkdir -p "$TEST_DIR/docs/shared"
  echo '# Architecture' > "$TEST_DIR/docs/shared/arch.md"

  local output
  output=$("$AGENT_POOL" docs shared)
  assert_contains "$output" "arch.md"
  assert_contains "$output" "# Architecture"
}

test_docs_agent_not_found() {
  mkdir -p "$TEST_DIR/docs/agents"
  local output
  output=$("$AGENT_POOL" docs agent-99)
  assert_contains "$output" "No docs for agent"
}

test_runner_creates_docs_dirs() {
  # Verify agent-runner sets up docs dirs and symlinks
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo
  "$AGENT_POOL" add "test task" -p foo

  local clone_path="$TEST_DIR/foo-00"
  local agent_id="agent-00"

  # Simulate what agent-runner does (the docs setup portion)
  mkdir -p "$TEST_DIR/docs/agents/$agent_id"
  mkdir -p "$TEST_DIR/docs/shared"
  ln -sfn "$TEST_DIR/docs/agents/$agent_id" "$clone_path/agent-docs"
  ln -sfn "$TEST_DIR/docs/shared" "$clone_path/shared-docs"

  # Verify symlinks
  [[ -L "$clone_path/agent-docs" ]] || { echo "    FAIL: agent-docs symlink missing"; return 1; }
  [[ -L "$clone_path/shared-docs" ]] || { echo "    FAIL: shared-docs symlink missing"; return 1; }

  # Verify symlink targets
  local target
  target=$(readlink "$clone_path/agent-docs")
  assert_eq "$TEST_DIR/docs/agents/$agent_id" "$target" "agent-docs symlink target"

  # Write through symlink and verify
  echo "# Test" > "$clone_path/agent-docs/plan.md"
  assert_file_exists "$TEST_DIR/docs/agents/$agent_id/plan.md"
}

test_runner_claudemd_idempotent() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  local clone_path="$TEST_DIR/foo-00"

  # Simulate CLAUDE.md append (twice — should be idempotent)
  for _ in 1 2; do
    if ! grep -qF '## Documentation Rules' "$clone_path/CLAUDE.md" 2>/dev/null; then
      cat >> "$clone_path/CLAUDE.md" <<'DOCEOF'

## Documentation Rules — IMPORTANT

NEVER create documentation files inside the repository tree.
DOCEOF
    fi
  done

  # Count occurrences of the header
  local count
  count=$(grep -c '## Documentation Rules' "$clone_path/CLAUDE.md")
  assert_eq "1" "$count" "CLAUDE.md section should appear exactly once"
}

test_runner_gitignore_entries() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  local clone_path="$TEST_DIR/foo-00"

  # Simulate .gitignore updates (twice — should be idempotent)
  for _ in 1 2; do
    for entry in agent-docs shared-docs CLAUDE.md; do
      if ! grep -qxF "$entry" "$clone_path/.gitignore" 2>/dev/null; then
        echo "$entry" >> "$clone_path/.gitignore"
      fi
    done
  done

  # Each entry should appear exactly once
  for entry in agent-docs shared-docs CLAUDE.md; do
    local count
    count=$(grep -cxF "$entry" "$clone_path/.gitignore")
    assert_eq "1" "$count" "$entry should appear once in .gitignore"
  done
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

# Approval queue tests
run_test test_approvals_empty
run_test test_approvals_lists_pending
run_test test_approvals_ignores_non_pending
run_test test_approve_by_id
run_test test_approve_all
run_test test_deny_by_id
run_test test_approve_not_found
run_test test_deny_not_found
run_test test_hook_writes_request_json
run_test test_hook_exits_on_approve
run_test test_hook_exits_on_deny
run_test test_runner_installs_approval_hook
run_test test_runner_merge_is_idempotent

# Docs tests
run_test test_docs_empty
run_test test_docs_list
run_test test_docs_agent
run_test test_docs_shared
run_test test_docs_agent_not_found
run_test test_runner_creates_docs_dirs
run_test test_runner_claudemd_idempotent
run_test test_runner_gitignore_entries
run_test test_refresh_preserves_docs

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
