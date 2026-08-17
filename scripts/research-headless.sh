#!/bin/bash
# Headless morning research run (launchd 07:02) — runs the Claude CLI with
# permissions pre-granted so NOTHING can ever prompt. Hard 75-min timeout.
LOG="$HOME/Library/Logs/portfolio-research.log"
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') research start ==="
cd /Users/dominiczhao/portfolio-dashboard || exit 1

# ── AUTH: long-lived token, not the expiring OAuth session ────────────────
# The interactive OAuth refresh token lasts ~a month. Yours expired
# 2026-08-04 02:13 UTC and the 07:02 job then failed silently for two days
# ("Not logged in · Please run /login") while still emailing yesterday's brief.
# A `claude setup-token` credential lasts ~a year and is built for unattended
# use. Renew with: claude setup-token  → paste into ~/.claude/claude-token.env
[ -f "$HOME/.claude/claude-token.env" ] && . "$HOME/.claude/claude-token.env"
export CLAUDE_CODE_OAUTH_TOKEN

# Fail LOUDLY and early rather than burning the run and shipping stale data.
AUTH=$(/opt/homebrew/bin/claude auth status 2>/dev/null | /opt/homebrew/bin/node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).loggedIn?"ok":"no")}catch(e){console.log("no")}})')
if [ "$AUTH" != "ok" ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  echo "$(date '+%F %T') ABORT — not authenticated and no long-lived token set."
  NT=$(grep '^NTFY_TOPIC=' "$HOME/.claude/portfolio-brief.env" 2>/dev/null | cut -d= -f2)
  [ -n "$NT" ] && curl -s -o /dev/null -H "Title: Portfolio: research BLOCKED — logged out" -H "Priority: urgent" -H "Tags: warning" \
    -d "The Claude CLI is logged out, so no research ran and the morning brief will be stale. Fix on the Mac: claude setup-token, then paste the token into ~/.claude/claude-token.env" "https://ntfy.sh/${NT}"
  echo "=== $(date '+%F %T') research end (exit 78 — auth) ==="
  exit 78
fi

# ── DETERMINISTIC DATA LAYERS — run BEFORE any agent work ─────────────────
# Added 18 Aug 2026 after a daily run cost ~2.4M tokens, most of it spent on
# verification agents re-opening quote pages to check arithmetic. Prices and
# release schedules are structured data; fetching them in code is faster, free,
# and more accurate than having a language model read them off a web page.
# The agent is handed these files as established fact and must not re-research
# them. Both are non-fatal: if a feed is down the run continues and says so.
/opt/homebrew/bin/node scripts/price-spine.js || echo "$(date '+%F %T') price spine FAILED — agents will lack a price anchor this run"
/opt/homebrew/bin/node scripts/calendar-spine.js || echo "$(date '+%F %T') calendar spine unavailable/stale — see data/.calendar.json"

/opt/homebrew/bin/claude -p "Execute the instructions in /Users/dominiczhao/.claude/scheduled-tasks/portfolio-intel-refresh/SKILL.md exactly and completely.
Two files have ALREADY been fetched for you and are authoritative — treat them as established fact and do NOT spend agents re-researching their contents: data/.prices.json (dated OHLC for every instrument on the book) and data/.calendar.json (the release schedule with consensus and previous). Work efficiently — hard time budget 45 minutes; if a source stalls twice, skip it and continue; partial-but-published beats complete-but-late." \
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
