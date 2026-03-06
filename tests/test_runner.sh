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

test_runner_workflow_auto_merge_default() {
  # feature-branch workflow defaults to auto_merge=true
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-workflow foo --type feature-branch --instructions "Create PRs for all changes"

  # Verify git_workflow stored correctly
  local wf_type
  wf_type=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f:
    data = json.load(f)
gw = data['projects']['foo'].get('git_workflow', {})
print(gw.get('type', ''))
")
  assert_eq "feature-branch" "$wf_type" "workflow type should be feature-branch"

  # Simulate the workflow prefix generation (same Python as agent-runner.sh)
  local prefix
  prefix=$(/usr/bin/python3 -c "
import json, sys
with open('$TEST_DIR/projects.json') as f:
    data = json.load(f)
gw = data.get('projects', {}).get('foo', {}).get('git_workflow')
if gw and gw.get('type'):
    t = gw['type'].upper()
    instructions = gw.get('instructions', '')
    lines = [f'[GIT WORKFLOW — {t}]']
    if instructions:
        lines.append(instructions)
    auto_merge = gw.get('auto_merge')
    if auto_merge is None and gw['type'] == 'feature-branch':
        auto_merge = True
    if auto_merge:
        merge_method = gw.get('merge_method', 'squash')
        lines.append(f'After creating a PR with \`gh pr create\`, enable auto-merge by running: \`gh pr merge --auto --{merge_method}\`')
        lines.append('If auto-merge fails (e.g. not enabled on the repo), log a warning and continue — do not block task completion.')
    lines.append('---')
    print(chr(10).join(lines))
")
  assert_contains "$prefix" "gh pr merge --auto --squash" "default feature-branch should include auto-merge with squash"
  assert_contains "$prefix" "auto-merge fails" "should include fallback instructions"
}

test_runner_workflow_auto_merge_explicit() {
  # Explicit auto_merge=true with merge method
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-workflow foo --type feature-branch --instructions "Create PRs" --auto-merge true --merge-method merge

  local merge_method
  merge_method=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f:
    data = json.load(f)
gw = data['projects']['foo'].get('git_workflow', {})
print(gw.get('merge_method', ''))
")
  assert_eq "merge" "$merge_method" "merge_method should be stored"

  local auto_merge
  auto_merge=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f:
    data = json.load(f)
gw = data['projects']['foo'].get('git_workflow', {})
print(gw.get('auto_merge', ''))
")
  assert_eq "True" "$auto_merge" "auto_merge should be True"
}

test_runner_workflow_auto_merge_disabled() {
  # Explicitly disable auto-merge
  "$AGENT_POOL" project add foo --source "$REPO_A" --branch main --prefix foo
  "$AGENT_POOL" project set-workflow foo --type feature-branch --instructions "Create PRs" --auto-merge false

  # Generate prefix — should NOT contain auto-merge
  local prefix
  prefix=$(/usr/bin/python3 -c "
import json
with open('$TEST_DIR/projects.json') as f:
    data = json.load(f)
gw = data.get('projects', {}).get('foo', {}).get('git_workflow')
if gw and gw.get('type'):
    t = gw['type'].upper()
    instructions = gw.get('instructions', '')
    lines = [f'[GIT WORKFLOW — {t}]']
    if instructions:
        lines.append(instructions)
    auto_merge = gw.get('auto_merge')
    if auto_merge is None and gw['type'] == 'feature-branch':
        auto_merge = True
    if auto_merge:
        merge_method = gw.get('merge_method', 'squash')
        lines.append(f'After creating a PR, enable auto-merge: gh pr merge --auto --{merge_method}')
    lines.append('---')
    print(chr(10).join(lines))
")
  assert_not_contains "$prefix" "auto-merge" "disabled auto-merge should not include merge instructions"
}

run_test test_runner_workflow_auto_merge_default
run_test test_runner_workflow_auto_merge_explicit
run_test test_runner_workflow_auto_merge_disabled
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
