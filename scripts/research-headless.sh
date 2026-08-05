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

# ── PRICE GATE (added 31 Jul 2026) ────────────────────────────────────────
# The agent published an insider buy of M44U at "~S$1.91/unit" on a day the
# unit traded S$1.21-1.23 — and had never traded above S$1.80 in three years.
# Dom caught it, not the pipeline. Prose rules in the SKILL are not enough:
# every asserted price is now checked against the actual tape, and anything the
# stock never printed within a year is quarantined out of the published file
# before it can reach the dashboard. Runs AFTER the agent's own push, so this
# commits the correction on top.
if /opt/homebrew/bin/node scripts/validate-intel.js --fix; then
  echo "$(date '+%F %T') price gate: clean"
else
  echo "$(date '+%F %T') price gate: quarantined bad price(s) — committing correction"
  git add data/intel.json 2>/dev/null
  git commit -q -m "Price gate: quarantine insider entries asserting untraded prices $(TZ=Asia/Singapore date +%F)" 2>/dev/null \
    && (git push -q origin main 2>/dev/null || (git pull --rebase -q origin main && git push -q origin main)) \
    && echo "$(date '+%F %T') price-gate correction pushed"
  NTFY=$(grep '^NTFY_TOPIC=' "$HOME/.claude/portfolio-brief.env" 2>/dev/null | cut -d= -f2)
  [ -n "$NTFY" ] && curl -s -o /dev/null -H "Title: Portfolio: fabricated price caught" -H "Priority: high" -H "Tags: warning" \
    -d "The price gate removed an insider entry whose stated price never traded. See the Smart Money tab's data-quality note." "https://ntfy.sh/${NTFY}"
fi

# ── UNIVERSAL CHECK ───────────────────────────────────────────────────────
# Every published file, not just insider prices: future-dated news, out-of-range
# probabilities, stale stamps served as current, and — critically — any rewrite
# of past track.json snapshots, which would silently flatter the model's own
# hit rate. Report lands in data/.validation.json for the brief and dashboard.
/opt/homebrew/bin/node scripts/validate-all.js
VC=$?
if [ "$VC" = "1" ]; then
  echo "$(date '+%F %T') validate-all: PROBLEMS FOUND"
  NTFY=$(grep '^NTFY_TOPIC=' "$HOME/.claude/portfolio-brief.env" 2>/dev/null | cut -d= -f2)
  # Read the problems via a FILE, not an inline node -e inside "$( )". The
  # nested double quotes were mangled by the shell (5 Aug: `tryconst r=require`
  # + "curl: blank argument"), so the one time validation actually caught a real
  # problem, the alert about it could not be sent.
  PROB=$(/opt/homebrew/bin/node -e '
    try { const r = require(process.argv[1]); console.log((r.problems||[]).slice(0,4).join(" | ")); }
    catch (e) { console.log("see validate-all output"); }
  ' "$PWD/data/.validation.json" 2>/dev/null)
  [ -z "$PROB" ] && PROB="see validate-all output"
  if [ -n "$NTFY" ]; then
    curl -s -o /dev/null -H "Title: Portfolio: data validation failed" -H "Priority: high" -H "Tags: warning" \
      -d "$PROB" "https://ntfy.sh/${NTFY}"
  fi
else
  echo "$(date '+%F %T') validate-all: exit $VC"
fi
git add data/.validation.json 2>/dev/null
git commit -q -m "Validation report $(TZ=Asia/Singapore date +%F)" 2>/dev/null \
  && (git push -q origin main 2>/dev/null || (git pull --rebase -q origin main && git push -q origin main))

echo "=== $(date '+%F %T') research end (exit $EC) ==="
