# lib/cmd/review.sh — Periodic review agent command

cmd_review() {
  local commits=20 mode="commits" auto=false
  while [[ $# -gt 0 ]]; do
    case $1 in
      --commits) commits="$2"; shift 2 ;;
      --branches) mode="branches"; shift ;;
      --auto) auto=true; shift ;;
      --help|-h)
        cat <<'USAGE'
Usage: agent-pool review [options]

Dispatch a review agent to assess recent work quality.

Options:
  --commits N     Number of recent commits to review (default: 20)
  --branches      Review open agent branches instead of recent commits
  --auto          Flag for cron-based automation (marks task as auto-review)
  -p PROJECT      Specify project (or uses default)

The review agent examines recent changes and produces a quality report
covering patterns, regressions, and suggestions.

Automation tip:
  To run periodic reviews via cron, add something like:
    0 */4 * * * cd /path/to/repo && agent-pool review --auto
  (Requires agents to be running to pick up the task.)
USAGE
        return 0
        ;;
      *) echo "Unknown option: $1"; echo "Run 'agent-pool review --help' for usage."; exit 1 ;;
    esac
  done

  local proj
  proj=$(resolve_project)
  local tasks_file
  tasks_file=$(get_tasks_json_path "$proj")

  local timestamp
  timestamp=$(date '+%Y%m%d-%H%M%S')

  local prompt
  if [[ "$mode" == "branches" ]]; then
    prompt="$(cat <<PROMPT
You are a code review agent. Review open agent branches for quality and coherence.

## Steps

1. List branches matching the \`agent-*\` pattern:
   git branch -r --list 'origin/agent-*' | head -30

2. For each active branch, review its diff against the base branch:
   git log main..BRANCH --oneline
   git diff main...BRANCH --stat
   git diff main...BRANCH

3. Look for:
   - Code duplication across branches
   - Conflicting changes between branches
   - Regressions or broken patterns
   - Inconsistent style or conventions
   - Incomplete or dead code

4. Write your report to agent-docs/review-${timestamp}.md with:
   - **Overall Assessment**: Summary of branch quality
   - **Branch-by-Branch**: Key findings per branch
   - **Concerning Patterns**: Code duplication, regressions, inconsistencies
   - **Suggestions**: Follow-up work or fixes needed
   - **Quality Score**: 1-5 with justification
     (1=critical issues, 2=significant concerns, 3=acceptable, 4=good, 5=excellent)

5. Finish with: /finish done "Review complete: agent-docs/review-${timestamp}.md"
PROMPT
)"
  else
    prompt="$(cat <<PROMPT
You are a code review agent. Review the ${commits} most recent commits for quality and coherence.

## Steps

1. Get recent commit history:
   git log --oneline -${commits}

2. For each commit, examine the changes:
   git show <sha> --stat
   git show <sha>

3. Analyze the changes looking for:
   - Code quality issues (duplication, complexity, poor naming)
   - Potential regressions or bugs introduced
   - Inconsistencies between commits (conflicting approaches)
   - Missing tests for significant changes
   - Style or convention violations

4. Write your report to agent-docs/review-${timestamp}.md with:
   - **Overall Assessment**: Summary of recent change quality
   - **Commit-by-Commit**: Notable findings per commit (skip trivial ones)
   - **Concerning Patterns**: Code duplication, regressions, inconsistencies
   - **Suggestions**: Follow-up work or fixes needed
   - **Quality Score**: 1-5 with justification
     (1=critical issues, 2=significant concerns, 3=acceptable, 4=good, 5=excellent)

5. Finish with: /finish done "Review complete: agent-docs/review-${timestamp}.md"
PROMPT
)"
  fi

  # Add the review task to the queue
  ensure_tasks_json "$tasks_file"
  acquire_task_lock "$tasks_file"

  local auto_flag=""
  if [[ "$auto" == true ]]; then
    auto_flag="auto"
  fi

  read_tasks "$tasks_file" | /usr/bin/python3 -c "
import json, sys, time
data = json.load(sys.stdin)
prompt = sys.argv[1]
auto_flag = sys.argv[2]
task = {
    'id': 't-' + str(int(time.time())),
    'prompt': prompt,
    'status': 'pending',
    'claimed_by': None,
    'created_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
    'started_at': None,
    'completed_at': None
}
if auto_flag:
    task['tags'] = ['auto-review']
data['tasks'].append(task)
json.dump(data, sys.stdout, indent=2)
print(f\"Added review task {task['id']} (pending)\", file=sys.stderr)
" "$prompt" "$auto_flag" | write_tasks "$tasks_file"
  release_task_lock "$tasks_file"
}
