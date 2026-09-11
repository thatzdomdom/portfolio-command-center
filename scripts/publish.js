#!/usr/bin/env node
/*
 * publish.js — the ONLY path from this Mac to origin. Nothing reaches the live site without
 * passing through here, and nothing here pushes unless every gate is green.
 *
 * Phase 1 of the 11 Sep 2026 redesign. Before this, the research agent pushed its own output
 * BEFORE the validators ran (the price gate committed corrections "on top", after the bad number
 * was already live) — the structural reason a fabricated price reached the owner. The agent no
 * longer pushes; research-headless.sh calls this instead.
 *
 * Order:  validate-intel --fix → validate-all → credentials → encrypt-publish → manifest → git.
 * Red at any step = no push, ntfy alarm, non-zero exit. The 08:15 brief then goes out as
 * [DEGRADED] (daily-brief.js send gate) rather than as yesterday's content under today's date.
 *
 * Guards on the git step: refuses if plaintext book.json / valuation.json are tracked or staged;
 * stages an explicit allow-list only; pulls before pushing; verifies nothing is left "ahead".
 * --dry-run runs every gate and stops before git.
 */
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const log = m => console.log(`publish ${new Date().toISOString().slice(11, 19)} ${m}`);

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function ntfy(title, body) {
  try {
    const env = fs.readFileSync(path.join(process.env.HOME, '.claude', 'portfolio-brief.env'), 'utf8');
    const t = /^NTFY_TOPIC=(.+)$/m.exec(env); if (!t) return;
    spawnSync('curl', ['-s', '-o', '/dev/null', '-m', '10', '-H', `Title: ${title}`, '-H', 'Priority: high', '-H', 'Tags: warning', '-d', body, `https://ntfy.sh/${t[1].trim()}`]);
  } catch (_) {}
}
function red(step, detail) {
  log(`RED at ${step} — NOT pushing`);
  if (detail) console.log(detail.split('\n').slice(-12).map(l => '   │ ' + l).join('\n'));
  ntfy(`Portfolio: publish blocked at ${step}`, `No push to the live site today. ${String(detail || '').slice(0, 300)}`);
  process.exit(1);
}

// 1. price gate (may quarantine; that is a fix, not a failure)
let r = run('node', ['scripts/validate-intel.js', '--fix']);
log(`validate-intel: ${r.code === 0 ? 'clean' : 'quarantined bad price(s) — correction will be published'}`);

// 2. universal validator — exit 1 is a block, 2 is warnings only
r = run('node', ['scripts/validate-all.js']);
if (r.code === 1) red('validate-all', r.out);
log(`validate-all: ${r.code === 0 ? 'clean' : 'warnings only'}`);

// 3. credential ledger — never blocks, but its warnings ride into the brief
r = run('node', ['scripts/credentials.js']);
log(`credentials: ${r.code === 0 ? 'all fine' : 'WARNING — see data/.credentials.json'}`);

// 4. encrypt the files that carry balances; fail closed
r = run('node', ['scripts/encrypt-publish.js']);
if (r.code === 78) red('encrypt-publish', 'PCC_PASSPHRASE is not set — book/valuation would be published in the clear. Refusing.');
if (r.code !== 0) red('encrypt-publish', r.out);
log('encrypt-publish: ok');

// 5. manifest — written last so it describes what is actually about to ship
r = run('node', ['scripts/manifest.js']);
if (r.code !== 0) red('manifest', r.out);
log('manifest: ok');

if (DRY) { log('DRY RUN — all gates green; stopping before git'); process.exit(0); }

// 6. git, guarded
const tracked = run('git', ['ls-files', '--', 'data/book.json', 'data/valuation.json', 'data/.prices-2y.json', 'data/.credentials.json']).out.trim();
if (tracked) red('git guard', `plaintext sensitive file(s) are TRACKED: ${tracked.replace(/\n/g, ', ')} — untrack them (git rm --cached) before any push`);

const ALLOW = ['data/news.json', 'data/model.json', 'data/market.json', 'data/brief.json', 'data/intel.json', 'data/investors.json',
  'data/track.json', 'data/flows-investors.json', 'data/flows-history.json', 'data/version.json',
  'data/.prices.json', 'data/.calendar.json', 'data/.validation.json', 'data/.track-fingerprint.json',
  'data/fx.json', 'data/manifest.json', 'data/book.enc', 'data/valuation.enc',
  'data/signals.json', 'data/alerts.json', 'data/watchlist.json', 'data/policy.json',
  'data/technicals.json', 'data/targets.json', 'data/silver-backtest.json', 'data/fx-history.ndjson'];
run('git', ['add', '--', ...ALLOW.filter(f => fs.existsSync(path.join(ROOT, f)))]);
const staged = run('git', ['diff', '--cached', '--name-only']).out.trim().split('\n').filter(Boolean);
if (!staged.length) { log('nothing changed — no commit'); process.exit(0); }
const leak = staged.filter(f => /data\/(book|valuation)\.json$|\.prices-2y|\.credentials/.test(f));
if (leak.length) red('git guard', `sensitive plaintext staged: ${leak.join(', ')}`);

r = run('git', ['commit', '-q', '-m', `Publish ${today}\n\n${staged.length} file(s): ${staged.map(f => f.replace('data/', '')).join(', ')}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`]);
if (r.code !== 0) red('git commit', r.out);
r = run('git', ['pull', '--rebase', '-q', 'origin', 'main']);
if (r.code !== 0) red('git pull --rebase', r.out);
r = run('git', ['push', '-q', 'origin', 'main']);
if (r.code !== 0) red('git push', r.out);
const ahead = run('git', ['status', '-sb']).out.split('\n')[0];
if (/ahead/.test(ahead)) red('git verify', `still ahead after push: ${ahead}`);
log(`pushed ${staged.length} file(s) · ${ahead}`);
