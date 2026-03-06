# Docs command tests

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

run_test test_docs_empty
run_test test_docs_list
run_test test_docs_agent
run_test test_docs_shared
run_test test_docs_agent_not_found
