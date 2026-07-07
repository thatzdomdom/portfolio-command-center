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
      .split('\n').forEach(l => { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m) out[m[1]] = m[2].trim(); });
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

if (env.EMAIL_TO) {
  const as = `on run argv
  tell application "Mail"
    set msg to make new outgoing message with properties {subject:item 1 of argv, content:item 2 of argv, visible:false}
    tell msg to make new to recipient at end of to recipients with properties {address:item 3 of argv}
    send msg
  end tell
end run`;
  const r = spawnSync('osascript', ['-', `📊 Portfolio Morning Brief — ${today}`, fullText, env.EMAIL_TO], { input: as, encoding: 'utf8', timeout: 30000 });
  emailOk = r.status === 0;
  log.push('email: ' + (emailOk ? 'sent to ' + env.EMAIL_TO : 'FAILED ' + (r.stderr || '').slice(0, 200)));
} else log.push('email: skipped (no EMAIL_TO)');

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

console.log(log.join('\n'));
process.exit(emailOk || tgOk ? 0 : 1);
