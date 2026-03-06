# lib/cmd/approvals.sh — Approval workflow commands

cmd_approvals() {
  local approvals_dir="$DATA_DIR/approvals"
  mkdir -p "$approvals_dir"

  local found=false
  local now
  now=$(date +%s)

  printf "\033[1m%-28s %-10s %-12s %-40s %s\033[0m\n" "ID" "Agent" "Tool" "Input" "Age"
  printf "%-28s %-10s %-12s %-40s %s\n" "---" "-----" "----" "-----" "---"

  for f in "$approvals_dir"/req-*.json; do
    [[ -f "$f" ]] || continue
    local status
    status=$(jq -r '.status' "$f" 2>/dev/null) || continue
    [[ "$status" == "pending" ]] || continue
    found=true

    local id agent tool input ts
    id=$(jq -r '.id' "$f")
    agent=$(jq -r '.agent' "$f")
    tool=$(jq -r '.tool' "$f")
    input=$(jq -r '.input' "$f" | head -c 40)
    ts=$(jq -r '.timestamp' "$f")

    # Calculate age
    local req_epoch age_str
    req_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null || echo "$now")
    local age_s=$(( now - req_epoch ))
    if [[ $age_s -lt 60 ]]; then
      age_str="${age_s}s"
    elif [[ $age_s -lt 3600 ]]; then
      age_str="$(( age_s / 60 ))m"
    else
      age_str="$(( age_s / 3600 ))h"
    fi

    printf "%-28s %-10s %-12s %-40s %s\n" "$id" "$agent" "$tool" "$input" "$age_str"
  done

  if [[ "$found" == false ]]; then
    echo "No pending approval requests."
  fi
}

cmd_approve() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    echo "Usage: agent-pool approve <request-id|--all>"
    exit 1
  fi

  local approvals_dir="$DATA_DIR/approvals"
  mkdir -p "$approvals_dir"
  local decided_at
  decided_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  if [[ "$target" == "--all" ]]; then
    local count=0
    for f in "$approvals_dir"/req-*.json; do
      [[ -f "$f" ]] || continue
      local status
      status=$(jq -r '.status' "$f" 2>/dev/null) || continue
      [[ "$status" == "pending" ]] || continue
      jq --arg da "$decided_at" '.status = "approved" | .decided_at = $da' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      count=$((count + 1))
    done
    echo "Approved $count pending request(s)."
  else
    local req_file="$approvals_dir/${target}.json"
    if [[ ! -f "$req_file" ]]; then
      echo "Error: request '$target' not found." >&2
      exit 1
    fi
    jq --arg da "$decided_at" '.status = "approved" | .decided_at = $da' "$req_file" > "$req_file.tmp" && mv "$req_file.tmp" "$req_file"
    echo "Approved $target."
  fi
}

cmd_deny() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    echo "Usage: agent-pool deny <request-id>"
    exit 1
  fi

  local approvals_dir="$DATA_DIR/approvals"
  mkdir -p "$approvals_dir"
  local decided_at
  decided_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local req_file="$approvals_dir/${target}.json"
  if [[ ! -f "$req_file" ]]; then
    echo "Error: request '$target' not found." >&2
    exit 1
  fi
  jq --arg da "$decided_at" '.status = "denied" | .decided_at = $da' "$req_file" > "$req_file.tmp" && mv "$req_file.tmp" "$req_file"
  echo "Denied $target."
}

cmd_watch() {
  local approvals_dir="$DATA_DIR/approvals"
  mkdir -p "$approvals_dir"
  local interval="${1:-2}"
  local seen_file="$approvals_dir/.watch-seen.$$"
  trap 'rm -f "$seen_file"' EXIT

  touch "$seen_file"
  printf "\033[1mWatching for approval requests...\033[0m (Ctrl+C to stop)\n\n"

  while true; do
    local has_pending=false
    for f in "$approvals_dir"/req-*.json; do
      [[ -f "$f" ]] || continue
      local status
      status=$(jq -r '.status' "$f" 2>/dev/null) || continue
      [[ "$status" == "pending" ]] || continue

      local req_id
      req_id=$(basename "$f" .json)

      # Skip if already seen
      if grep -qxF "$req_id" "$seen_file" 2>/dev/null; then
        has_pending=true
        continue
      fi

      # New request — display it
      has_pending=true
      echo "$req_id" >> "$seen_file"

      local agent tool input ts
      agent=$(jq -r '.agent' "$f")
      tool=$(jq -r '.tool' "$f")
      input=$(jq -r '.input' "$f" | head -c 80)
      ts=$(jq -r '.timestamp' "$f")

      printf "\033[1;33m>>> NEW APPROVAL REQUEST\033[0m [%s]\n" "$ts"
      printf "    ID:    %s\n" "$req_id"
      printf "    Agent: \033[1;36m%s\033[0m\n" "$agent"
      printf "    Tool:  \033[1m%s\033[0m\n" "$tool"
      printf "    Input: %s\n" "$input"
      printf "    → \033[1magent-pool approve %s\033[0m  or  \033[1magent-pool approve --all\033[0m\n\n" "$req_id"

      # Also send bell to this terminal
      printf '\a'
    done

    # Clean seen entries for requests that no longer exist
    if [[ -s "$seen_file" ]]; then
      local tmp_seen="$seen_file.tmp"
      while IFS= read -r rid; do
        [[ -f "$approvals_dir/${rid}.json" ]] && echo "$rid"
      done < "$seen_file" > "$tmp_seen" 2>/dev/null || true
      mv "$tmp_seen" "$seen_file"
    fi

    sleep "$interval"
  done
}
