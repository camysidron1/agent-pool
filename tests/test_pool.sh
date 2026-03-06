# Pool helper unit tests

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

test_next_index_empty() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  echo '{"clones":[]}' > "$TEST_DIR/pool-foo.json"

  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  local idx
  idx=$(next_index "$TEST_DIR/pool-foo.json")
  assert_eq "-1" "$idx"
}

test_next_index_with_clones() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 3 -p foo

  local idx
  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  idx=$(next_index "$TEST_DIR/pool-foo.json")
  assert_eq "2" "$idx"
}

test_add_clone_entry() {
  echo '{"clones":[{"index":0,"locked":false,"workspace_id":"","locked_at":"","branch":"main"},{"index":2,"locked":false,"workspace_id":"","locked_at":"","branch":"main"}]}' > "$TEST_DIR/pool-test.json"

  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  add_clone_entry "$TEST_DIR/pool-test.json" 1 "main"

  local count indexes
  count=$(/usr/bin/python3 -c "import json; print(len(json.load(open('$TEST_DIR/pool-test.json'))['clones']))")
  assert_eq "3" "$count"
  indexes=$(/usr/bin/python3 -c "
import json
data = json.load(open('$TEST_DIR/pool-test.json'))
print(','.join(str(c['index']) for c in data['clones']))
")
  assert_eq "0,1,2" "$indexes" "entries should be sorted"
}

test_remove_clone_entry() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 3 -p foo

  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  remove_clone_entry "$TEST_DIR/pool-foo.json" 1

  local indexes
  indexes=$(/usr/bin/python3 -c "
import json
data = json.load(open('$TEST_DIR/pool-foo.json'))
print(','.join(str(c['index']) for c in data['clones']))
")
  assert_eq "0,2" "$indexes"
}

test_unlock_clone() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  lock_clone "$TEST_DIR/pool-foo.json" 0 "test-ws"
  unlock_clone "$TEST_DIR/pool-foo.json" 0

  local locked ws
  locked=$(/usr/bin/python3 -c "import json; print(json.load(open('$TEST_DIR/pool-foo.json'))['clones'][0]['locked'])")
  assert_eq "False" "$locked"
  ws=$(/usr/bin/python3 -c "import json; print(json.load(open('$TEST_DIR/pool-foo.json'))['clones'][0]['workspace_id'])")
  assert_eq "" "$ws"
}

test_cleanup_stale_locks_no_cmux() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" init 1 -p foo

  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  lock_clone "$TEST_DIR/pool-foo.json" 0 "workspace:999"
  cleanup_stale_locks "$TEST_DIR/pool-foo.json" 2>/dev/null || true

  local locked
  locked=$(/usr/bin/python3 -c "import json; print(json.load(open('$TEST_DIR/pool-foo.json'))['clones'][0]['locked'])")
  assert_eq "False" "$locked" "stale workspace lock should be cleaned"
}

test_ensure_pool_json_creates_file() {
  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  local pool_file="$TEST_DIR/pool-new.json"
  [[ ! -f "$pool_file" ]] || { echo "    FAIL: file should not exist yet"; return 1; }
  ensure_pool_json "$pool_file"
  assert_file_exists "$pool_file"
  local content
  content=$(cat "$pool_file")
  assert_eq '{"clones":[]}' "$content" "should create empty pool"
}

test_next_index_with_gaps() {
  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  echo '{"clones":[{"index":0,"locked":false,"workspace_id":"","locked_at":"","branch":"main"},{"index":5,"locked":false,"workspace_id":"","locked_at":"","branch":"main"}]}' > "$TEST_DIR/pool-gap.json"
  local idx
  idx=$(next_index "$TEST_DIR/pool-gap.json")
  assert_eq "5" "$idx" "max index should be 5"
}

test_get_clone_path_formatting() {
  source "$SCRIPT_DIR/lib/project.sh"
  source "$SCRIPT_DIR/lib/pool.sh"
  local path
  path=$(get_clone_path "nebari" "3")
  assert_contains "$path" "nebari-03" "path should have zero-padded index"
}

run_test test_lock_clone
run_test test_find_free_clone
run_test test_find_free_clone_all_locked
run_test test_next_index_empty
run_test test_next_index_with_clones
run_test test_add_clone_entry
run_test test_remove_clone_entry
run_test test_unlock_clone
run_test test_cleanup_stale_locks_no_cmux
run_test test_ensure_pool_json_creates_file
run_test test_next_index_with_gaps
run_test test_get_clone_path_formatting
