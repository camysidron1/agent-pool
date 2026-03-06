# Static analysis tests

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

run_test test_no_local_outside_functions
