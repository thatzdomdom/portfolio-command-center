#!/bin/bash
# Paste a fresh `claude setup-token` credential in, safely.
#
# WHY THIS EXISTS: the 14-day outage of 8-21 Aug 2026 was not a clever bug. The
# renewal procedure was "run setup-token, then hand-edit ~/.claude/claude-token.env",
# the second half never happened, and the file was left with a bare
# CLAUDE_CODE_OAUTH_TOKEN= that every later check read as "configured". A manual
# step that silently half-completes is the failure. This does the write, refuses
# an empty value, proves the credential works, and starts today's run.
#
#   1.  claude setup-token          (copy the token it prints)
#   2.  scripts/set-token.sh        (paste when prompted)
set -u
cd /Users/dominiczhao/portfolio-dashboard || exit 1
ENVF="$HOME/.claude/claude-token.env"

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  printf 'Paste the token from `claude setup-token` (input hidden), then press return:\n> '
  read -r -s TOKEN; printf '\n'
fi
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"

if [ -z "$TOKEN" ]; then
  echo "✗ Nothing pasted — token NOT written. This is exactly how the last outage started; rerun when you have the token." >&2
  exit 1
fi
case "$TOKEN" in
  sk-ant-*) : ;;
  *) echo "✗ That does not look like a Claude token (expected it to start sk-ant-). Nothing written." >&2; exit 1 ;;
esac

# Keep the explanatory header, replace only the assignment. Written 600.
umask 077
TMP="$(mktemp)"
if [ -f "$ENVF" ]; then grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENVF" > "$TMP"; fi
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOKEN" >> "$TMP"
mv "$TMP" "$ENVF"; chmod 600 "$ENVF"
echo "✓ Written to $ENVF (${#TOKEN} chars)"

# Prove it, rather than trusting it.
REASON=$(./scripts/auth-check.sh); OK=$?
echo "  auth-check: $REASON"
[ "$OK" != "0" ] && { echo "✗ Still not usable — token rejected. Rerun claude setup-token." >&2; exit 1; }
echo "ok" > "$HOME/.claude/portfolio-auth.state"

TODAY=$(TZ=Asia/Singapore date +%F)
BD=$(/opt/homebrew/bin/node -e "try{console.log(require('$PWD/data/brief.json').date.slice(0,10))}catch(e){console.log('none')}" 2>/dev/null)
if [ "$BD" = "$TODAY" ]; then
  echo "✓ Today's research is already published — nothing else to do."
else
  echo "→ Today's research is missing (brief.json: $BD). Starting it now in the background;"
  echo "  it takes up to ~45 min and emails you the real brief when it lands."
  echo "  Watch: tail -f ~/Library/Logs/portfolio-research.log"
  nohup bash scripts/research-retry.sh >/dev/null 2>&1 &
fi
