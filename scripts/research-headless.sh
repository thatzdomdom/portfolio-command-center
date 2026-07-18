#!/bin/bash
# Headless morning research run (launchd 07:02) — runs the Claude CLI with
# permissions pre-granted so NOTHING can ever prompt. Hard 75-min timeout.
LOG="$HOME/Library/Logs/portfolio-research.log"
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') research start ==="
cd /Users/dominiczhao/portfolio-dashboard || exit 1

/opt/homebrew/bin/claude -p "Execute the instructions in /Users/dominiczhao/.claude/scheduled-tasks/portfolio-intel-refresh/SKILL.md exactly and completely. Work efficiently — hard time budget 45 minutes; if a source stalls twice, skip it and continue; partial-but-published beats complete-but-late." \
  --permission-mode bypassPermissions \
  --add-dir /Users/dominiczhao/portfolio-dashboard \
  --add-dir /Users/dominiczhao/.claude \
  --max-turns 150 &
PID=$!
( sleep 4500; kill -9 "$PID" 2>/dev/null && echo "$(date '+%F %T') TIMEOUT — killed run" ) &
WATCHER=$!
wait "$PID"; EC=$?
kill "$WATCHER" 2>/dev/null
echo "=== $(date '+%F %T') research end (exit $EC) ==="
