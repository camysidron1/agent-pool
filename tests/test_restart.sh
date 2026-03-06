# Restart command tests
# Tests option parsing, error cases, and clone detection regex.
# Does NOT invoke cmux — focuses on testable logic paths.

test_restart_unknown_option() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local output rc=0
  output=$("$AGENT_POOL" restart --invalid -p foo 2>&1) || rc=$?
  [[ $rc -ne 0 ]] || {
    echo "    FAIL: expected non-zero exit for unknown option"
    return 1
  }
  assert_contains "$output" "Unknown option"
}

test_restart_nonexistent_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo
  local output rc=0
  output=$("$AGENT_POOL" restart 99 -p foo 2>&1) || rc=$?
  [[ $rc -ne 0 ]] || {
    echo "    FAIL: expected non-zero exit for nonexistent clone 99"
    return 1
  }
  assert_contains "$output" "does not exist"
}

test_restart_no_clones() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"clones":[]}' > "$TEST_DIR/pool-foo.json"
  local output
  output=$("$AGENT_POOL" restart -p foo 2>&1)
  assert_contains "$output" "No clones to restart"
}

test_restart_here_detection_regex() {
  # Test the Python regex that extracts clone index from a path
  local idx
  idx=$(/usr/bin/python3 -c "
import re, sys
cwd = sys.argv[1]
prefix = sys.argv[2]
m = re.search(r'/' + re.escape(prefix) + r'-(\d+)(?:/|$)', cwd)
if m: print(int(m.group(1)))
else: sys.exit(1)
" "$TEST_DIR/foo-05" "foo")
  assert_eq "5" "$idx"
}

test_restart_here_detection_nested() {
  # Regex should match prefix-NN even with subdirectories after it
  local idx
  idx=$(/usr/bin/python3 -c "
import re, sys
cwd = sys.argv[1]
prefix = sys.argv[2]
m = re.search(r'/' + re.escape(prefix) + r'-(\d+)(?:/|$)', cwd)
if m: print(int(m.group(1)))
else: sys.exit(1)
" "$TEST_DIR/foo-03/subdir" "foo")
  assert_eq "3" "$idx"
}

test_restart_here_detection_fails() {
  # Regex should fail when path doesn't contain the prefix pattern
  local rc=0
  /usr/bin/python3 -c "
import re, sys
cwd = sys.argv[1]
prefix = sys.argv[2]
m = re.search(r'/' + re.escape(prefix) + r'-(\d+)(?:/|$)', cwd)
if m: print(int(m.group(1)))
else: sys.exit(1)
" "$TEST_DIR/unrelated/path" "foo" 2>/dev/null || rc=$?
  [[ $rc -ne 0 ]] || {
    echo "    FAIL: expected non-zero exit for non-matching path"
    return 1
  }
}

test_restart_all_empty_pool() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"clones":[]}' > "$TEST_DIR/pool-foo.json"
  local output
  output=$("$AGENT_POOL" restart -p foo 2>&1)
  assert_contains "$output" "No clones to restart"
}

test_restart_single_refreshes_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  # Create a dirty file
  echo "dirty" > "$TEST_DIR/foo-00/dirty.txt"

  # Restart will fail to find cmux pane but still refreshes
  local output
  output=$("$AGENT_POOL" restart 0 -p foo 2>&1) || true

  # Dirty file should be cleaned by refresh_one
  [[ ! -f "$TEST_DIR/foo-00/dirty.txt" ]] || { echo "    FAIL: dirty file should be cleaned by refresh"; return 1; }
}

test_restart_single_prints_fallback() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  local output
  output=$("$AGENT_POOL" restart 0 -p foo 2>&1) || true

  # Should contain fallback instruction since cmux isn't available
  assert_contains "$output" "Run manually" "should show manual run command when cmux unavailable"
}

test_restart_here_regex_multi_digit() {
  local idx
  idx=$(/usr/bin/python3 -c "
import re, sys
cwd = sys.argv[1]
prefix = sys.argv[2]
m = re.search(r'/' + re.escape(prefix) + r'-(\d+)(?:/|$)', cwd)
if m: print(int(m.group(1)))
else: sys.exit(1)
" "$TEST_DIR/nebari-12" "nebari")
  assert_eq "12" "$idx" "should match double-digit index"
}

test_restart_here_regex_with_dots_in_prefix() {
  local idx
  idx=$(/usr/bin/python3 -c "
import re, sys
cwd = sys.argv[1]
prefix = sys.argv[2]
m = re.search(r'/' + re.escape(prefix) + r'-(\d+)(?:/|$)', cwd)
if m: print(int(m.group(1)))
else: sys.exit(1)
" "$TEST_DIR/my.proj-07" "my.proj")
  assert_eq "7" "$idx" "should handle dots in prefix via re.escape"
}

test_restart_all_grouping() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 4 -p foo
  local pool_file="$TEST_DIR/pool-foo.json"

  # Lock clones into two workspaces
  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  lock_clone "$pool_file" 0 "ws-A"
  lock_clone "$pool_file" 1 "ws-A"
  lock_clone "$pool_file" 2 "ws-B"
  lock_clone "$pool_file" 3 "ws-B"

  # Test the grouping logic from _restart_all
  local grouped
  grouped=$(read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys
from collections import OrderedDict
data = json.load(sys.stdin)
groups = OrderedDict()
for c in data['clones']:
    ws = c.get('workspace_id', '') or '__none__'
    groups.setdefault(ws, []).append(str(c['index']))
for ws, idxs in groups.items():
    print(ws + '|' + ','.join(idxs))
")

  # Should have two groups
  local group_count
  group_count=$(echo "$grouped" | wc -l | tr -d ' ')
  assert_eq "2" "$group_count" "should have 2 workspace groups"
  assert_contains "$grouped" "ws-A|0,1" "group A should have clones 0,1"
  assert_contains "$grouped" "ws-B|2,3" "group B should have clones 2,3"
}

run_test test_restart_unknown_option
run_test test_restart_nonexistent_clone
run_test test_restart_no_clones
run_test test_restart_here_detection_regex
run_test test_restart_here_detection_nested
run_test test_restart_here_detection_fails
run_test test_restart_all_empty_pool
run_test test_restart_single_refreshes_clone
run_test test_restart_single_prints_fallback
run_test test_restart_here_regex_multi_digit
run_test test_restart_here_regex_with_dots_in_prefix
run_test test_restart_all_grouping
