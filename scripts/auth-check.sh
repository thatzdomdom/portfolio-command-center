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
[ -f "$HOME/.claude/claude-token.env" ] && . "$HOME/.claude/claude-token.env"
export CLAUDE_CODE_OAUTH_TOKEN

CLAUDE_BIN=/opt/homebrew/bin/claude
NODE_BIN=/opt/homebrew/bin/node

# An empty assignment is NOT a credential. This is the exact trap that cost
# 14 days: the file existed, the variable existed, the value was "".
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN// /}" ]; then
  echo "ok: long-lived token present (${#CLAUDE_CODE_OAUTH_TOKEN} chars)"
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
