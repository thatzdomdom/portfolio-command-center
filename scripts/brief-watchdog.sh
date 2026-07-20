#!/bin/bash
# Morning-brief watchdog (runs 08:45 SGT via launchd).
# 1. Reaps hung 7am research runs.
# 2. Rotates the remote-control log when it balloons.
# 3. Verifies today's brief.json was produced (research success).
# 4. Verifies today's email was actually DELIVERED (guard file written by
#    scripts/daily-brief.js on a successful send).
# Alerts go out as ntfy pushes (plain HTTPS — works from launchd). Email
# alerts are impossible from launchd until the one-time macOS Automation
# "Allow" (osascript -> Mail) is granted; the Claude app session's 08:21
# wake-up owns email delivery until then.
BRIEF=/Users/dominiczhao/portfolio-dashboard/data/brief.json
GUARD="$HOME/.claude/portfolio-brief.last"
TODAY=$(date +%Y-%m-%d)
NTFY_TOPIC=$(grep '^NTFY_TOPIC=' "$HOME/.claude/portfolio-brief.env" 2>/dev/null | cut -d= -f2)

push_alert() {  # $1 = title, $2 = body
  [ -z "$NTFY_TOPIC" ] && return 0
  curl -s -o /dev/null -H "Title: $1" -H "Priority: urgent" -H "Tags: warning" -d "$2" "https://ntfy.sh/${NTFY_TOPIC}"
}

# 1. Reap hung research runs: any scheduled claude process started in the
# 07:00-07:20 window today still alive at 08:45 (>85 min) is stuck.
HOUR_PAT=$(date "+%a %b %e 07:0")
ps -axo pid,lstart,command | grep -E "claude-code/2\.1|homebrew/bin/claude -p" | grep -v grep | grep "$HOUR_PAT" | awk '{print $1}' | while read p; do
  kill "$p" 2>/dev/null && echo "$(date '+%F %T') reaped hung 7am run pid $p"
done

# 2. Rotate the remote-control log if it exceeds 50 MB (it has hit 100+ MB).
RCLOG="$HOME/Library/Logs/claude-remote-control.log"
if [ -f "$RCLOG" ] && [ "$(stat -f%z "$RCLOG" 2>/dev/null || echo 0)" -gt 52428800 ]; then
  tail -c 1000000 "$RCLOG" > "${RCLOG}.1" 2>/dev/null
  : > "$RCLOG"
  echo "$(date '+%F %T') rotated oversized remote-control log"
fi

# 3. Research check — did the 7:02 run produce today's brief?
BRIEF_DATE=$(/usr/bin/env node -e "try{console.log(require('$BRIEF').date.slice(0,10))}catch(e){console.log('none')}" 2>/dev/null)
if [ "$BRIEF_DATE" != "$TODAY" ]; then
  push_alert "Portfolio: research run FAILED today" "7:02am research did not produce today's brief (latest: ${BRIEF_DATE}). Live prices/quant on the dashboard are unaffected. Fix: message Claude 'refresh the research and send my brief'."
  echo "$(date '+%F %T') ALERT: brief.json stale ($BRIEF_DATE)"
  exit 0
fi

# 4. Delivery check — research succeeded, but did the EMAIL actually go out?
SENT=$(cat "$GUARD" 2>/dev/null)
if [ "$SENT" != "$TODAY" ]; then
  push_alert "Portfolio: morning email NOT delivered" "Research succeeded but the brief email has not gone out (last delivered: ${SENT:-never}). Read today's brief on the dashboard, then message Claude 'send my brief'. https://thatzdomdom.github.io/portfolio-command-center/"
  echo "$(date '+%F %T') ALERT: email not delivered (guard: ${SENT:-none})"
else
  echo "$(date '+%F %T') OK: research + delivery both done for $TODAY"
fi
exit 0
