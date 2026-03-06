# Shared test infrastructure for agent-pool test suite
# Sourced by run-all.sh and individual test files

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$TESTS_DIR/.." && pwd)"
AGENT_POOL="$SCRIPT_DIR/agent-pool"
AGENT_RUNNER="$SCRIPT_DIR/agent-runner.sh"

# --- counters ---

TESTS_RUN=${TESTS_RUN:-0}
TESTS_PASSED=${TESTS_PASSED:-0}
TESTS_FAILED=${TESTS_FAILED:-0}
FAILED_NAMES=("${FAILED_NAMES[@]+"${FAILED_NAMES[@]}"}")

# --- setup / teardown ---

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

assert_json_array_length() {
  local file="$1" key="$2" expected="$3" msg="${4:-}"
  local actual
  actual=$(/usr/bin/python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
keys = sys.argv[2].split('.')
obj = data
for k in keys:
    if isinstance(obj, dict):
        obj = obj.get(k, [])
    else:
        obj = []
        break
print(len(obj) if isinstance(obj, list) else 0)
" "$file" "$key")
  if [[ "$actual" != "$expected" ]]; then
    echo "    FAIL: ${msg:-$file.$key expected length $expected, got $actual}"
    return 1
  fi
}

# --- test runner ---

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

# --- shared helpers ---

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

# --- results printer ---

print_results() {
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
}
