# lib/cmd/status.sh — Pool status display

cmd_status() {
  local proj
  proj=$(resolve_project)
  local pool_file prefix
  pool_file=$(get_pool_json_path "$proj")
  prefix=$(get_clone_prefix "$proj")

  ensure_pool_json "$pool_file"
  cleanup_stale_locks "$pool_file" 2>/dev/null || true

  printf "Project: %s\n" "$proj"
  printf "%-8s %-12s %-20s %-10s\n" "Clone" "Status" "Branch" "Workspace"
  printf "%-8s %-12s %-20s %-10s\n" "-----" "------" "------" "---------"

  read_pool "$pool_file" | /usr/bin/python3 -c "
import json, sys, os
data = json.load(sys.stdin)
pool_dir = sys.argv[1]
prefix = sys.argv[2]
if not data['clones']:
    print('  (no clones — run agent-pool init -p <project>)')
    sys.exit(0)
for c in data['clones']:
    idx = f\"{c['index']:02d}\"
    status = 'LOCKED' if c.get('locked') else 'free'
    clone_path = os.path.join(pool_dir, f'{prefix}-{idx}')
    try:
        import subprocess
        branch = subprocess.check_output(
            ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
            cwd=clone_path, stderr=subprocess.DEVNULL
        ).decode().strip()
    except:
        branch = c.get('branch', '?')
    ws = c.get('workspace_id', '') or '-'
    print(f'{idx:<8} {status:<12} {branch:<20} {ws}')
" "$DATA_DIR" "$prefix"
}
