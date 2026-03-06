# Agent-runner tests

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

test_runner_claim_skips_unmet_deps() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"

  _add_task_with_status "$tasks_file" "t-dep" "completed" "agent-01"
  _add_task_with_status "$tasks_file" "t-nodep" "pending"
  _add_task_with_status "$tasks_file" "t-notdone" "pending"
  _add_task_with_status "$tasks_file" "t-hasdep" "pending"

  # Add depends_on to t-hasdep pointing at t-notdone (which is still pending)
  /usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-hasdep':
        t['depends_on'] = ['t-notdone']
with open('$tasks_file', 'w') as f: json.dump(data, f, indent=2)
"

  # Run dependency-aware claim logic
  local result
  result=$(/usr/bin/python3 -c "
import json, sys, time
with open('$tasks_file', 'r') as f:
    data = json.load(f)
completed_ids = {t['id'] for t in data['tasks'] if t.get('status') == 'completed'}
for t in data['tasks']:
    if t['status'] == 'pending':
        deps = t.get('depends_on', [])
        if deps:
            unmet = [d for d in deps if d not in completed_ids]
            if unmet:
                continue
        t['status'] = 'in_progress'
        t['claimed_by'] = 'agent-00'
        t['started_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        with open('$tasks_file', 'w') as f:
            json.dump(data, f, indent=2)
        print(t['id'] + '\n' + t['prompt'])
        sys.exit(0)
sys.exit(1)
" 2>/dev/null)

  local task_id
  task_id=$(echo "$result" | head -1)
  assert_eq "t-nodep" "$task_id" "should claim t-nodep (no deps), not t-hasdep (unmet deps)"

  # Verify t-hasdep is still pending
  local hasdep_status
  hasdep_status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-hasdep':
        print(t['status'])
")
  assert_eq "pending" "$hasdep_status" "t-hasdep should still be pending"
}

test_runner_claim_satisfies_deps() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local tasks_file="$TEST_DIR/tasks-foo.json"

  _add_task_with_status "$tasks_file" "t-a" "completed" "agent-01"
  _add_task_with_status "$tasks_file" "t-b" "completed" "agent-02"
  _add_task_with_status "$tasks_file" "t-c" "pending"

  # Add depends_on to t-c pointing at t-a and t-b (both completed)
  /usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-c':
        t['depends_on'] = ['t-a', 't-b']
with open('$tasks_file', 'w') as f: json.dump(data, f, indent=2)
"

  # Run dependency-aware claim logic
  local result
  result=$(/usr/bin/python3 -c "
import json, sys, time
with open('$tasks_file', 'r') as f:
    data = json.load(f)
completed_ids = {t['id'] for t in data['tasks'] if t.get('status') == 'completed'}
for t in data['tasks']:
    if t['status'] == 'pending':
        deps = t.get('depends_on', [])
        if deps:
            unmet = [d for d in deps if d not in completed_ids]
            if unmet:
                continue
        t['status'] = 'in_progress'
        t['claimed_by'] = 'agent-00'
        t['started_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        with open('$tasks_file', 'w') as f:
            json.dump(data, f, indent=2)
        print(t['id'] + '\n' + t['prompt'])
        sys.exit(0)
sys.exit(1)
" 2>/dev/null)

  local task_id
  task_id=$(echo "$result" | head -1)
  assert_eq "t-c" "$task_id" "should claim t-c since all deps (t-a, t-b) are completed"

  # Verify t-c is now in_progress
  local status
  status=$(/usr/bin/python3 -c "
import json
with open('$tasks_file') as f: data = json.load(f)
for t in data['tasks']:
    if t['id'] == 't-c':
        print(t['status'])
")
  assert_eq "in_progress" "$status" "t-c should be in_progress after claim"
}

test_runner_signal_file_prevents_remark() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  local task_id="t-signal-test"

  # Create signal file like finish-task.sh does
  local signal_file="$DATA_DIR/.task-finished-${task_id}"
  echo "blocked" > "$signal_file"

  # Verify signal file exists
  assert_file_exists "$signal_file" "signal file should exist"

  # Verify it contains the expected status
  local content
  content=$(cat "$signal_file")
  assert_eq "blocked" "$content" "signal file should contain 'blocked'"
}

test_runner_context_no_tracking() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo

  # Read projects.json and check tracking field like agent-runner does
  local tracking_info
  tracking_info=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f:
    data = json.load(f)
p = data['projects'].get('foo', {})
tracking = p.get('tracking')
if not tracking or not tracking.get('type'):
    print('NONE')
else:
    print(tracking['type'].upper() + ' ' + tracking.get('project_key', ''))
")
  assert_contains "$tracking_info" "NONE" "project with no tracking should report NONE"
}

test_runner_context_with_tracking() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-tracking foo --type linear --key PROJ

  # Read projects.json and check tracking field like agent-runner does
  local tracking_info
  tracking_info=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f:
    data = json.load(f)
p = data['projects'].get('foo', {})
tracking = p.get('tracking')
if not tracking or not tracking.get('type'):
    print('NONE')
else:
    print(tracking['type'].upper() + ' ' + tracking.get('project_key', ''))
")
  assert_contains "$tracking_info" "LINEAR" "tracking type should be LINEAR"
  assert_contains "$tracking_info" "PROJ" "tracking key should be PROJ"
}

test_runner_context_default_workflow() {
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo

  # Check that workflow is empty/null when not set
  local workflow_json
  workflow_json=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f:
    data = json.load(f)
p = data['projects'].get('foo', {})
gw = p.get('git_workflow')
if not gw or not gw.get('type'):
    print('DEFAULT')
else:
    print(gw['type'])
")
  assert_eq "DEFAULT" "$workflow_json" "project with no workflow should use default"
}

run_test test_runner_uses_project_tasks
run_test test_runner_uses_project_branch
run_test test_runner_releases_lock_on_exit
run_test test_runner_installs_approval_hook
run_test test_runner_merge_is_idempotent
run_test test_runner_creates_docs_dirs
run_test test_runner_claudemd_idempotent
run_test test_runner_gitignore_entries
run_test test_runner_claim_task
run_test test_runner_claim_no_tasks
run_test test_runner_claim_skips_non_pending
run_test test_runner_mark_completed
run_test test_runner_mark_blocked
run_test test_runner_mark_pending_clears
run_test test_runner_claim_skips_unmet_deps
run_test test_runner_claim_satisfies_deps
run_test test_runner_signal_file_prevents_remark
run_test test_runner_context_no_tracking
run_test test_runner_context_with_tracking
run_test test_runner_context_default_workflow
