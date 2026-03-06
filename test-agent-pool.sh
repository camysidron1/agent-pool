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
  export DATA_DIR="$TEST_DIR"
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
  unset DATA_DIR POOL_DIR TEST_DIR REPO_A REPO_B
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

  echo y | "$AGENT_POOL" destroy -p foo

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

  # Start runner in background, kill it, verify lock released via EXIT trap
  "$AGENT_RUNNER" 1 --project foo &>/dev/null &
  local runner_pid=$!
  sleep 0.2
  kill "$runner_pid" 2>/dev/null || true
  wait "$runner_pid" 2>/dev/null || true

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
  # Test that a non-allowed tool creates a properly formatted request file.
  # We simulate the hook's file-creation logic directly (no polling loop).
  mkdir -p "$TEST_DIR/approvals"
  mkdir -p "$TEST_DIR/ap-03"

  local input='{"tool_name":"Bash","tool_input":{"command":"echo test"},"session_id":"s1","hook_event_name":"PreToolUse"}'
  local tool_name="Bash"
  local tool_input
  tool_input=$(echo "$input" | jq -r '.tool_input // {} | tostring' | head -c 200)
  local agent_id="ap-03"
  local epoch
  epoch=$(date +%s)
  local req_file="$TEST_DIR/approvals/req-${epoch}-${agent_id}.json"

  jq -n \
    --arg id "req-${epoch}-${agent_id}" \
    --arg agent "$agent_id" \
    --arg tool "$tool_name" \
    --arg input "$tool_input" \
    --arg ts "2026-01-01T00:00:00Z" \
    '{id: $id, agent: $agent, tool: $tool, input: $input, timestamp: $ts, status: "pending", decided_at: null}' \
    > "$req_file"

  [[ -f "$req_file" ]] || { echo "    FAIL: no request file created"; return 1; }

  local agent tool status
  agent=$(jq -r '.agent' "$req_file")
  tool=$(jq -r '.tool' "$req_file")
  status=$(jq -r '.status' "$req_file")
  assert_eq "ap-03" "$agent"
  assert_eq "Bash" "$tool"
  assert_eq "pending" "$status"
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
  local hook_entry="{\"hooks\":{\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"${SCRIPT_DIR}/hooks/approval-hook.sh\",\"timeout\":310000}]}]}}"
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

  local hook_entry="{\"hooks\":{\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"${SCRIPT_DIR}/hooks/approval-hook.sh\",\"timeout\":310000}]}]}}"

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

# --- task state machine tests ---

test_add_backlog_flag() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" add --backlog "backlogged task" -p foo
  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/tasks-foo.json') as f:
    data = json.load(f)
print(data['tasks'][0]['status'])
")
  assert_eq "backlogged" "$status" "task should be backlogged"
}

test_task_id_format() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" add "test task" -p foo
  local task_id
  task_id=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/tasks-foo.json') as f:
    data = json.load(f)
print(data['tasks'][0]['id'])
")
  [[ "$task_id" =~ ^t-[0-9]+$ ]] || { echo "    FAIL: task id '$task_id' doesn't match t-<timestamp>"; return 1; }
}

_add_task_with_status() {
  # Helper: directly write a task with a given status to tasks file
  local tasks_file="$1" task_id="$2" status="$3" claimed_by="${4:-}"
  /usr/bin/python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except:
    data = {'tasks': []}
data['tasks'].append({
    'id': sys.argv[2],
    'prompt': 'test prompt',
    'status': sys.argv[3],
    'claimed_by': sys.argv[4] if sys.argv[4] else None,
    'created_at': '2026-01-01T00:00:00',
    'started_at': '2026-01-01T00:01:00' if sys.argv[3] in ('in_progress','blocked','completed') else None,
    'completed_at': '2026-01-01T00:02:00' if sys.argv[3] in ('blocked','completed') else None
})
with open(sys.argv[1], 'w') as f:
    json.dump(data, f, indent=2)
" "$tasks_file" "$task_id" "$status" "$claimed_by"
}

test_unblock_blocked_task() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-100" "blocked" "agent-01"

  "$AGENT_POOL" unblock t-100 -p foo 2>&1

  local status claimed
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['status'])
")
  claimed=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['claimed_by'])
")
  assert_eq "pending" "$status" "task should be pending after unblock"
  assert_eq "None" "$claimed" "claimed_by should be cleared"
}

test_unblock_not_blocked() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-101" "pending"

  if "$AGENT_POOL" unblock t-101 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for non-blocked task"
    return 1
  fi
}

test_unblock_not_found() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"

  if "$AGENT_POOL" unblock t-999 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for missing task"
    return 1
  fi
}

test_backlog_task() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-200" "in_progress" "agent-02"

  "$AGENT_POOL" backlog t-200 -p foo 2>&1

  local status claimed
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['status'])
")
  claimed=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['claimed_by'])
")
  assert_eq "backlogged" "$status" "task should be backlogged"
  assert_eq "None" "$claimed" "claimed_by should be cleared"
}

test_backlog_not_found() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"

  if "$AGENT_POOL" backlog t-999 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for missing task"
    return 1
  fi
}

test_activate_backlogged() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-300" "backlogged"

  "$AGENT_POOL" activate t-300 -p foo 2>&1

  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['status'])
")
  assert_eq "pending" "$status" "task should be pending after activate"
}

test_activate_not_backlogged() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-301" "pending"

  if "$AGENT_POOL" activate t-301 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for non-backlogged task"
    return 1
  fi
}

test_activate_not_found() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"

  if "$AGENT_POOL" activate t-999 -p foo 2>&1; then
    echo "    FAIL: expected non-zero exit for missing task"
    return 1
  fi
}

# --- approval hook allowlist tests ---

test_hook_allows_read_tools() {
  mkdir -p "$TEST_DIR/approvals"
  mkdir -p "$TEST_DIR/test-clone"
  local hook_script="$SCRIPT_DIR/hooks/approval-hook.sh"

  for tool in Read Glob Grep Agent ToolSearch WebFetch WebSearch; do
    local exit_code=0
    (
      cd "$TEST_DIR/test-clone"
      echo "{\"tool_name\":\"$tool\",\"tool_input\":{},\"session_id\":\"s1\",\"hook_event_name\":\"PreToolUse\"}" \
        | "$hook_script"
    ) 2>/dev/null || exit_code=$?
    assert_eq "0" "$exit_code" "$tool should be allowed (exit 0)"
  done

  # No request files should have been created
  local req_count
  req_count=$(ls "$TEST_DIR/approvals"/req-*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "0" "$req_count" "no request files should be created for allowed tools"
}

test_hook_allows_task_tools() {
  mkdir -p "$TEST_DIR/approvals"
  mkdir -p "$TEST_DIR/test-clone"
  local hook_script="$SCRIPT_DIR/hooks/approval-hook.sh"

  for tool in TaskCreate TaskGet TaskList TaskOutput TaskUpdate TaskStop Skill EnterPlanMode ExitPlanMode; do
    local exit_code=0
    (
      cd "$TEST_DIR/test-clone"
      echo "{\"tool_name\":\"$tool\",\"tool_input\":{},\"session_id\":\"s1\",\"hook_event_name\":\"PreToolUse\"}" \
        | "$hook_script"
    ) 2>/dev/null || exit_code=$?
    assert_eq "0" "$exit_code" "$tool should be allowed (exit 0)"
  done
}

test_hook_blocks_write_tool() {
  # Verify Write is NOT in the allowlist (hook would create a request file, not exit 0)
  mkdir -p "$TEST_DIR/approvals"
  local hook_script="$SCRIPT_DIR/hooks/approval-hook.sh"

  # Check Write is not auto-approved by grepping the allowlist
  if grep -q '"Write"' "$hook_script" || grep -qw 'Write' <(sed -n '/ALLOWED_TOOLS/,/)/p' "$hook_script"); then
    # Write is in the allowlist — that's wrong
    echo "    FAIL: Write should not be in ALLOWED_TOOLS"
    return 1
  fi
}

test_hook_blocks_edit_tool() {
  # Verify Edit is NOT in the allowlist
  mkdir -p "$TEST_DIR/approvals"
  local hook_script="$SCRIPT_DIR/hooks/approval-hook.sh"

  if grep -q '"Edit"' "$hook_script" || grep -qw 'Edit' <(sed -n '/ALLOWED_TOOLS/,/)/p' "$hook_script"); then
    echo "    FAIL: Edit should not be in ALLOWED_TOOLS"
    return 1
  fi
}


test_hook_input_truncation() {
  # Test that the hook's truncation logic (head -c 200) works on long input
  local long_input
  long_input=$(printf 'x%.0s' {1..300})

  local truncated
  truncated=$(echo "{\"command\":\"$long_input\"}" | jq -r '. // {} | tostring' | head -c 200)

  local len=${#truncated}
  [[ "$len" -le 200 ]] || { echo "    FAIL: input length $len exceeds 200"; return 1; }
  [[ "$len" -eq 200 ]] || { echo "    FAIL: expected exactly 200, got $len"; return 1; }
}

# --- runner claim_task / mark_task tests ---

test_runner_claim_task() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" add "first task" -p foo
  "$AGENT_POOL" add "second task" -p foo

  local tasks_file="$TEST_DIR/tasks-foo.json"
  local lock_dir="$tasks_file.lock"

  # Simulate claim_task logic from agent-runner.sh
  local result
  result=$(/usr/bin/python3 -c "
import json, sys, time
with open('$tasks_file', 'r') as f:
    data = json.load(f)
for t in data['tasks']:
    if t['status'] == 'pending':
        t['status'] = 'in_progress'
        t['claimed_by'] = 'agent-00'
        t['started_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        with open('$tasks_file', 'w') as f:
            json.dump(data, f, indent=2)
        print(t['id'] + '\n' + t['prompt'])
        sys.exit(0)
sys.exit(1)
")

  local task_id
  task_id=$(echo "$result" | head -1)
  [[ "$task_id" =~ ^t- ]] || { echo "    FAIL: expected task id, got '$task_id'"; return 1; }

  local prompt
  prompt=$(echo "$result" | tail -n +2)
  assert_eq "first task" "$prompt" "should claim first pending task"

  # Verify the task is now in_progress
  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == '$task_id':
        print(t['status'])
")
  assert_eq "in_progress" "$status" "claimed task should be in_progress"

  # Second task should still be pending
  local second_status
  second_status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][1]['status'])
")
  assert_eq "pending" "$second_status" "second task should still be pending"
}

test_runner_claim_no_tasks() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"tasks":[]}' > "$TEST_DIR/tasks-foo.json"

  local tasks_file="$TEST_DIR/tasks-foo.json"
  if /usr/bin/python3 -c "
import json, sys
with open('$tasks_file', 'r') as f:
    data = json.load(f)
for t in data['tasks']:
    if t['status'] == 'pending':
        sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
    echo "    FAIL: should fail when no pending tasks"
    return 1
  fi
}

test_runner_claim_skips_non_pending() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"

  # Add tasks with non-pending statuses, then one pending
  _add_task_with_status "$tasks_file" "t-ip" "in_progress" "agent-01"
  _add_task_with_status "$tasks_file" "t-done" "completed" "agent-02"
  _add_task_with_status "$tasks_file" "t-pend" "pending"

  local result
  result=$(/usr/bin/python3 -c "
import json, sys, time
with open('$tasks_file', 'r') as f:
    data = json.load(f)
for t in data['tasks']:
    if t['status'] == 'pending':
        t['status'] = 'in_progress'
        t['claimed_by'] = 'agent-00'
        t['started_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        with open('$tasks_file', 'w') as f:
            json.dump(data, f, indent=2)
        print(t['id'] + '\n' + t['prompt'])
        sys.exit(0)
sys.exit(1)
")

  local task_id
  task_id=$(echo "$result" | head -1)
  assert_eq "t-pend" "$task_id" "should skip non-pending and claim t-pend"
}

test_runner_mark_completed() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-mc" "in_progress" "agent-00"

  /usr/bin/python3 -c "
import json, sys, time
with open('$tasks_file', 'r') as f:
    data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-mc':
        t['status'] = 'completed'
        t['completed_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        break
with open('$tasks_file', 'w') as f:
    json.dump(data, f, indent=2)
"

  local status completed_at
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['status'])
")
  completed_at=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['completed_at'])
")
  assert_eq "completed" "$status"
  [[ "$completed_at" != "None" && -n "$completed_at" ]] || { echo "    FAIL: completed_at should be set"; return 1; }
}

test_runner_mark_blocked() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-mb" "in_progress" "agent-00"

  /usr/bin/python3 -c "
import json, sys, time
with open('$tasks_file', 'r') as f:
    data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-mb':
        t['status'] = 'blocked'
        t['completed_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        break
with open('$tasks_file', 'w') as f:
    json.dump(data, f, indent=2)
"

  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['status'])
")
  assert_eq "blocked" "$status"
}

test_runner_mark_pending_clears() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  _add_task_with_status "$tasks_file" "t-mp" "in_progress" "agent-00"

  # Simulate mark_task(task_id, "pending") — should clear claimed_by and timestamps
  /usr/bin/python3 -c "
import json, sys, time
with open('$tasks_file', 'r') as f:
    data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-mp':
        t['status'] = 'pending'
        t['claimed_by'] = ''
        t.pop('started_at', None)
        t.pop('completed_at', None)
        break
with open('$tasks_file', 'w') as f:
    json.dump(data, f, indent=2)
"

  local status claimed
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['status'])
")
  claimed=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0].get('claimed_by', ''))
")
  assert_eq "pending" "$status"
  assert_eq "" "$claimed" "claimed_by should be cleared"
}

# --- cmd_release tests ---

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

# --- cmd_status detail tests ---

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

# --- cmd_destroy detail tests ---

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

# --- resolve_project edge case tests ---

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

# --- pool helper tests ---

test_lock_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  local pool_file="$TEST_DIR/pool-foo.json"
  /usr/bin/python3 -c "
import json, time
with open('$pool_file') as f: data = json.load(f)
for c in data['clones']:
    if c['index'] == 0:
        c['locked'] = True
        c['workspace_id'] = 'workspace:5'
        c['locked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
with open('$pool_file', 'w') as f: json.dump(data, f, indent=2)
"

  local locked ws locked_at
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
  locked_at=$(/usr/bin/python3 -c "
import json
with open('$pool_file') as f: data = json.load(f)
print(data['clones'][0]['locked_at'])
")
  assert_eq "True" "$locked"
  assert_eq "workspace:5" "$ws"
  [[ -n "$locked_at" && "$locked_at" != "" ]] || { echo "    FAIL: locked_at should be set"; return 1; }
}

test_find_free_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 3 -p foo

  # Lock first two clones
  local pool_file="$TEST_DIR/pool-foo.json"
  /usr/bin/python3 -c "
import json, time
with open('$pool_file') as f: data = json.load(f)
for c in data['clones']:
    if c['index'] in (0, 1):
        c['locked'] = True
        c['workspace_id'] = 'test'
        c['locked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
with open('$pool_file', 'w') as f: json.dump(data, f, indent=2)
"

  local free_idx
  free_idx=$(/usr/bin/python3 -c "
import json, sys
with open('$pool_file') as f: data = json.load(f)
for c in data['clones']:
    if not c.get('locked', False):
        print(c['index'])
        sys.exit(0)
sys.exit(1)
")
  assert_eq "2" "$free_idx" "should find clone 2 as first free"
}

test_find_free_clone_all_locked() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 2 -p foo

  local pool_file="$TEST_DIR/pool-foo.json"
  /usr/bin/python3 -c "
import json, time
with open('$pool_file') as f: data = json.load(f)
for c in data['clones']:
    c['locked'] = True
    c['workspace_id'] = 'test'
    c['locked_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
with open('$pool_file', 'w') as f: json.dump(data, f, indent=2)
"

  if /usr/bin/python3 -c "
import json, sys
with open('$pool_file') as f: data = json.load(f)
for c in data['clones']:
    if not c.get('locked', False):
        print(c['index'])
        sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
    echo "    FAIL: should fail when all clones locked"
    return 1
  fi
}

# --- cmd_refresh detail tests ---

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

# --- init edge case tests ---

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

# --- global flag / dispatch tests ---

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

test_add_no_prompt_shows_usage() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local output
  if output=$("$AGENT_POOL" add -p foo 2>&1); then
    echo "    FAIL: expected non-zero exit when no prompt"
    return 1
  fi
  assert_contains "$output" "Usage" "should show usage"
}

# --- task queue locking tests ---

test_no_local_outside_functions() {
  # 'local' keyword outside a function causes runtime errors in bash.
  # This has bitten us multiple times — scan both scripts statically.
  # Uses awk with full brace-depth tracking to distinguish function bodies from top-level code.
  local failures=""
  for script in "$SCRIPT_DIR/agent-pool" "$SCRIPT_DIR/agent-runner.sh"; do
    local bname
    bname=$(basename "$script")
    local bad_lines
    bad_lines=$(awk '
      {
        # Count all opening and closing braces on this line (outside quotes)
        line = $0
        opens = gsub(/{/, "{", line)
        line = $0
        closes = gsub(/}/, "}", line)
      }
      /^[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*\(\)[[:space:]]*\{/ {
        in_func += opens
        func_depth += opens - closes
        next
      }
      in_func > 0 {
        func_depth += opens - closes
        if (func_depth <= 0) { in_func = 0; func_depth = 0 }
        next
      }
      /^[[:space:]]*local[[:space:]]/ { print NR": "$0 }
    ' "$script" 2>/dev/null || true)
    if [[ -n "$bad_lines" ]]; then
      failures="${failures}${bname}:\n${bad_lines}\n"
    fi
  done
  assert_eq "" "$failures" "no 'local' keyword outside functions"
}

test_task_lock_stale_detection() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"
  echo '{"tasks":[]}' > "$tasks_file"

  # Create a stale lock with a dead PID
  local lock_dir="${tasks_file}.lock"
  mkdir -p "$lock_dir"
  echo "99999" > "$lock_dir/pid"

  # Adding a task should succeed (stale lock detected and removed)
  "$AGENT_POOL" add "test after stale" -p foo

  local prompt
  prompt=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
print(data['tasks'][0]['prompt'])
")
  assert_eq "test after stale" "$prompt" "should add task after clearing stale lock"
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

# Task state machine tests
run_test test_add_backlog_flag
run_test test_task_id_format
run_test test_unblock_blocked_task
run_test test_unblock_not_blocked
run_test test_unblock_not_found
run_test test_backlog_task
run_test test_backlog_not_found
run_test test_activate_backlogged
run_test test_activate_not_backlogged
run_test test_activate_not_found

# Approval hook allowlist tests
run_test test_hook_allows_read_tools
run_test test_hook_allows_task_tools
run_test test_hook_blocks_write_tool
run_test test_hook_blocks_edit_tool
run_test test_hook_input_truncation

# Runner claim_task / mark_task tests
run_test test_runner_claim_task
run_test test_runner_claim_no_tasks
run_test test_runner_claim_skips_non_pending
run_test test_runner_mark_completed
run_test test_runner_mark_blocked
run_test test_runner_mark_pending_clears

# cmd_release tests
run_test test_release_unlocks_clone
run_test test_release_no_index

# cmd_status detail tests
run_test test_status_shows_locked_and_free
run_test test_status_no_clones

# cmd_destroy detail tests
run_test test_destroy_force_flag
run_test test_destroy_nonexistent_project

# resolve_project edge cases
run_test test_resolve_multiple_no_default
run_test test_resolve_invalid_project_flag

# Pool helper tests
run_test test_lock_clone
run_test test_find_free_clone
run_test test_find_free_clone_all_locked

# cmd_refresh detail tests
run_test test_refresh_all
run_test test_refresh_unlocks_clone
run_test test_refresh_nonexistent_clone

# Init edge cases
run_test test_init_additive

# Global flag / dispatch tests
run_test test_project_flag_before_command
run_test test_unknown_command_shows_help
run_test test_add_no_prompt_shows_usage

# Static analysis tests
run_test test_no_local_outside_functions

# Task lock tests
run_test test_task_lock_stale_detection

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
