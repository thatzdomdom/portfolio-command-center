#!/usr/bin/env node
// Daily morning brief: composes a TLDR + full update from data/*.json and
// delivers it by email (Mail.app via AppleScript — no stored credentials)
// and Telegram (bot API, config in ~/.claude/portfolio-brief.env).
// Run from the repo root: node scripts/daily-brief.js [--dry-run]
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const DASH = 'https://thatzdomdom.github.io/portfolio-command-center/';

function readJson(f) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')); } catch (e) { return null; } }
function readEnv() {
  const out = {};
  try {
    fs.readFileSync(path.join(process.env.HOME, '.claude', 'portfolio-brief.env'), 'utf8')
      .split('\n').forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) out[m[1]] = m[2].trim(); });
  } catch (e) {}
  return out;
}

const brief = readJson('brief.json');
const news = readJson('news.json'), model = readJson('model.json'), market = readJson('market.json'), intel = readJson('intel.json');
const today = new Date().toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

// ── compose ──────────────────────────────────────────────────────────────
let tldr = [], sections = [];
const fresh = brief && brief.date && (Date.now() - new Date(brief.date).getTime()) < 36 * 3600 * 1000;

if (fresh) {
  tldr = brief.tldr || [];
  if (brief.whatChanged && brief.whatChanged.length) sections.push(['WHAT WAS UPDATED', brief.whatChanged]);
  if (brief.regime) sections.push(['MACRO REGIME', [ `${brief.regime.label} — risk-on ${Math.round((brief.regime.riskOn || 0) * 100)}%`, brief.regime.oneLiner || '' ].filter(Boolean)]);
  if (brief.topNews && brief.topNews.length) sections.push(['NEWS THAT MATTERS TO YOUR BOOK', brief.topNews.map(n => `[${(n.impact || '').toUpperCase()}] ${n.headline}\n   → ${n.actionable || ''}`)]);
  if (brief.signals && brief.signals.length) sections.push(['MODEL SIGNALS / POSSIBLE TRADES', brief.signals]);
  if (brief.watch && brief.watch.length) sections.push(['WATCHING', brief.watch]);
} else {
  // Fallback: compose mechanically from the data files (works even if the
  // agent failed to write brief.json — the brief is then marked as such).
  tldr.push('(auto-composed fallback — agent did not write a fresh brief.json)');
  if (model && model.macro) tldr.push(`Regime: ${model.macro.regime} · risk-on ${Math.round((model.macro.riskOnProb || 0) * 100)}%`);
  if (market && market.fearGreed) tldr.push(`Fear & Greed ${market.fearGreed.value} (${market.fearGreed.rating}) · crypto ${market.fearGreed.cryptoValue ?? '—'}`);
  if (news && news.items && news.items[0]) tldr.push(`Top story: ${news.items[0].headline}`);
  if (news && news.items) sections.push(['NEWS THAT MATTERS TO YOUR BOOK', news.items.slice(0, 6).map(n => `[${(n.impact || '').toUpperCase()}] ${n.headline}\n   → ${n.actionable || ''}`)]);
  if (model && model.macro && model.macro.byAssetClass) sections.push(['MACRO STANCES', model.macro.byAssetClass.map(a => `${a.assetClass}: ${a.stance} (12m P-up ${Math.round((a.pUp12m || 0) * 100)}%)`)]);
  if (intel && intel.insiders) sections.push(['LATEST INSIDER FILINGS ON YOUR NAMES', intel.insiders.slice(0, 4).map(x => `${x.date} ${x.ticker} — ${x.insider}: ${x.type}`)]);
}

const stamp = (brief && brief.date) || (model && model.updated) || 'unknown';
const bullets = a => a.map(x => `• ${x}`).join('\n');
const fullText = [
  `PORTFOLIO MORNING BRIEF — ${today}`,
  `Data refreshed: ${stamp}`,
  '',
  '━━ TLDR ━━━━━━━━━━━━━━━━━━━━━━━',
  bullets(tldr),
  '',
  ...sections.flatMap(([h, items]) => [`━━ ${h} ━━`, bullets(items), '']),
  `Live dashboard (prices/risk recompute on open): ${DASH}`,
  '',
  'Decision-support only — not financial advice. Nothing is ever traded automatically.'
].join('\n');

const tgText = [
  `📊 *Portfolio Brief — ${today}*`,
  '',
  bullets(tldr.slice(0, 6)),
  '',
  (fresh && brief.topNews ? brief.topNews.slice(0, 3).map(n => `→ ${n.actionable || n.headline}`).join('\n') : ''),
  '',
  `Full brief in your email · [Dashboard](${DASH})`
].filter(Boolean).join('\n');

// ── deliver ──────────────────────────────────────────────────────────────
const env = readEnv();
let emailOk = false, tgOk = false, log = [];

if (DRY) {
  console.log('===== EMAIL =====\n' + fullText + '\n\n===== TELEGRAM =====\n' + tgText);
  process.exit(0);
}

// once-per-day guard: the 08:15 system job owns delivery; anything else needs --force
const FORCE = process.argv.includes('--force');
const STATE = path.join(process.env.HOME, '.claude', 'portfolio-brief.last');
const todayISO = new Date().toISOString().slice(0, 10);
try { if (!FORCE && fs.readFileSync(STATE, 'utf8').trim() === todayISO) { console.log('already sent today (' + todayISO + ') — use --force to resend'); process.exit(0); } } catch (e) {}

if (env.EMAIL_TO) {
  // Send FROM a different account than the recipient (EMAIL_FROM) so Gmail
  // treats it as genuine inbound mail — push notifications fire and it can't
  // be hidden by self-send quirks. Launch Mail first and use a long AppleEvent
  // timeout (cold Mail launches have caused -1712 timeouts).
  // Mail COLD-START is the historical failure mode from launchd at 08:15: the
  // app must launch and connect 8 accounts before `send` will return, and a
  // plain `delay 3` was not enough — `send` blocked until the AppleEvent timed
  // out (-1712). So: launch, then POLL until Mail answers a cheap query (up to
  // ~90s), and only then compose and send.
  const as = `on run argv
  tell application "Mail" to launch
  set ready to false
  repeat 30 times
    try
      tell application "Mail" to get name of account 1
      set ready to true
      exit repeat
    on error
      delay 3
    end try
  end repeat
  if not ready then error "Mail did not become ready"
  delay 2
  with timeout of 300 seconds
    tell application "Mail"
      set msg to make new outgoing message with properties {subject:item 1 of argv, content:item 2 of argv, visible:false}
      if (count of argv) > 3 then set sender of msg to item 4 of argv
      tell msg to make new to recipient at end of to recipients with properties {address:item 3 of argv}
      send msg
    end tell
  end timeout
end run`;
  const args = ['-', `📊 Portfolio Morning Brief — ${today}`, fullText, env.EMAIL_TO];
  if (env.EMAIL_FROM) args.push(env.EMAIL_FROM);
  // Up to 3 attempts with widening gaps — a launchd 08:15 run may catch Mail
  // mid-launch, mid-account-connect, or mid-network-flap.
  let r = spawnSync('osascript', args, { input: as, encoding: 'utf8', timeout: 420000 });
  for (let attempt = 2; attempt <= 3 && r.status !== 0; attempt++) {
    log.push(`email attempt ${attempt - 1} failed (${(r.stderr || '').trim().slice(0, 80)}) — retrying`);
    spawnSync('sleep', [String(attempt * 20)]);
    r = spawnSync('osascript', args, { input: as, encoding: 'utf8', timeout: 420000 });
  }
  emailOk = r.status === 0;
  if (emailOk) try { fs.writeFileSync(STATE, todayISO); } catch (e) {}
  log.push('email: ' + (emailOk ? 'sent to ' + env.EMAIL_TO + ' (from ' + (env.EMAIL_FROM || env.EMAIL_TO) + ')' : 'FAILED ' + (r.stderr || '').slice(0, 200)));

  // Second copy to another address (e.g. iCloud). Why: Mail's AppleScript
  // compose path wraps the body in <blockquote type="cite"> (URLShare
  // template — unavoidable; tested content-after, visible:true, plain-format
  // pref, paragraph objects, mailto). Apple Mail renders that wrapper as
  // perfectly normal text, but the GMAIL app styles it as purple "quoted"
  // text. So: Gmail copy = reliable + push notifications; iCloud copy read
  // in Apple Mail = the clean-looking version.
  if (emailOk && env.EMAIL_TO2 && env.EMAIL_FROM2) {
    const args2 = ['-', `📊 Portfolio Morning Brief — ${today}`, fullText, env.EMAIL_TO2, env.EMAIL_FROM2];
    let r2 = spawnSync('osascript', args2, { input: as, encoding: 'utf8', timeout: 320000 });
    if (r2.status !== 0) { spawnSync('sleep', ['10']); r2 = spawnSync('osascript', args2, { input: as, encoding: 'utf8', timeout: 320000 }); }
    log.push('email copy 2: ' + (r2.status === 0 ? 'sent to ' + env.EMAIL_TO2 + ' (from ' + env.EMAIL_FROM2 + ')' : 'FAILED ' + (r2.stderr || '').slice(0, 120)));
  }
} else log.push('email: skipped (no EMAIL_TO)');

// NOTE on fallbacks tried and rejected: ntfy.sh's email gateway rejects
// anonymous senders (HTTP 400, paid tier only) — do not re-add it. Email from
// launchd contexts is impossible until the one-time macOS Automation "Allow"
// (osascript -> Mail) is clicked; until then the Claude app session's daily
// 08:21 wake-up owns delivery (it holds a working Mail.app grant).
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
  const r = spawnSync('curl', ['-s', '-X', 'POST',
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    '--data-urlencode', `chat_id=${env.TELEGRAM_CHAT_ID}`,
    '--data-urlencode', `text=${tgText}`,
    '--data-urlencode', 'parse_mode=Markdown',
    '--data-urlencode', 'disable_web_page_preview=true'], { encoding: 'utf8', timeout: 30000 });
  try { tgOk = JSON.parse(r.stdout).ok === true; } catch (e) {}
  log.push('telegram: ' + (tgOk ? 'sent' : 'FAILED ' + (r.stdout || r.stderr || '').slice(0, 200)));
} else log.push('telegram: skipped (token/chat_id not configured)');

// ntfy.sh push — plain HTTPS, works from ANY context (launchd, agent, manual);
// no credentials, no AppleScript, no TCC. User subscribes to the topic in the ntfy app.
let ntfyOk = false;
if (env.NTFY_TOPIC) {
  const plain = tgText.replace(/[*_\[\]()]/g, '').replace(/📊 /, '');
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
    '-H', `Title: Portfolio Brief — ${today}`, '-H', 'Tags: chart_with_upwards_trend',
    '-H', 'Priority: high', '-d', plain.slice(0, 3800),
    `https://ntfy.sh/${env.NTFY_TOPIC}`], { encoding: 'utf8', timeout: 20000 });
  ntfyOk = (r.stdout || '').trim() === '200';
  log.push('ntfy push: ' + (ntfyOk ? 'sent' : 'FAILED ' + (r.stdout || r.stderr || '').slice(0, 100)));
} else log.push('ntfy push: skipped (no NTFY_TOPIC)');

console.log(log.join('\n'));
process.exit(emailOk || tgOk || ntfyOk ? 0 : 1);
