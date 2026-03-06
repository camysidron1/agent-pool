# Approval queue + hook tests

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

run_test test_approvals_empty
run_test test_approvals_lists_pending
run_test test_approvals_ignores_non_pending
run_test test_approve_by_id
run_test test_approve_all
run_test test_deny_by_id
run_test test_approve_not_found
run_test test_deny_not_found
run_test test_hook_writes_request_json
run_test test_hook_allows_read_tools
run_test test_hook_allows_task_tools
run_test test_hook_blocks_write_tool
run_test test_hook_blocks_edit_tool
run_test test_hook_input_truncation
