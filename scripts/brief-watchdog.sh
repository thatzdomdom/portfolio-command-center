#!/bin/bash
# Morning-brief watchdog (runs 08:45 SGT via launchd).
# If today's brief.json wasn't produced by the 7:02 agent run, email an alert
# so a silent failure is never silent. Sends via Mail.app — no credentials.
BRIEF=/Users/dominiczhao/portfolio-dashboard/data/brief.json
TODAY=$(date +%Y-%m-%d)
EMAIL_TO=$(grep '^EMAIL_TO=' "$HOME/.claude/portfolio-brief.env" 2>/dev/null | cut -d= -f2)
[ -z "$EMAIL_TO" ] && exit 0

BRIEF_DATE=$(/usr/bin/env node -e "try{console.log(require('$BRIEF').date.slice(0,10))}catch(e){console.log('none')}" 2>/dev/null)
if [ "$BRIEF_DATE" = "$TODAY" ]; then exit 0; fi   # run succeeded — stay quiet

BODY="⚠️ PORTFOLIO WATCHDOG — $(date '+%a %d %b %Y %H:%M')

The 7:02am research run did NOT produce today's brief (latest brief: ${BRIEF_DATE}).
The dashboard's research layers are likely stale (its date stamps will confirm),
and no morning brief email was generated today.

Likely causes: the run hung (it has done this before), the app was closed,
or a session limit was hit.

What to do:
 1. Open the Claude app on the Mac (or message Claude from your phone) and say:
    \"refresh the research and send my brief\" — it takes ~10 minutes.
 2. Or: sidebar → Scheduled → portfolio-intel-refresh → Run now.

Live prices/quant on the dashboard are unaffected and current as always:
https://thatzdomdom.github.io/portfolio-command-center/"

osascript - "⚠️ Portfolio watchdog: no morning brief today" "$BODY" "$EMAIL_TO" <<'AS'
on run argv
  tell application "Mail"
    set msg to make new outgoing message with properties {subject:item 1 of argv, content:item 2 of argv, visible:false}
    tell msg to make new to recipient at end of to recipients with properties {address:item 3 of argv}
    send msg
  end tell
end run
AS
