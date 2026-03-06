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

run_test test_lock_clone
run_test test_find_free_clone
run_test test_find_free_clone_all_locked
