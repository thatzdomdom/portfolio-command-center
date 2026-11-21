#!/bin/bash
# DOUBLE-CLICK THIS FILE to renew the research credential.
#
# Your only job is to click "Authorize" in the browser window that opens.
# The token never leaves this Terminal window and is never shown to Claude.
cd /Users/dominiczhao/portfolio-dashboard || exit 1
clear

# WIDEN THE WINDOW FIRST. On 21 Aug 2026 this script captured a token through a
# pty at the default 80 columns; the token wrapped onto a second line, the grep
# below took only the first line, and 79 of ~100 characters were installed. The
# research then died on "401 OAuth access token is invalid" while every local
# check reported healthy. 400 columns means no realistic token can wrap.
printf '\033[8;50;400t'
stty cols 400 2>/dev/null

echo "═══════════════════════════════════════════════════════════"
echo "  Renewing the portfolio research credential"
echo "═══════════════════════════════════════════════════════════"
echo
echo "A browser window will open. Sign in if asked, then click Authorize."
echo

umask 077
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM

/usr/bin/script -q "$TMP" /opt/homebrew/bin/claude setup-token

# Strip ANSI colour codes, then look for the token.
CLEAN="$(sed $'s/\033\[[0-9;?]*[a-zA-Z]//g' "$TMP")"
TOKEN="$(printf '%s' "$CLEAN" | grep -ao 'sk-ant-[A-Za-z0-9_-]\{20,\}' | tail -1)"

# Belt and braces: if that looks short, the token wrapped anyway — rejoin the
# lines and try again. Real setup-token credentials are ~100 characters.
if [ "${#TOKEN}" -lt 90 ]; then
  JOINED="$(printf '%s' "$CLEAN" | tr -d '\r\n')"
  ALT="$(printf '%s' "$JOINED" | grep -ao 'sk-ant-[A-Za-z0-9_-]\{20,\}' | tail -1)"
  [ "${#ALT}" -gt "${#TOKEN}" ] && TOKEN="$ALT"
fi
rm -f "$TMP"

echo
if [ -n "$TOKEN" ]; then
  echo "→ Captured a ${#TOKEN}-character token. Installing and verifying…"
  # set-token.sh live-verifies against the API and rolls back if rejected, so a
  # truncated capture can never be left installed looking healthy.
  if printf '%s\n' "$TOKEN" | ./scripts/set-token.sh; then
    echo; echo "Done. You can close this window."; echo "Press return to exit."; read -r _; exit 0
  fi
  echo
  echo "→ Auto-capture produced a token the API rejected. Falling back to paste."
fi

echo "  Copy the full sk-ant-… string from the output above and paste it here."
echo "  (Select the WHOLE thing — if it spans two lines, include both.)"
./scripts/set-token.sh

echo
echo "You can close this window."
echo "Press return to exit."
read -r _
