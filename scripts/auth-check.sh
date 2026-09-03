#!/bin/bash
# Shared credential check for every unattended job.
#
# WHY THIS EXISTS (21 Aug 2026): ~/.claude/claude-token.env was created on
# 7 Aug with the instructions in it but the token was NEVER PASTED — the file
# had a bare `CLAUDE_CODE_OAUTH_TOKEN=` with an empty value. The CLI also had
# no interactive session (~/.claude/.credentials.json absent). So from 8 Aug
# the 07:02 research run aborted after one second, every single day, for
# fourteen days, while an email that still LOOKED like a brief went out at
# 08:15 each morning. Nothing in the pipeline distinguished "logged out" from
# "logged out yesterday too, and the day before that".
#
# Prints a one-line reason on stdout. Exit 0 = usable credential, 1 = not.
#
# --live additionally spends one tiny API call proving the credential is
# ACCEPTED, not merely present. Added 21 Aug 2026 after an auto-captured token
# was truncated by terminal line-wrap to 79 chars: this script said "ok", the
# research run then died on "401 OAuth access token is invalid", and we were
# back to a green light over a broken pipeline. Presence is not validity.
# Cheap check for the hourly retry, --live for the nightly guard and on write.
[ -f "$HOME/.claude/claude-token.env" ] && . "$HOME/.claude/claude-token.env"
export CLAUDE_CODE_OAUTH_TOKEN

CLAUDE_BIN=/opt/homebrew/bin/claude
NODE_BIN=/opt/homebrew/bin/node

# An empty assignment is NOT a credential. This is the exact trap that cost
# 14 days: the file existed, the variable existed, the value was "".
live_probe() {  # 0 = the API accepted the credential
  OUT=$("$CLAUDE_BIN" -p "ok" --max-turns 1 2>&1)
  case "$OUT" in
    *"401"*|*"OAuth access token is invalid"*|*"Failed to authenticate"*|*"Please run /login"*) return 1 ;;
  esac
  return 0
}

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN// /}" ]; then
  if [ "${1:-}" = "--live" ]; then
    if live_probe; then
      echo "ok: long-lived token present (${#CLAUDE_CODE_OAUTH_TOKEN} chars) and ACCEPTED by the API"
      exit 0
    fi
    echo "TOKEN REJECTED: ${#CLAUDE_CODE_OAUTH_TOKEN} chars present but the API returned 401 — it is truncated, expired or mistyped"
    exit 1
  fi
  echo "ok: long-lived token present (${#CLAUDE_CODE_OAUTH_TOKEN} chars, not live-verified)"
  exit 0
fi

LOGGED_IN=$("$CLAUDE_BIN" auth status 2>/dev/null | "$NODE_BIN" -e \
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).loggedIn?"ok":"no")}catch(e){console.log("no")}})')
if [ "$LOGGED_IN" = "ok" ]; then
  echo "ok: interactive session credential (expires ~monthly — a setup-token is safer)"
  exit 0
fi

if [ -f "$HOME/.claude/claude-token.env" ]; then
  echo "NO CREDENTIAL: ~/.claude/claude-token.env exists but CLAUDE_CODE_OAUTH_TOKEN is EMPTY, and the CLI has no logged-in session"
else
  echo "NO CREDENTIAL: no ~/.claude/claude-token.env and the CLI has no logged-in session"
fi
exit 1
