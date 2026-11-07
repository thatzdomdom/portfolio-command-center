#!/bin/bash
# Same-day self-heal — hourly, 08:00-20:00 SGT.
#
# WHY: the pipeline had exactly one chance per day. The 07:02 run failed in one
# second on a dead credential and then nothing tried again for 24 hours, so a
# fix applied at 10am still bought a stale brief until the next morning. Fixing
# the credential should produce today's research within the hour, automatically.
#
# Cheap and idempotent: if today's brief already exists this exits in
# milliseconds without touching the model, so the once-a-day token budget in
# the SKILL is respected — this only ever fires on a day that produced nothing.
LOG="$HOME/Library/Logs/portfolio-research.log"
exec >>"$LOG" 2>&1
cd /Users/dominiczhao/portfolio-dashboard || exit 1

TODAY=$(TZ=Asia/Singapore date +%F)
BRIEF_DATE=$(/opt/homebrew/bin/node -e "try{console.log(require('$PWD/data/brief.json').date.slice(0,10))}catch(e){console.log('none')}" 2>/dev/null)
[ "$BRIEF_DATE" = "$TODAY" ] && exit 0          # already have today's research

# Don't stack runs on top of the 07:02 job or a previous retry.
pgrep -f "homebrew/bin/claude -p" >/dev/null 2>&1 && exit 0

REASON=$(./scripts/auth-check.sh)
if [ $? != 0 ]; then exit 0; fi                 # still no credential; the alarms already cover it

echo "=== $(TZ=Asia/Singapore date '+%F %T') RETRY — credential restored ($REASON), re-running today's research ==="
bash scripts/research-headless.sh
EC=$?

# If the research landed, send the REAL brief now — 08:15 already went out as
# an alarm, so --force is the point: today's actual analysis should not wait
# for tomorrow just because the alarm claimed the day's delivery slot.
NEW=$(/opt/homebrew/bin/node -e "try{console.log(require('$PWD/data/brief.json').date.slice(0,10))}catch(e){console.log('none')}" 2>/dev/null)
if [ "$NEW" = "$TODAY" ]; then
  echo "=== $(TZ=Asia/Singapore date '+%F %T') retry produced today's brief — sending it ==="
  /opt/homebrew/bin/node scripts/daily-brief.js --force
fi
exit $EC
