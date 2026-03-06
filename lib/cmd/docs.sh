# lib/cmd/docs.sh — Documentation viewer

cmd_docs() {
  local target="${1:-}"
  local docs_dir="$DATA_DIR/docs"

  if [[ ! -d "$docs_dir" ]]; then
    echo "No docs directory yet. Docs are created when agents run."
    return
  fi

  if [[ -z "$target" ]]; then
    # List all agent doc directories and shared
    printf "%-20s %-8s %s\n" "Directory" "Files" "Last Modified"
    printf "%-20s %-8s %s\n" "---------" "-----" "-------------"

    _docs_dir_info() {
      local dir="$1" label="$2"
      local count last_mod
      count=$(find "$dir" -maxdepth 1 -type f | wc -l | tr -d ' ')
      # Portable last-modified: try GNU stat, then macOS stat
      last_mod=$(find "$dir" -maxdepth 1 -type f -exec stat -c '%Y' {} + 2>/dev/null \
              || find "$dir" -maxdepth 1 -type f -exec stat -f '%m' {} + 2>/dev/null \
              || true)
      last_mod=$(echo "$last_mod" | sort -rn | head -1)
      if [[ -n "$last_mod" ]]; then
        last_mod=$(date -d "@$last_mod" '+%Y-%m-%d %H:%M' 2>/dev/null \
                || date -r "$last_mod" '+%Y-%m-%d %H:%M' 2>/dev/null \
                || echo "-")
      else
        last_mod="-"
      fi
      printf "%-20s %-8s %s\n" "$label" "$count" "$last_mod"
    }

    if [[ -d "$docs_dir/shared" ]]; then
      _docs_dir_info "$docs_dir/shared" "shared"
    fi

    if [[ -d "$docs_dir/agents" ]]; then
      for agent_dir in "$docs_dir/agents"/*/; do
        [[ -d "$agent_dir" ]] || continue
        _docs_dir_info "$agent_dir" "$(basename "$agent_dir")"
      done
    fi
  elif [[ "$target" == "shared" ]]; then
    local target_dir="$docs_dir/shared"
    if [[ ! -d "$target_dir" ]]; then
      echo "No shared docs yet."
      return
    fi
    printf "Shared docs (%s):\n\n" "$target_dir"
    local found=false
    for f in "$target_dir"/*; do
      [[ -f "$f" ]] || continue
      found=true
      local fname
      fname=$(basename "$f")
      if [[ "$fname" == *.md ]]; then
        printf "=== %s ===\n" "$fname"
        cat "$f"
        printf "\n"
      else
        printf "  %s\n" "$fname"
      fi
    done
    if [[ "$found" == false ]]; then
      echo "  (empty)"
    fi
  else
    local target_dir="$docs_dir/agents/$target"
    if [[ ! -d "$target_dir" ]]; then
      echo "No docs for agent '$target'."
      return
    fi
    printf "Docs for %s (%s):\n\n" "$target" "$target_dir"
    local found=false
    for f in "$target_dir"/*; do
      [[ -f "$f" ]] || continue
      found=true
      local fname
      fname=$(basename "$f")
      if [[ "$fname" == *.md ]]; then
        printf "=== %s ===\n" "$fname"
        cat "$f"
        printf "\n"
      else
        printf "  %s\n" "$fname"
      fi
    done
    if [[ "$found" == false ]]; then
      echo "  (empty)"
    fi
  fi
}
