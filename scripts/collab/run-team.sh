#!/usr/bin/env bash
# Runs the agy agent team: architect -> implementer relay (one task per session) -> reviewer.
# Usage: scripts/collab/run-team.sh [--skip-architect]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
MODEL="${AGY_MODEL:-gemini-4-argon-high}"
MAX_TASK_RUNS="${MAX_TASK_RUNS:-30}"
LOG_DIR="$ROOT/.collab-logs"
STATUS="$LOG_DIR/STATUS.txt"
mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$STATUS"; }

run_agent() { # $1=name $2=role file
  local name="$1" role="$2" out="$LOG_DIR/$1.log"
  log "start $name"
  agy -p "Read and follow the instructions in $role exactly. Work in this repository: $ROOT" \
    --model "$MODEL" --dangerously-skip-permissions --print-timeout 0 >"$out" 2>&1
  local rc=$?
  log "end $name rc=$rc (log: $out)"
  return $rc
}

open_tasks() { grep -c '^- \[ \]' docs/collab/TASKS.md 2>/dev/null || echo 0; }

if [[ "${1:-}" != "--skip-architect" ]]; then
  run_agent architect docs/collab/roles/architect.md
  if [[ ! -f docs/collab/TASKS.md ]]; then log "FAIL: architect produced no TASKS.md"; exit 1; fi
fi

stalls=0
for ((i = 1; i <= MAX_TASK_RUNS; i++)); do
  before=$(open_tasks)
  [[ "$before" -eq 0 ]] && break
  run_agent "impl-$(printf '%02d' "$i")" docs/collab/roles/implementer.md
  after=$(open_tasks)
  if [[ "$after" -ge "$before" ]]; then
    stalls=$((stalls + 1))
    log "no progress (open=$after, stalls=$stalls)"
    [[ $stalls -ge 2 ]] && { log "STOP: implementer stalled twice, see PROGRESS.md"; break; }
  else
    stalls=0
    log "progress: open tasks $before -> $after"
  fi
done

run_agent reviewer docs/collab/roles/reviewer.md
log "DONE. open tasks: $(open_tasks). commits: $(git rev-list --count master..HEAD)"
