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
 * Guards on the git step: refuses if any plaintext private file is tracked or staged; stages an
 * explicit allow-list only; index.html is allowed ONLY when every changed line is a holdings
 * literal `{id:N,…}` (edit-book.js output) — anything else is red('index guard'), so a page rewrite
 * can never ride out on the 07:02 job; pulls before pushing; verifies nothing is left "ahead".
 * --dry-run runs every gate and stops before git.
 *
 * LEDGER (phase 4, 12 Sep 2026). Before this, no record of green/red publishes existed anywhere —
 * the only evidence was log lines and "Publish YYYY-MM-DD" commits — so the seven-clean-day
 * cutover clock had nothing to read. record() appends one whitelisted row to
 * data/.publish-history.ndjson at EVERY exit path. It is local and gitignored (it says when the
 * pipeline broke, which is not for the public site), never carries detail/output, and is wrapped
 * in try so a ledger failure can never mask a red. cutover-check.js reads it after each run.
 */
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const log = m => console.log(`publish ${new Date().toISOString().slice(11, 19)} ${m}`);
const LEDGER = path.join(ROOT, 'data', '.publish-history.ndjson');

// Plaintext files that must NEVER be tracked or staged. Balances, replies, the action text, the
// local ledgers and the cursor files. Only the .enc envelopes of book/valuation/journal/oneaction
// may ship. Same list as validate-all.js's plaintext check and .gitignore.
const PRIVATE = ['data/book.json', 'data/valuation.json', 'data/.prices-2y.json', 'data/.credentials.json',
  'data/journal.json', 'data/journal.ndjson', 'data/oneaction.json', 'data/.oneaction-history.ndjson',
  'data/.state-history.ndjson', 'data/.publish-history.ndjson', 'data/.tickers.json', 'data/.cutover.json',
  'data/.last-brief-at', 'data/.last-brief-date'];
const LEAK_RE = /data\/(book|valuation|journal|oneaction)\.json$|data\/journal\.ndjson$|data\/\.(oneaction-history|state-history|publish-history)\.ndjson$|data\/\.(tickers|cutover|credentials)\.json$|data\/\.last-brief-(at|date)$|\.prices-2y/;

// Files that may be committed. index.html is guarded (see indexGuard); everything else is data.
const ALLOW = ['data/news.json', 'data/model.json', 'data/market.json', 'data/brief.json', 'data/intel.json', 'data/investors.json',
  'data/track.json', 'data/flows-investors.json', 'data/flows-history.json', 'data/version.json',
  'data/.prices.json', 'data/.calendar.json', 'data/.validation.json', 'data/.track-fingerprint.json',
  'data/fx.json', 'data/manifest.json', 'data/book.enc', 'data/valuation.enc',
  'data/signals.json', 'data/alerts.json', 'data/watchlist.json', 'data/policy.json',
  'data/technicals.json', 'data/targets.json', 'data/silver-backtest.json', 'data/fx-history.ndjson',
  'data/journal.enc', 'data/oneaction.enc', 'index.html'];

// ── pure guard helpers (exported; unit-tested with node -e, never by running the pipeline) ──
const HOLDING_LINE = /^[-+]\s*\{id:\s*\d+,/;
// Given `git diff --cached -U0 -- index.html`, return every changed line that is NOT a holdings
// literal. Empty array = the staged index.html is acceptable. Headers (+++/---), hunk markers and
// "\ No newline" lines are not content lines.
function indexGuard(diff) {
  return String(diff || '').split('\n')
    .filter(l => /^[-+]/.test(l) && !/^(\+\+\+|---) /.test(l))
    .filter(l => !HOLDING_LINE.test(l));
}
const leakOf = staged => (staged || []).filter(f => LEAK_RE.test(f));
const isPrivate = f => PRIVATE.includes(f) || LEAK_RE.test(f);

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
// Ledger row: whitelisted fields only, never detail/output. A dry run records status 'dry-run'
// whatever its outcome (its step says where it stopped) so a manual --dry-run before 07:25 — when
// brief.json is still yesterday's and validate-all is red — can never reset the cutover streak.
let validateAllExit = null, stagedCount = null;
function record(status, step) {
  try {
    const row = { date: today, at: new Date().toISOString(), status: DRY ? 'dry-run' : status,
      step: DRY && status === 'red' ? `red at ${step}` : step, validateAllExit, staged: stagedCount };
    fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  } catch (_) {}
}
function red(step, detail) {
  log(`RED at ${step} — NOT pushing`);
  if (detail) console.log(detail.split('\n').slice(-12).map(l => '   │ ' + l).join('\n'));
  record('red', step);
  ntfy(`Portfolio: publish blocked at ${step}`, `No push to the live site today. ${String(detail || '').slice(0, 300)}`);
  process.exit(1);
}

function main() {
  // 1. price gate (may quarantine; that is a fix, not a failure)
  let r = run('node', ['scripts/validate-intel.js', '--fix']);
  log(`validate-intel: ${r.code === 0 ? 'clean' : 'quarantined bad price(s) — correction will be published'}`);

  // 2. universal validator — exit 1 is a block, 2 is warnings only
  r = run('node', ['scripts/validate-all.js']);
  validateAllExit = r.code;
  if (r.code !== 0 && r.code !== 2) red('validate-all', r.out);
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

  if (DRY) { log('DRY RUN — all gates green; stopping before git'); record('dry-run', 'all gates green'); process.exit(0); }

  // 6. git, guarded
  const tracked = run('git', ['ls-files', '--', ...PRIVATE]).out.trim();
  if (tracked) red('git guard', `plaintext sensitive file(s) are TRACKED: ${tracked.replace(/\n/g, ', ')} — untrack them (git rm --cached) before any push`);

  run('git', ['add', '--', ...ALLOW.filter(f => fs.existsSync(path.join(ROOT, f)))]);
  const staged = run('git', ['diff', '--cached', '--name-only']).out.trim().split('\n').filter(Boolean);
  stagedCount = staged.length;
  if (!staged.length) { log('nothing changed — no commit'); record('nothing', 'git'); process.exit(0); }
  const leak = leakOf(staged);
  if (leak.length) red('git guard', `sensitive plaintext staged: ${leak.join(', ')}`);
  if (staged.includes('index.html')) {
    const bad = indexGuard(run('git', ['diff', '--cached', '-U0', '--', 'index.html']).out);
    if (bad.length) red('index guard', `index.html has ${bad.length} changed line(s) that are not holdings literals — only {id:N,…} lines may ship through publish.js:\n${bad.slice(0, 6).join('\n')}`);
    log('index guard: holdings lines only — accepted');
  }

  r = run('git', ['commit', '-q', '-m', `Publish ${today}\n\n${staged.length} file(s): ${staged.map(f => f.replace('data/', '')).join(', ')}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`]);
  if (r.code !== 0) red('git commit', r.out);
  // --autostash: the working tree is dirty whenever a script is mid-edit or a red day left scratch files —
// on 12 Sep the pull refused ("You have unstaged changes") and a green publish never reached origin.
  r = run('git', ['pull', '--rebase', '--autostash', '-q', 'origin', 'main']);
  if (r.code !== 0) red('git pull --rebase', r.out);
  r = run('git', ['push', '-q', 'origin', 'main']);
  if (r.code !== 0) red('git push', r.out);
  const ahead = run('git', ['status', '-sb']).out.split('\n')[0];
  if (/ahead/.test(ahead)) red('git verify', `still ahead after push: ${ahead}`);
  log(`pushed ${staged.length} file(s) · ${ahead}`);
  record('green', 'pushed');
}

module.exports = { indexGuard, leakOf, isPrivate, PRIVATE, ALLOW, LEAK_RE, HOLDING_LINE };
if (require.main === module) main();
