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

// ── insider filings caught in real time since the last brief ─────────────
// scripts/insider-watch.js polls SEC EDGAR every 20 min and queues what it
// finds; the brief reports the last ~26h so nothing is only ever seen in a
// push you might have missed. US names only — SGX/HKEX have no open feed.
let insiderLines = [];
try {
  const q = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.insider-queue.json'), 'utf8'));
  const cutoff = Date.now() - 26 * 3600 * 1000;
  const recent = (q.items || []).filter(i => Date.parse(i.at) >= cutoff);
  const mat = recent.filter(i => i.material), other = recent.filter(i => !i.material);
  insiderLines = mat.map(i => `${i.ticker} — ${i.owner || 'insider'} (${i.role || ''}): ${i.summary} · filed ${i.filed}`);
  if (other.length) insiderLines.push(`plus ${other.length} non-market filing(s) (grants / option exercises / tax withholding — compensation, not conviction)`);
} catch (e) {}

// ── what the data-integrity gates did ────────────────────────────────────
let integrityLines = [];
try {
  const q = intel && intel.dataQuality;
  if (q) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
    const removedToday = (q.removed || []).filter(r => r.removedOn === today);
    if (removedToday.length) removedToday.forEach(r => integrityLines.push(
      `REMOVED ${r.ticker} ${r.date || ''} — claimed ${r.assertedPrice}, actual range ${r.actualRange}. ${(r.verifiedCause || r.reason || '').slice(0, 180)}`));
    if (q.flaggedCitations) integrityLines.push(`${q.flaggedCitations} item(s) flagged: no document-level source located — shown on the dashboard as leads, not confirmed filings.`);
    if (!integrityLines.length) integrityLines.push('All asserted insider prices cross-checked against actual traded ranges — nothing failed today.');
  }
} catch (e) {}
// universal file checks (scripts/validate-all.js)
try {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.validation.json'), 'utf8'));
  if (v.checkedOn === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' })) {
    if (v.problems && v.problems.length) v.problems.forEach(p => integrityLines.push(`⚠ ${p}`));
    else integrityLines.push(`All ${v.passed.length} file checks passed (news dates & sources, model probabilities, sentiment ranges, append-only call history, 13F timing, brief freshness)${v.warnings && v.warnings.length ? ` · ${v.warnings.length} minor warning(s)` : ''}.`);
  } else integrityLines.push('Note: the universal file check did not run today — treat the figures below with extra care.');
} catch (e) {}

if (insiderLines.length) sections.unshift(['🔔 INSIDER FILINGS CAUGHT LIVE (US names, last 24h)', insiderLines]);
if (integrityLines.length) sections.push(['DATA-INTEGRITY CHECKS', integrityLines]);

const stamp = (brief && brief.date) || (model && model.updated) || 'unknown';
// STALENESS GUARD. On 5 Aug the research run died instantly ("Not logged in"),
// so brief.json was yesterday's — and the 36-hour `fresh` window happily sent
// yesterday's analysis under today's date and subject. The validator caught it;
// the sender never asked. Now the sender checks too, and says so LOUDLY in both
// the subject and the first line rather than quietly shipping stale content.
// Singapore date, explicitly — toISOString() is UTC and would report the wrong
// day for a run just after midnight SGT.
const todaySGT = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const briefDay = brief && brief.date ? String(brief.date).slice(0, 10) : null;
const isStale = briefDay !== todaySGT;
const staleBanner = isStale
  ? `⚠️  STALE — THIS IS NOT TODAY'S RESEARCH\n`
    + `The ${new Date().toLocaleDateString('en-SG', { day: 'numeric', month: 'short' })} research run did not complete, so everything below is from ${briefDay || 'an earlier run'}.\n`
    + `Prices, probabilities and risk on the dashboard still recompute live; only this written analysis is stale.\n`
    + `${'─'.repeat(60)}\n\n`
  : '';
const bullets = a => a.map(x => `• ${x}`).join('\n');
const SUBJ = `📊 Portfolio Morning Brief — ${today}${isStale ? ' ⚠️ STALE (research did not run)' : ''}`;
const fullText = [
  staleBanner + `PORTFOLIO MORNING BRIEF — ${today}`,
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

// ── HTML body ────────────────────────────────────────────────────────────
// Mail.app wraps ANY scripted body in <blockquote type="cite"> (its URLShare
// template) — unavoidable on every compose path tested (content-after-create,
// visible:true, plain-format pref, paragraph objects, mailto, html content).
// Mail clients then style that quote block, which is what turned the brief
// purple. The cure is not removing the wrapper but out-specifying it: every
// element below carries an explicit inline color, and the card sets its own
// background, so nothing inherits the client's quote styling in light OR dark
// mode. Inline styles only — <style> blocks get stripped by many clients.
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const C = { ink: '#111827', body: '#1f2937', muted: '#6b7280', rule: '#e5e7eb', accent: '#b45309', card: '#ffffff', bullish: '#15803d', bearish: '#b91c1c', mixed: '#b45309' };
const impactColor = t => /BULLISH/i.test(t) ? C.bullish : /BEARISH/i.test(t) ? C.bearish : C.mixed;

// One text bullet -> HTML. Handles the "[IMPACT] headline\n → actionable"
// shape used by the news sections, and colors the tag by direction.
function htmlBullet(x) {
  const raw = String(x);
  const parts = raw.split('\n');
  const head = parts[0];
  const rest = parts.slice(1).map(l => l.replace(/^\s*→\s*/, '')).filter(Boolean);
  const tag = head.match(/^\[([A-Z]+)\]\s*/);
  const headHtml = tag
    ? `<span style="color:${impactColor(tag[1])};font-weight:700">${esc(tag[1])}</span> <span style="color:${C.body}">${esc(head.slice(tag[0].length))}</span>`
    : `<span style="color:${C.body}">${esc(head)}</span>`;
  const restHtml = rest.map(l => `<div style="color:${C.muted};margin:3px 0 0 0">→ ${esc(l)}</div>`).join('');
  return `<tr><td style="padding:0 0 10px 0;vertical-align:top;color:${C.accent};font-weight:700;width:14px">•</td><td style="padding:0 0 10px 0;color:${C.body};font-size:15px;line-height:1.5">${headHtml}${restHtml}</td></tr>`;
}
const htmlList = arr => `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">${arr.map(htmlBullet).join('')}</table>`;
const htmlSection = (h, items) => `
  <div style="margin:22px 0 0 0">
    <div style="color:${C.accent};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:0 0 8px 0;border-bottom:1px solid ${C.rule};margin:0 0 12px 0">${esc(h)}</div>
    ${htmlList(items)}
  </div>`;


// ── HTML BRIEF: colour and icons, but NO CARD ─────────────────────────────
// Hard lesson from 29 Jul: it was never HTML that made the brief look
// forwarded — it was the CARD. A white background with padding, rounded
// corners and a max-width, sitting inside the <blockquote type="cite"> that
// Mail forces onto every scripted message, reads as an embedded/quoted block.
// So this version flows like an ordinary email: no container background, no
// border-radius, no max-width box.
// It also deliberately does NOT set a colour on body text — that inherits the
// client's default, so it stays readable in BOTH light and dark mode. Only
// headings, icons and impact tags are coloured, using mid-tones that work on
// either background.
const AC = { accent:'#b45309', blue:'#1d4ed8', green:'#15803d', red:'#b91c1c', grey:'#6b7280' };
const impactChip = t => {
  const u = String(t).toUpperCase();
  const c = /BULLISH/.test(u) ? AC.green : /BEARISH/.test(u) ? AC.red : AC.accent;
  const ico = /BULLISH/.test(u) ? '▲' : /BEARISH/.test(u) ? '▼' : '◆';
  return `<span style="color:${c};font-weight:700;white-space:nowrap">${ico} ${esc(u)}</span>`;
};
const SECTION_ICON = h => {
  if (/TLDR/i.test(h)) return '📌';
  if (/INSIDER/i.test(h)) return '🔔';
  if (/NEWS/i.test(h)) return '📰';
  if (/REGIME/i.test(h)) return '🌏';
  if (/SIGNAL|TRADE/i.test(h)) return '⚡';
  if (/WATCH/i.test(h)) return '👀';
  if (/INTEGRITY/i.test(h)) return '✅';
  if (/UPDATED/i.test(h)) return '🔄';
  return '▪️';
};
// one bullet -> coloured marker + optional impact chip + indented follow-up
function htmlBullet2(x) {
  const raw = String(x), parts = raw.split('\n');
  let head = parts[0];
  const rest = parts.slice(1).map(l => l.replace(/^\s*→\s*/, '')).filter(Boolean);
  const tag = head.match(/^\[([A-Z]+)\]\s*/);
  let chip = '';
  if (tag) { chip = impactChip(tag[1]) + ' '; head = head.slice(tag[0].length); }
  // bold a leading ALL-CAPS lead-in like "OUR CALL, GRADED —"
  head = esc(head).replace(/^([A-Z][A-Z0-9 ,'\/&\.\-]{4,60}?)(\s*[—:-])/,
    `<b style="color:${AC.blue}">$1</b>$2`);
  const follow = rest.map(l => `<div style="color:${AC.grey};margin:3px 0 0 0">↳ ${esc(l)}</div>`).join('');
  return `<tr>
    <td style="vertical-align:top;padding:0 8px 9px 0;color:${AC.accent};font-weight:700">•</td>
    <td style="padding:0 0 9px 0;font-size:15px;line-height:1.55">${chip}${head}${follow}</td>
  </tr>`;
}
const htmlList2 = a => `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">${a.map(htmlBullet2).join('')}</table>`;
const htmlSection2 = (h, items) => `
  <div style="margin:22px 0 0 0">
    <div style="color:${AC.accent};font-size:13px;font-weight:800;letter-spacing:.04em;padding:0 0 6px 0;border-bottom:2px solid ${AC.accent}33;margin:0 0 10px 0">${SECTION_ICON(h)} ${esc(h)}</div>
    ${htmlList2(items)}
  </div>`;

const fullHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">
  <div style="font-size:20px;font-weight:800;letter-spacing:-.01em">📊 Portfolio Morning Brief</div>
  <div style="color:${AC.grey};font-size:13px;padding:3px 0 2px 0">${esc(today)} &nbsp;·&nbsp; data refreshed ${esc(stamp)}</div>
  <div style="border-bottom:2px solid ${AC.accent};width:64px;margin:6px 0 4px 0"></div>
  ${isStale ? `<div style="margin:14px 0;color:${AC.red};font-weight:700">⚠️ STALE — this is not today's research. ${esc(briefDay || 'an earlier run')} data; the dashboard's live prices and risk still recompute.</div>` : ''}
  ${htmlSection2('TLDR', tldr)}
  ${sections.map(([h, items]) => htmlSection2(h, items)).join('')}
  <div style="margin:26px 0 0 0;padding:12px 0 0 0;border-top:1px solid ${AC.grey}44">
    <a href="${DASH}" style="color:${AC.blue};font-weight:700;text-decoration:none">📈 Open the live dashboard →</a>
    <div style="color:${AC.grey};font-size:12px;padding:7px 0 0 0">Prices, probabilities and risk recompute in-browser on every open.</div>
    <div style="color:${AC.grey};font-size:12px;padding:8px 0 0 0">Decision-support only — not financial advice. Nothing is ever traded automatically.</div>
  </div>
</div>`;

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

// ── PREFERRED PATH: raw MIME over SMTP ────────────────────────────────────
// Mail.app's AppleScript compose wraps every body in <blockquote type="cite">
// (its URLShare template) plus a multipart/related part with an embedded PNG,
// so clients render the brief as quoted/forwarded text. Eight compose paths
// were tested; all wrap, it is not configurable. Sending raw MIME ourselves
// removes the wrapper entirely. Falls back to Mail.app if SMTP is unconfigured
// or fails, so delivery never depends on this working.
let smtpDone = false;
if (env.EMAIL_TO && env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
  const os = require('os');
  const tf = path.join(os.tmpdir(), `pcc-brief-${process.pid}.txt`);
  const hf = path.join(os.tmpdir(), `pcc-brief-${process.pid}.html`);
  fs.writeFileSync(tf, fullText); fs.writeFileSync(hf, fullHtml);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'send-smtp.js'),
    SUBJ, tf, hf, env.EMAIL_TO, env.EMAIL_FROM || env.SMTP_USER],
    { encoding: 'utf8', timeout: 120000 });
  try { fs.unlinkSync(tf); fs.unlinkSync(hf); } catch (_) {}
  if (r.status === 0) {
    smtpDone = true; emailOk = true;
    try { fs.writeFileSync(STATE, todayISO); } catch (_) {}
    log.push('email: ' + (r.stdout || '').trim());
  } else {
    log.push('smtp failed, falling back to Mail.app: ' + ((r.stderr || r.stdout || '').trim() || `exit ${r.status}`).slice(0, 140));
  }
}

if (env.EMAIL_TO && !smtpDone) {
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
  repeat 20 times
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
  with timeout of 150 seconds
    tell application "Mail"
      set msg to make new outgoing message with properties {subject:item 1 of argv, html content:item 2 of argv, visible:false}
      -- Strip the account signature. Mail was attaching image004.png (a
      -- Microsoft Office-generated signature graphic) to every brief, which
      -- added a corporate-forward look on top of the quote wrapper.
      try
        set message signature of msg to missing value
      end try
      if (count of argv) > 3 then set sender of msg to item 4 of argv
      tell msg to make new to recipient at end of to recipients with properties {address:item 3 of argv}
      send msg
    end tell
  end timeout
end run`;
  // PLAIN TEXT via Mail.app — deliberately NOT the styled HTML card.
  // Mail wraps every scripted body in <blockquote type="cite">. With plain text
  // that wrapper is invisible (Apple neutralises its border), which is why the
  // brief looked normal before 29 Jul. Putting a white styled card inside that
  // quote block made it read as an embedded/forwarded message, and from 30 Jul
  // Mail also started attaching a multipart/related PNG. The card only belongs
  // on the SMTP path, where there is no wrapper at all.
  const args = ['-', SUBJ, fullHtml, env.EMAIL_TO];
  if (env.EMAIL_FROM) args.push(env.EMAIL_FROM);
  // Up to 3 attempts with widening gaps — a launchd 08:15 run may catch Mail
  // mid-launch, mid-account-connect, or mid-network-flap.
  // The JS timeout MUST exceed the AppleScript's own budget (60s ready-poll +
  // 2s + 150s send ≈ 215s), otherwise spawnSync SIGTERMs osascript before it can
  // report its own error — which is exactly what happened on 30 Jul: attempts 1
  // and 2 were killed at the old 420s ceiling with EMPTY stderr, so the failure
  // was undiagnosable and delivery slipped from 08:15 to 08:35. Fail fast, with
  // a real reason, and keep all three attempts inside ~13 minutes.
  const why = r => (r.stderr || '').trim() || (r.signal ? `killed by ${r.signal} (timed out)` : `exit ${r.status}`);
  let r = spawnSync('osascript', args, { input: as, encoding: 'utf8', timeout: 260000 });
  for (let attempt = 2; attempt <= 3 && r.status !== 0; attempt++) {
    log.push(`email attempt ${attempt - 1} failed: ${why(r).slice(0, 120)} — retrying`);
    spawnSync('sleep', [String(attempt * 20)]);
    r = spawnSync('osascript', args, { input: as, encoding: 'utf8', timeout: 260000 });
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
    const args2 = ['-', `📊 Portfolio Morning Brief — ${today}`, fullHtml, env.EMAIL_TO2, env.EMAIL_FROM2];
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
