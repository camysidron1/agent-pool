#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$TESTS_DIR/helpers.sh"

printf "\n\033[1;34m=== agent-pool multi-project test suite ===\033[0m\n\n"

if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    printf "\n--- %s ---\n" "$arg"
    source "$TESTS_DIR/$arg"
  done
else
  for test_file in "$TESTS_DIR"/test_*.sh; do
    printf "\n--- %s ---\n" "$(basename "$test_file")"
    source "$test_file"
  done
fi

print_results
