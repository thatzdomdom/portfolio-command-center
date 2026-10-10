#!/bin/bash
# Evening credential preflight — 21:00 SGT, ten hours BEFORE the 07:02 run.
#
# The old design only discovered a dead credential at 07:02, at which point
# the morning was already lost. Checking the night before turns "today's brief
# is stale" into "fix this now and tomorrow is fine". Also nags on a token
# approaching its ~1-year expiry, so renewal happens on a calendar rather than
# on an outage.
LOG="$HOME/Library/Logs/portfolio-auth-guard.log"
exec >>"$LOG" 2>&1
cd /Users/dominiczhao/portfolio-dashboard || exit 1
STATE="$HOME/.claude/portfolio-auth.state"
NTFY=$(grep '^NTFY_TOPIC=' "$HOME/.claude/portfolio-brief.env" 2>/dev/null | cut -d= -f2)

# --live: the nightly check is the one that must catch a token that is present
# but no longer accepted. One tiny API call per day.
REASON=$(./scripts/auth-check.sh --live); OK=$?
echo "=== $(date '+%F %T') auth-guard: $REASON ==="

if [ "$OK" != "0" ]; then
  echo "broken" > "$STATE"
  MSG="Tomorrow's 07:02 research WILL FAIL — $REASON. Fix on the Mac in one step: run  claude setup-token  then paste the token into ~/.claude/claude-token.env"
  [ -n "$NTFY" ] && curl -s -o /dev/null -H "Title: Portfolio: FIX TONIGHT — research credential dead" \
    -H "Priority: urgent" -H "Tags: rotating_light" -d "$MSG" "https://ntfy.sh/${NTFY}"
  # A banner on the Mac he is actually sitting at. ntfy pushes have been
  # firing since 8 Aug and did not get acted on; a second channel costs nothing.
  /usr/bin/osascript -e 'display notification "Run: claude setup-token — tomorrow'"'"'s 7am research will fail without it." with title "⚠️ Portfolio research credential dead" sound name "Basso"' 2>/dev/null
  exit 1
fi

echo "ok" > "$STATE"

# Renewal nag: a setup-token lasts about a year and cannot be introspected,
# so age the file instead. Warn from day 330 so renewal never becomes an outage.
if [ -f "$HOME/.claude/claude-token.env" ]; then
  AGE=$(( ( $(date +%s) - $(stat -f%m "$HOME/.claude/claude-token.env") ) / 86400 ))
  if [ "$AGE" -gt 330 ]; then
    [ -n "$NTFY" ] && curl -s -o /dev/null -H "Title: Portfolio: renew the research token" -H "Priority: high" -H "Tags: warning" \
      -d "The headless token is ${AGE} days old and expires around day 365. Run: claude setup-token" "https://ntfy.sh/${NTFY}"
    echo "$(date '+%F %T') token is ${AGE}d old — renewal nag sent"
  fi
fi
exit 0
