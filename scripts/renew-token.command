#!/bin/bash
# DOUBLE-CLICK THIS FILE to renew the research credential.
#
# Your only job is to click "Authorize" in the browser window that opens.
# Everything after that is automatic: the token is captured, written to
# ~/.claude/claude-token.env, verified, and today's missing research starts.
#
# The token is captured inside this Terminal window only. It is never printed
# back to Claude and never leaves the machine.
cd /Users/dominiczhao/portfolio-dashboard || exit 1
clear
echo "═══════════════════════════════════════════════════════════"
echo "  Renewing the portfolio research credential"
echo "═══════════════════════════════════════════════════════════"
echo
echo "A browser window will open. Sign in if asked, then click Authorize."
echo

umask 077
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM

# script(1) gives the CLI a real TTY so its interactive prompts work, while
# still letting us capture the token it prints — removing the copy-paste step
# that silently half-completed last time and cost fourteen days of research.
/usr/bin/script -q "$TMP" /opt/homebrew/bin/claude setup-token

TOKEN="$(grep -ao 'sk-ant-[A-Za-z0-9_-]\{20,\}' "$TMP" | tail -1)"
rm -f "$TMP"

echo
if [ -n "$TOKEN" ]; then
  echo "→ Token captured automatically. Installing…"
  printf '%s\n' "$TOKEN" | ./scripts/set-token.sh
else
  echo "→ Could not auto-capture the token from that output."
  echo "  Copy the sk-ant-… string above and paste it here:"
  ./scripts/set-token.sh
fi

echo
echo "Done. You can close this window."
echo "Press return to exit."
read -r _
