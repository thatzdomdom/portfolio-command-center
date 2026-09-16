#!/usr/bin/env node
/*
 * credentials.js — a ledger of everything that can silently expire, with the date it will.
 *
 * Every credentialed dependency in this pipeline has lapsed at least once without anyone being
 * told: the CLI's OAuth refresh token expired 4 Aug 2026 and research aborted for five days while
 * stale briefs kept sending. The fix is not "remember to renew"; it is a file the brief reads
 * every morning that says how many days are left, and warns at 14.
 *
 * Writes data/.credentials.json (gitignored — names and dates only, never values). Exit 2 if any
 * entry is inside its warning window so publish.js can surface it; never blocks a push.
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const H = process.env.HOME, D = path.join(__dirname, '..', 'data');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const WARN_DAYS = 14;

const env = (() => { const o = {}; try { fs.readFileSync(path.join(H, '.claude', 'portfolio-brief.env'), 'utf8').split('\n')
  .forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].trim(); }); } catch (_) {} return o; })();
const mtime = f => { try { return fs.statSync(f).mtime.toISOString().slice(0, 10); } catch (_) { return null; } };
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const daysLeft = d => d ? Math.round((Date.parse(d) - Date.parse(today)) / 864e5) : null;

const tokenSet = mtime(path.join(H, '.claude', 'claude-token.env'));
const tokenPresent = (() => { try { return /^CLAUDE_CODE_OAUTH_TOKEN=\S+/m.test(fs.readFileSync(path.join(H, '.claude', 'claude-token.env'), 'utf8')); } catch (_) { return false; } })();
const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
const ghOk = /Logged in/.test((gh.stdout || '') + (gh.stderr || ''));

const items = [
  { name: 'Claude CLI long-lived token', where: '~/.claude/claude-token.env', present: tokenPresent, setAt: tokenSet,
    ttlDays: 365, expires: tokenSet ? addDays(tokenSet, 365) : null,
    renew: 'claude setup-token → paste into ~/.claude/claude-token.env (or double-click "Fix Claude Login.command")',
    why: 'the 07:02 research run; without it research aborts and the brief goes [DEGRADED]' },
  { name: 'Data-file passphrase (PCC_PASSPHRASE)', where: '~/.claude/portfolio-brief.env', present: !!(env.PCC_PASSPHRASE && env.PCC_PASSPHRASE.length >= 12),
    ttlDays: null, expires: null, renew: 'does not expire; if lost, re-generate and re-enter on each device',
    why: 'encrypts book/valuation at publish; missing = publish refuses (fail closed)' },
  { name: 'ntfy topic', where: '~/.claude/portfolio-brief.env', present: !!env.NTFY_TOPIC, ttlDays: null, expires: null,
    renew: 'does not expire', why: 'off-box alarm channel (dead-man, publish red)' },
  { name: 'GitHub CLI auth (gh)', where: 'keyring', present: ghOk, ttlDays: null, expires: null,
    renew: 'gh auth login', why: 'Actions secrets and workflow management; NOT needed for the daily push (git uses its own credential)' },
  { name: 'Mail.app account (delivery)', where: 'Mail.app', present: true, ttlDays: null, expires: null,
    renew: 'does not expire; Mail must be signed in', why: 'the 08:15 email; the only delivery path' },
];
let warn = 0;
items.forEach(i => {
  i.daysLeft = daysLeft(i.expires);
  i.state = !i.present ? 'MISSING' : (i.daysLeft != null && i.daysLeft <= 0) ? 'EXPIRED' : (i.daysLeft != null && i.daysLeft <= WARN_DAYS) ? 'WARN' : 'ok';
  if (i.state !== 'ok') warn++;
});
const out = { checkedOn: today, warnDays: WARN_DAYS, items,
  warnings: items.filter(i => i.state !== 'ok').map(i => `${i.name}: ${i.state}${i.daysLeft != null ? ` (${i.daysLeft}d)` : ''} — ${i.renew}`) };
fs.writeFileSync(path.join(D, '.credentials.json'), JSON.stringify(out, null, 2) + '\n');
items.forEach(i => console.log(`  ${i.state.padEnd(7)} ${i.name}${i.expires ? ` · expires ${i.expires} (${i.daysLeft}d)` : ''}`));
process.exit(warn ? 2 : 0);
