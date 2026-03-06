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

run_test test_restart_unknown_option
run_test test_restart_nonexistent_clone
run_test test_restart_no_clones
run_test test_restart_here_detection_regex
run_test test_restart_here_detection_nested
run_test test_restart_here_detection_fails
run_test test_restart_all_empty_pool
