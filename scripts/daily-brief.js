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

// Phase 4 (12 Sep 2026): the owner's replies and THE ONE ACTION are computed by code BEFORE this
// file reads a single data file. journal.js ingests Mail.app replies (idempotent; --quiet = no ntfy
// alarm from here), then one-action.js recomputes data/oneaction.json with the keyed journal status.
// Both also run at 07:02 from research-headless.sh; running them again here means a reply sent
// between 07:02 and 08:15 is in THIS morning's brief, and the block and the REPLIES section can
// never contradict each other. Non-fatal: the brief must go out even if Mail is unreachable.
// Never under --dry-run (a dry run must not touch Mail) unless --read-mail is passed explicitly.
const READ_MAIL = process.argv.includes('--read-mail');
const preLog = [];
if (!DRY || READ_MAIL) {
  for (const [script, args, timeout] of [['journal.js', ['--quiet'], 320000], ['one-action.js', [], 60000]]) {
    try {
      const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8', timeout });
      const tail = ((r.stderr || r.stdout || '').trim().split('\n').pop() || '').slice(0, 160);
      preLog.push(`${script}: ${r.status === 0 ? 'ok' : `exit ${r.status}${r.signal ? ' (' + r.signal + ')' : ''} — ${tail || 'no output'}`}`);
    } catch (e) { preLog.push(`${script}: not run (${e.message})`); }
  }
} else preLog.push('journal.js / one-action.js: skipped under --dry-run (pass --read-mail to run them)');

// Singapore date, explicitly — toISOString() is UTC and reports the wrong day just after midnight SGT.
const todaySGT = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const ndjson = f => { try { return fs.readFileSync(path.join(ROOT, 'data', f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${+m[3]} ${MON[+m[2] - 1]}` : String(iso || '?'); };
const sgtDay = iso => { const t = Date.parse(iso); return isNaN(t) ? String(iso || '').slice(0, 10) : new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); };
const sgtStamp = iso => { const d = new Date(iso); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }) + ' ' + d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' }) + ' SGT'; };
// The send stamp data/.last-brief-at (ISO, written on EVERY successful Mail.app send) is the window
// for SIGNALS and REPLIES. Before phase 4 only the dead SMTP branch wrote a stamp, so the live path
// never had one and the window silently fell back to now − 2d. Fallback now: now − 48h.
const lastBriefAt = (() => { try { const t = fs.readFileSync(path.join(ROOT, 'data', '.last-brief-at'), 'utf8').trim(); if (!isNaN(Date.parse(t))) return t; } catch (_) {} return new Date(Date.now() - 48 * 3600e3).toISOString(); })();
// THE ONE ACTION (scripts/one-action.js): only today's file counts — a stale one would repeat an
// ask the data may already have cleared.
const oneAction = (() => { const o = readJson('oneaction.json'); return o && o.date === todaySGT && o.action ? o : null; })();
function actionLines() {
  if (!oneAction) return ['One Action not computed this morning — scripts/one-action.js did not run'];
  const a = oneAction.action, j = oneAction.journal || {}, L = [];
  L.push(a.kind === 'none' ? a.text : `ACTION: ${a.text}`);
  (a.why || []).forEach(w => L.push(w));
  // deferred = state, not a nag: the ACTION line stays, the Reply line goes
  if (j.status === 'deferred' && j.lastReply) L.push(`deferred until ${dmy(j.deferredUntil)} ("${j.lastReply.arg || 'no reason given'}") — reply DONE when done`);
  else if (a.ask) L.push(`Reply ${a.ask}.`);
  if (j.status === 'reported-done' && j.lastReply) L.push(`you replied DONE on ${dmy(sgtDay(j.lastReply.receivedAt || j.lastReply.at))}${j.note ? ' — ' + j.note : ''}`);
  (oneAction.candidates || []).forEach(c => L.push(`also open · ${c.key}: ${c.text} — reply DONE ${c.key} when done`));
  return L;
}
// One line per journal row received after the last send. Rows come from journal.js
// ({at, briefDate, receivedAt, messageId, verb, arg, key, raw}); the action is named by the
// `short` text of the brief being replied to (.oneaction-history.ndjson), never by its key.
function repliesLines() {
  const seen = new Set();
  const rows = ndjson('journal.ndjson').filter(r => { const t = r.receivedAt || r.at || ''; if (!(t > lastBriefAt)) return false; const id = r.messageId || t + '|' + r.verb + '|' + r.key; if (seen.has(id)) return false; seen.add(id); return true; })
    .sort((a, b) => (a.receivedAt || a.at || '') < (b.receivedAt || b.at || '') ? -1 : 1);
  if (!rows.length) return [];
  const hist = ndjson('.oneaction-history.ndjson'), WL = readJson('watchlist.json');
  const shortFor = r => { const h = hist.find(x => x.date === r.briefDate); return h && h.short && (!r.key || r.key === h.key) ? h.short : (r.key || '(no action bound)'); };
  const wname = t => { const w = ((WL && WL.us) || []).find(x => x.t === t); return w && w.n ? w.n : 'name pending'; };
  const L = [], ignored = {}; let grammar = false;
  for (const r of rows) {
    const verb = String(r.verb || '').toUpperCase(), arg = String(r.arg == null ? '' : r.arg).trim(), bd = r.briefDate ? `${dmy(r.briefDate)} brief` : 'unbound';
    if (r.trusted === false || r.ignored === true || verb === 'IGNORED' || verb === 'UNTRUSTED') { const d = String(r.domain || r.sender || '?').replace(/[>\s]/g, '').split('@').pop(); ignored[d] = (ignored[d] || 0) + 1; continue; }
    if (verb === 'DONE') L.push(`DONE · ${bd} · ${shortFor(r)}${arg ? ` ("${arg}")` : ''}`);
    else if (verb === 'DEFER') L.push(`DEFER · ${bd} · ${shortFor(r)} — ${arg ? `"${arg}"` : 'DEFER without a reason — say why next time'}`);
    else if (verb === 'WATCH' || verb === 'UNWATCH') {
      const t = (arg.split(/\s+/)[0] || '?').toUpperCase(), bad = r.applied === false || /unresolved/i.test(String(r.note || r.result || ''));
      L.push(bad ? `${verb} ${t} → ${String(r.note || r.result || 'unresolved ticker')} — not ${verb === 'WATCH' ? 'added' : 'removed'}` : verb === 'WATCH' ? `WATCH ${t} → added to the watchlist (${wname(t)})` : `UNWATCH ${t} → removed from the watchlist`);
    }
    else if (verb === 'DECIDE') { const m = /^(\d+)\s*([\s\S]*)$/.exec(arg); L.push(m ? `DECIDE ${m[1]} → logged: "${m[2]}"` : `DECIDE → "${arg}"`); }
    else if (verb === 'NOTE') L.push(`NOTE · "${arg}"`);
    else if (verb === 'LOAN') L.push(`LOAN ${arg} → ${r.applied === false ? 'NOT applied — ' + String(r.note || r.error || 'edit-book refused') : 'loan mark updated in book.json'}`);
    else { L.push(`reply not understood: "${String(r.raw || arg).replace(/\s+/g, ' ').slice(0, 120)}"${r.reason ? ` (${r.reason})` : ''}${grammar ? '' : ' — DONE · DEFER <why> · WATCH <ticker> · NOTE <text> · DECIDE <n> <text>'}`); grammar = true; }
  }
  Object.entries(ignored).forEach(([d, n]) => L.push(`ignored ${n} repl${n === 1 ? 'y' : 'ies'} from an untrusted address (${d})`));
  return L;
}

const brief = readJson('brief.json');
// Phase 1 (11 Sep 2026): net worth and the silver margin arithmetic now exist on disk, computed
// in code before any page renders them — and the brief reads them here. valuation.json is the
// output of scripts/valuate.js; .credentials.json of scripts/credentials.js. Both survive a
// research outage, so they are shown even in a [DEGRADED] brief.
const valuation = readJson('valuation.json');
const creds = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.credentials.json'), 'utf8')); } catch (_) { return null; } })();
function valuationLines() {
  if (!valuation) return ['valuation.json absent — scripts/valuate.js did not run'];
  const v = valuation, L = [], m = n => 'S$' + (n / 1e6).toFixed(3) + 'M';
  const pct = v.dayChgPct == null ? '—' : (v.dayChgPct >= 0 ? '+' : '') + v.dayChgPct.toFixed(2) + '%';
  L.push(`NAV ${m(v.navSGD)} · ${pct} (${v.dayChgSGD >= 0 ? '+' : ''}S$${Math.round(v.dayChgSGD).toLocaleString()}) vs prev close · prices ${v.asOf} · fx ${v.fxAsOf}`);
  const s = v.silver;
  if (s) {
    L.push(`SILVER ${s.oz} oz @ $${s.priceUSD.toFixed(2)} · equity S$${s.equitySGD.toLocaleString()} · leverage ${s.leverage}x · margin call at $${s.callPriceUSD} (${s.distanceToCallPct}% away; $${s.callPriceUSDStressed} / ${s.distanceToCallPctStressed}% away if maintenance rises to ${(s.maintenanceRateStressed * 100).toFixed(0)}%)`);
    L.push(`Rule 1 survivability (2-day −20% and 2-week −35% at the stressed rate): ${s.survivability.pass ? 'PASS' : 'FAIL — position outside policy; reduce the loan or add collateral'} · carry: loan ${s.carry.loanRatePct}% vs silver 12m ${s.carry.silver12mPct == null ? 'n/a' : s.carry.silver12mPct + '%'} — ${s.carry.note}`);
    if (String(s.maintenanceRateSource).startsWith('ASSUMED')) L.push(`Maintenance rate ${(s.maintenanceRate * 100).toFixed(0)}% is ASSUMED (as of ${s.maintenanceRateAsOf}) — confirm on the IBKR account page and update data/book.json`);
  }
  if (v.stale && v.stale.length) L.push(`${v.stale.length} stale mark(s): ${v.stale.slice(0, 5).map(x => x.t || x.id).join(', ')}${v.stale.length > 5 ? '…' : ''} — manual marks over 90 days (maintenance rate: 30) need updating in data/book.json`);
  if (creds && creds.warnings && creds.warnings.length) creds.warnings.forEach(w => L.push('CREDENTIAL: ' + w));
  return L;
}
// Phase 3 (12 Sep 2026): the RISK STATE block — every line computed by code from the price
// spine and book.json, every rule with a threshold. Standing conditions are permanent state
// lines; nothing here nags daily. The silver line applies Rule 2 (unsigned) and says so.
function riskLines() {
  const L = [];
  const T = readJson('technicals.json'), TG = readJson('targets.json'), CAL = readJson('.calendar.json'), SB = readJson('silver-backtest.json'), POL = readJson('policy.json'), BK = readJson('book.json');
  const v = valuation, s = v && v.silver;
  const slv = T && T.instruments && (T.instruments.SLV || T.instruments['SI=F']);
  if (slv && s) {
    const g = slv.gate.on === true ? 'ON' : slv.gate.on === false ? 'OFF' : String(slv.gate.on);
    L.push(`silver    gate ${g} · ${slv.distPct200 >= 0 ? '+' : ''}${slv.distPct200}% vs 200d (SLV proxy) · 12-1 mom ${slv.mom12_1Pct}% · ${s.distanceToCallPct}% to margin call (${s.distanceToCallPctStressed}% at 1.5x rate) · survivability ${s.survivability.pass ? 'PASS' : 'FAIL'} · leverage ${s.leverage}x`
      + (slv.gate.on === false && s.leverage > 1.05 ? ' — RULE 2 (unsigned): gate OFF with leverage above 1.0x → reduce the loan to 1.0x' : ''));
    L.push(`carry     loan ${s.carry.loanRatePct}% vs silver 12m ${s.carry.silver12mPct == null ? 'n/a' : s.carry.silver12mPct + '%'}`);
  }
  if (TG && TG.clusters && TG.clusters[0]) { const c = TG.clusters[0]; L.push(`cluster   ${c.name} ${(c.actualRiskShare * 100).toFixed(0)}% of quoted-sleeve risk · cap 20%${c.overCapActual ? ' · OVER' : ''} · portfolio vol ${TG.portfolioVolActualPct}% (target ${TG.portfolioVolTargetPct}%) · targets in SHADOW`); }
  try { const hist = fs.readFileSync(path.join(ROOT, 'data', 'nav-history.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); const pk = hist.reduce((m, x) => x.nav > m.nav ? x : m, hist[0]); const cur = hist[hist.length - 1]; const dd = (cur.nav / pk.nav - 1) * 100;
    L.push(`drawdown  NAV ${dd <= 0 ? dd.toFixed(1) : '+' + dd.toFixed(1)}% from high (${pk.date}) · ${hist.length}d of history${dd <= -10 ? ' — over 10%: lead item' : ''}`); } catch (_) { L.push('drawdown  NAV history starts today'); }
  if (CAL && s && s.leverage > 1.0) { const soon = (CAL.upcoming || []).filter(e => e.relevance && /Fed|inflation|China|FOMC/i.test(e.relevance) && (Date.parse(e.whenISO) - Date.now()) < 48 * 3600e3 && (Date.parse(e.whenISO) - Date.now()) > 0);
    if (soon.length) L.push(`events    ${soon.slice(0, 3).map(e => e.country + ' ' + e.title + ' ' + e.whenSGT.slice(5, 16)).join(' · ')} — within 48h with leverage ${s.leverage}x · acknowledge`); }
  try { const fh = fs.readFileSync(path.join(ROOT, 'data', 'fx-history.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); const cur = fh[fh.length - 1]; const mo = fh.filter(x => x.date.slice(0, 7) === cur.date.slice(0, 7))[0]; const mv = (cur.rates.USD / mo.rates.USD - 1) * 100;
    L.push(`fx        USD/SGD ${mv >= 0 ? '+' : ''}${mv.toFixed(2)}% MTD${Math.abs(mv) > 3 ? ' — over 3%: FX cash review' : ''} · ${fh.length}d of history`); } catch (_) { L.push('fx        FX history starts today'); }
  if (T && T.summary && BK) {
    const heldYf = new Set(BK.holdings.filter(h => h.yf).map(h => h.yf)); const top10 = new Set((v.lines || []).filter(l => l.source === 'live').sort((a, b) => b.valueSGD - a.valueSGD).slice(0, 10).map(l => BK.holdings.find(h => h.id === l.id)).filter(Boolean).map(h => h.yf));
    const below = T.summary.crossedBelow5d.filter(x => heldYf.has(x)), topCross = below.filter(x => top10.has(x));
    const offHeld = [...heldYf].filter(x => T.instruments[x] && T.instruments[x].gate.on === false).length, nHeld = [...heldYf].filter(x => T.instruments[x]).length;
    L.push(`trend     ${offHeld}/${nHeld} held names gate OFF · crossed below 200d (5 closes): ${below.join(', ') || 'none'}${topCross.length ? ' · TOP-10 POSITION crossed: ' + topCross.join(', ') + ' — re-underwrite by a date (One Action candidate)' : ''}${T.summary.volSpike.filter(x => heldYf.has(x)).length ? ' · vol spike: ' + T.summary.volSpike.filter(x => heldYf.has(x)).join(', ') : ''}`);
  }
  if (POL) L.push(`policy    regime ${POL.regime ? POL.regime.status : '—'} · silver rules 1&2 ${POL.silverLeverage ? POL.silverLeverage.status.split(' — ')[0] : '—'}` + (SB && SB.summary.fixed ? ` · backtest ${SB.from.slice(0, 4)}–${SB.asOf.slice(0, 4)}: metal CAGR ${SB.summary.unlevered.cagrPct}% · fixed-${SB.rules.targetLeverage}x ${SB.summary.fixed.cagrPct}% (${SB.summary.fixed.marginCalls} margin call) · gated ${SB.summary.gated.cagrPct}% (${SB.summary.gated.marginCalls} calls, ${SB.summary.gated.delevers} de-levers)` + (SB.rule1 ? ` · Rule 1 max leverage ${SB.rule1.binding}x at ${(SB.rule1.stressedRate * 100).toFixed(0)}%, target ${SB.rule1.targetLeverage}x ${SB.rule1.targetPassesRule1 ? 'passes' : 'FAILS'}` : '') : ''));
  return L;
}
const news = readJson('news.json'), model = readJson('model.json'), market = readJson('market.json'), intel = readJson('intel.json');
const today = new Date().toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

// ── compose ──────────────────────────────────────────────────────────────
let tldr = [], sections = [];
const fresh = brief && brief.date && (Date.now() - new Date(brief.date).getTime()) < 36 * 3600 * 1000;

if (fresh) {
  tldr = brief.tldr || [];
  if (brief.whatChanged && brief.whatChanged.length) sections.push(['WHAT WAS UPDATED', brief.whatChanged]);
  if (brief.regime) sections.push(['MACRO REGIME', [ `${brief.regime.label} — risk-on ${Math.round((brief.regime.riskOn || 0) * 100)}%`, brief.regime.oneLiner || '' ].filter(Boolean)]);
  sections.push(['VALUATION & LEVERAGE', valuationLines()]);
    sections.push(['RISK STATE', riskLines()]);
  if (brief.topNews && brief.topNews.length) sections.push(['NEWS THAT MATTERS TO YOUR BOOK', brief.topNews.map(n => `[${(n.impact || '').toUpperCase()}] ${n.headline}\n   → ${n.actionable || ''}`)]);
  if (brief.signals && brief.signals.length) sections.push(['MODEL SIGNALS / POSSIBLE TRADES', brief.signals]);
  if (brief.watch && brief.watch.length) sections.push(['WATCHING', brief.watch]);
} else {
  // Fallback: compose mechanically from the data files (works even if the
  // agent failed to write brief.json — the brief is then marked as such).
  tldr.push('(auto-composed fallback — agent did not write a fresh brief.json)');
  sections.push(['VALUATION & LEVERAGE', valuationLines()]);
    sections.push(['RISK STATE', riskLines()]);
  if (model && model.macro) tldr.push(`Regime: ${model.macro.regime} · risk-on ${Math.round((model.macro.riskOnProb || 0) * 100)}%`);
  if (market && market.fearGreed) tldr.push(`Fear & Greed ${market.fearGreed.value} (${market.fearGreed.rating}) · crypto ${market.fearGreed.cryptoValue ?? '—'}`);
  if (news && news.items && news.items[0]) tldr.push(`Top story: ${news.items[0].headline}`);
  if (news && news.items) sections.push(['NEWS THAT MATTERS TO YOUR BOOK', news.items.slice(0, 6).map(n => `[${(n.impact || '').toUpperCase()}] ${n.headline}\n   → ${n.actionable || ''}`)]);
  if (model && model.macro && model.macro.byAssetClass) sections.push(['MACRO STANCES', model.macro.byAssetClass.map(a => `${a.assetClass}: ${a.stance}`)]);
  if (intel && intel.insiders) sections.push(['LATEST INSIDER FILINGS ON YOUR NAMES', intel.insiders.slice(0, 4).map(x => `${x.date} ${x.ticker} — ${x.insider}: ${x.type}`)]);
}

// (Phase 4: the "INSIDER FILINGS CAUGHT LIVE" block that read the retired insider-watch.js queue is
// gone — alerts.json below is the only insider/ownership source.)

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

// Phase 6 (13 Sep 2026): 13F holdings come from EDGAR in code — scripts/13f-scan.js on GitHub Actions
// writes data/13f.json at 06:15 SGT — no longer from the research agent's investors.json, whose stamp
// was bumped every morning over a quarter-old table (18 Aug). Two things reach the brief, both computed
// here. SIGNALS: one line per filing INGESTED since the last send (events[].at — the same ingest-time
// window as the alerts); the first scan's backfill (bootstrap:true, mid-August filings first read on
// 13 Sep) is not news and is never listed. DATA-INTEGRITY: one line every day saying how current the
// feed is, because a quarterly feed that has died reads exactly like a quiet quarter. Neither throws.
const f13 = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '13f.json'), 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : { unreadable: String(e.message).slice(0, 80) }; } })();
const f13Checked = () => f13 && f13.scan && f13.scan.checkedAt ? dmy(sgtDay(f13.scan.checkedAt)) : 'never';
function f13SignalLines() {
  try {
    if (!f13 || f13.unreadable) return [];
    return (f13.events || []).filter(e => e && String(e.at || '') > lastBriefAt && e.bootstrap !== true)
      .sort((a, b) => String(a.filed).localeCompare(String(b.filed)) || String(a.name).localeCompare(String(b.name)))
      .map(e => `13F · ${e.name} ${e.quarter} filed ${dmy(e.filed)} · ${Number(e.positions || 0).toLocaleString()} positions · ${e.new} new, ${e.exited} exited · checked ${f13Checked()}`);
  } catch (_) { return []; }
}
function f13IntegrityLine() {
  try {
    if (!f13) return '13F: data/13f.json absent — scripts/13f-scan.js (GitHub Actions, 06:15 SGT) has not produced it; no fund holdings are checked';
    if (f13.unreadable) return `13F: data/13f.json unreadable (${f13.unreadable}) — treat every 13F figure as unchecked`;
    const S = f13.scan || {}, checked = S.checkedAt ? sgtDay(S.checkedAt) : null;
    const age = checked ? Math.round((Date.parse(todaySGT) - Date.parse(checked)) / 864e5) : null;
    if (age == null || age > 3) return `13F feed is DEAD, not quiet — last checked ${f13Checked()}${age == null ? '' : ` (${age}d ago)`}; the 06:15 SGT 13f-scan workflow has not completed since`;
    // Deadline = quarter end + 45 days, rolled to the next weekday (2026 Q3: Sat 14 Nov → Mon 16 Nov).
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], Q = [], y0 = +todaySGT.slice(0, 4);
    for (let y = y0 - 1; y <= y0 + 1; y++) ['03-31', '06-30', '09-30', '12-31'].forEach((md, i) => {
      const d = new Date(Date.parse(`${y}-${md}T00:00:00Z`) + 45 * 864e5); d.setUTCDate(d.getUTCDate() + (d.getUTCDay() === 6 ? 2 : d.getUTCDay() === 0 ? 1 : 0));
      Q.push({ period: `${y}-${md}`, label: `${y} Q${i + 1}`, due: d.toISOString().slice(0, 10), dow: DOW[d.getUTCDay()] });
    });
    const past = Q.filter(q => q.due < todaySGT), due = past[past.length - 1], next = Q.find(q => q.due >= todaySGT);
    const ql = p => (Q.find(q => q.period === p) || { label: p }).label, lat = f => (f.latest && f.latest.period) || '';
    const excl = new Set(((readJson('policy.json') || {}).funds || {}).excludeKinds || ['quant', 'index']);
    const all = Object.values(f13.funds || {}).filter(f => f && !excl.has(f.kind)), act = all.filter(f => f.status === 'active' && f.inferredStatus !== 'stopped');
    const cur = act.filter(f => lat(f) >= due.period), gap = act.filter(f => f.edgarLatestPeriod && f.edgarLatestPeriod > lat(f));
    const late = act.filter(f => lat(f) < due.period && !gap.includes(f)), odd = all.filter(f => f.status === 'active' && f.inferredStatus === 'stopped');
    const errs = S.errors || [], names = a => a.slice(0, 3).map(f => f.name).join(', ') + (a.length > 3 ? ` +${a.length - 3}` : '');
    return `13F: ${cur.length === act.length ? act.length : `${cur.length} of ${act.length}`} tracked funds current through ${due.label}`
      + (late.length ? ` — not yet filed: ${names(late)} (their lateness, not ours)` : '')
      + (gap.length ? ` · NOT INGESTED: ${gap.slice(0, 3).map(f => `${f.name} filed ${ql(f.edgarLatestPeriod)} on EDGAR`).join(', ')}` : '')
      + (odd.length ? ` · ${names(odd)} looks stopped (no filing for 2 deadlines) — funds.json still says active` : '')
      + ` · next deadline ${next.dow} ${dmy(next.due)} (${next.label}) · checked ${f13Checked()}`
      + (S.ok === false || errs.length ? ` · last scan: ${errs.length} error(s)${errs[0] ? ` — ${errs[0].fund} ${errs[0].stage}` : ''}` : '');
  } catch (e) { return `13F: status line could not be computed (${String(e.message).slice(0, 80)})`; }
}
// Phase 2 (11 Sep 2026): insider and ownership signals now come from data/alerts.json — the
// append-only log written by scripts/alerts.js from the market-wide EDGAR scan — not from the
// retired 15-name poller's queue. Notables since the previous brief lead; held/watch sells get ONE
// count line; market-wide sells never appear here (policy.json).
try {
  const AL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'alerts.json'), 'utf8'));
  // Phase 4: the window is INGEST time (a.at) after the last successful send (.last-brief-at), not
  // filing date after .last-brief-date — a filing dated yesterday that alerts.js only saw this
  // morning must still reach today's brief. Fallback when no send stamp exists: now − 48h.
  const since = sgtStamp(lastBriefAt);
  const fresh = (AL.alerts || []).filter(a => a.at > lastBriefAt);
  const rank = a => (a.tags || []).includes('in-book') ? 0 : (a.tags || []).includes('watchlist') ? 1 : 2;
  const notable = fresh.filter(a => a.severity === 'Notable').sort((a, b) => rank(a) - rank(b) || (b.usd || 0) - (a.usd || 0));
  const sells = fresh.filter(a => a.family === 'insider' && /insider sell/.test(a.headline || ''));
  const lines = notable.slice(0, 8).map(a => `${a.headline} [${(a.tags || []).filter(t => ['in-book', 'watchlist', 'market-wide', 'cluster'].includes(t)).join(' ')}] — ${a.detail}`);
  if (sells.length) lines.push(`${sells.length} insider sell(s) on held/watch names since ${since}${sells.every(a => (a.tags || []).includes('10b5-1')) ? ', all 10b5-1 plans' : ''} — see inbox.html`);
  if (!lines.length) lines.push(`no Notable insider or ownership events since ${since} · ${(AL.alerts || []).length} in the log · inbox.html`);
  lines.push(...f13SignalLines());   // phase 6: one line per 13F filing ingested since the last send
  const scanNote = (() => { try { const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'signals.json'), 'utf8')); const last = (S.scans || []).filter(x => !x.error).slice(-1)[0]; return last ? ` · Form 4 scan ${last.date}: ${last.form4Lines || 0} filings, ${last.kept || 0} with open-market trades` : ''; } catch (_) { return ' · signals.json absent'; } })();
  sections.unshift(['🔔 SIGNALS SINCE LAST BRIEF (insiders & ownership, market-wide)' + scanNote, lines]);
} catch (e) { sections.unshift(['🔔 SIGNALS', ['alerts.json unavailable — scripts/alerts.js did not run (' + e.message + ')']]); }
// Phase 4: the cutover clock — seven clean parallel days (code-fetched NAV beside the page's own)
// before index.html loses its Yahoo path. Read from Agent C's outputs, data/.cutover.json
// (scripts/cutover-check.js) and the local publish ledger data/.publish-history.ndjson; both may be
// absent on the first mornings and that is reported, never assumed.
try {
  const ck = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.cutover.json'), 'utf8')); } catch (_) { return null; } })();
  const ledger = ndjson('.publish-history.ndjson').filter(r => r.status && r.status !== 'dry-run'), last = ledger[ledger.length - 1] || null;
  const clock = ck
    ? `${ck.cleanDays ?? '?'}/${ck.needed || 7} clean parallel days (since ${dmy(ck.since || '2026-09-12')})${ck.ready ? ' · READY for cutover' : ck.earliestReady ? ' · earliest ' + dmy(ck.earliestReady) : ''}`
      + (ck.pageParity && ck.pageParity.checkedOn ? ` · page parity confirmed ${dmy(ck.pageParity.checkedOn)} (${ck.pageParity.diffPct}%)` : ' · page parity not yet confirmed')
    : 'not computed — scripts/cutover-check.js has not run';
  integrityLines.push(`cutover clock: ${clock} · publish ${last ? `${last.status} at ${last.step || '?'} (${last.date || '?'})` : 'no ledger row yet'}`);
} catch (_) {}
integrityLines.push(f13IntegrityLine());   // phase 6: every day — a dead quarterly feed reads like a quiet quarter
if (integrityLines.length) sections.push(['DATA-INTEGRITY CHECKS', integrityLines]);

const stamp = (brief && brief.date) || (model && model.updated) || 'unknown';
// STALENESS GUARD. On 5 Aug the research run died instantly ("Not logged in"),
// so brief.json was yesterday's — and the 36-hour `fresh` window happily sent
// yesterday's analysis under today's date and subject. The validator caught it;
// the sender never asked. Now the sender checks too, and says so LOUDLY in both
// the subject and the first line rather than quietly shipping stale content.
// Singapore date, explicitly — toISOString() is UTC and would report the wrong
// day for a run just after midnight SGT (todaySGT is defined at the top since phase 4).
const briefDay = brief && brief.date ? String(brief.date).slice(0, 10) : null;
const isStale = briefDay !== todaySGT;
// HOW LONG has this been going on? A one-off miss and a fortnight-long outage
// are completely different events and must not read the same. From 8-21 Aug
// 2026 the research aborted on a dead credential fourteen mornings running,
// and every one of those emails still looked like a normal brief carrying one
// small red line — so it never felt urgent enough to act on, and the fix sat
// undone for two weeks. Staleness now escalates and leads with the remedy.
const staleDays = isStale && briefDay
  ? Math.max(1, Math.round((Date.parse(todaySGT) - Date.parse(briefDay)) / 86400000))
  : 0;
// Name the actual cause rather than "did not complete". The research log is the
// only thing that knows, and a command you can paste beats a symptom you can't.
let staleCause = 'the 07:02 research run did not complete', staleFix = '', staleStreak = 0;
try {
  const tail = fs.readFileSync(path.join(process.env.HOME, 'Library/Logs/portfolio-research.log'), 'utf8').slice(-30000);
  if (/ABORT \u2014 not authenticated/.test(tail)) {
    // brief.json can be 2 days old while the automation has been dead for 14 —
    // Dom hand-refreshes some mornings, which masked the real outage. Report the
    // run streak, not just the file date, or the severity reads far too low.
    const aborts = [...tail.matchAll(/^(\d{4}-\d{2}-\d{2}) .*ABORT \u2014 not authenticated/gm)].map(m => m[1]);
    const runs = [...tail.matchAll(/^=== (\d{4}-\d{2}-\d{2}) .*research start/gm)].map(m => m[1]);
    let streak = 0;
    for (let k = runs.length - 1; k >= 0 && aborts.includes(runs[k]); k--) streak++;
    staleStreak = streak;
    staleCause = streak > 1
      ? `the Claude CLI has no credential \u2014 the 07:02 research has failed ${streak} mornings running, since ${aborts[aborts.length - streak]}`
      : 'the Claude CLI has no credential, so no research ran at all';
    staleFix = 'claude setup-token   \u2192   paste the token into ~/.claude/claude-token.env';
  }
} catch (e) {}
// The brief file can look 2 days old while the automation has been dead for 14.
// Escalate on the worse of the two so the severity is never understated.
const outageDays = Math.max(staleDays, staleStreak);
const staleBanner = isStale
  ? `${'\u2588'.repeat(56)}\n`
    + `\u{1F534}  NO RESEARCH TODAY \u2014 DAY ${outageDays} OF THIS OUTAGE\n\n`
    + `Cause: ${staleCause}.\n`
    + (staleFix ? `Fix on the Mac, about 30 seconds:\n    ${staleFix}\n` : '')
    + `\nEverything below is ${briefDay || 'an earlier run'} analysis under a ${today} heading.\n`
    + `Do not trade on it. Prices, probabilities and risk on the dashboard still\n`
    + `recompute live.\n${'\u2588'.repeat(56)}\n\n`
  : '';
// [DEGRADED] (phase 1): when research did not run, do NOT resend yesterday's analysis under
// today's date. Send what code computed this morning (valuation) and NAME the missing sections —
// an omitted section looks like a quiet day; a named gap looks like a failure.
if (isStale) {
  tldr = [];
  sections = [
    ['VALUATION & LEVERAGE (computed in code this morning — unaffected by the research outage)', valuationLines()],
    ['RISK STATE (computed in code)', riskLines()],
    ...sections.filter(([h]) => /^🔔 SIGNALS/.test(h)),
    ['RESEARCH MISSING TODAY', ['TLDR', 'Macro regime and risk-on read', 'News that matters to your book', 'Model signals / watch list',
      `Cause: ${staleCause}`].concat(staleFix ? [`Fix on the Mac: ${staleFix}`] : [])],
  ];
}
// Phase 4: THE ONE ACTION leads every brief \u2014 fresh or degraded \u2014 straight after TLDR, because it
// is computed by code from files that survive a research outage. Then the owner's own replies
// since the last send, so the loop closes visibly.
sections.unshift(['THE ONE ACTION', actionLines()]);
{ const rl = repliesLines(); if (rl.length) sections.splice(1, 0, ['YOUR REPLIES SINCE LAST BRIEF', rl]); }
const actionPush = !!(oneAction && oneAction.action.push);
const bullets = a => a.map(x => `\u2022 ${x}`).join('\n');
// The subject line is the only part he sees on a locked phone. When there is no
// research, it must not say "Morning Brief".
// Phase 4: `[ACTION] ` leads the fresh subject only on a push day (a crossing, or the stressed margin
// call under 25% away) \u2014 a standing condition does not shout. The degraded subject is unchanged.
const sitePublish = (() => { try { const r = ndjson('.publish-history.ndjson').filter(x => x.status && x.status !== 'dry-run').pop(); return r && r.status === 'red' ? r : null; } catch (_) { return null; } })();
const BY = ' \u00b7 Claude';   // every email Claude sends says so, so it can be told from other assistants'
const SUBJ = (isStale
  ? `[DEGRADED] \u{1F534} NO RESEARCH \u2014 day ${outageDays} \u2014 brief is ${briefDay || 'old'} data, not ${today}`
  : `${sitePublish ? '[SITE STALE] ' : ''}${actionPush ? '[ACTION] ' : ''}\u{1F4CA} Portfolio Morning Brief \u2014 ${today}`) + BY;
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
  'Sent by Claude (Anthropic) · Portfolio Command Center · research 07:02 SGT, delivered 08:15 SGT.',
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
  if (/ACTION/i.test(h)) return '🎯';
  if (/REPLIES/i.test(h)) return '↩️';
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
  <div style="font-size:20px;font-weight:800;letter-spacing:-.01em;color:${isStale ? AC.red : '#111827'}">${isStale ? '\u{1F534} Portfolio Brief \u2014 NO RESEARCH TODAY' : '\u{1F4CA} Portfolio Morning Brief'}</div>
  <div style="color:${AC.grey};font-size:13px;padding:3px 0 2px 0">${esc(today)} &nbsp;·&nbsp; data refreshed ${esc(stamp)}</div>
  <div style="border-bottom:2px solid ${AC.accent};width:64px;margin:6px 0 4px 0"></div>
  ${isStale ? `<div style="background-color:#fef2f2;border:2px solid ${AC.red};border-radius:8px;padding:15px 17px;margin:14px 0 4px 0">
    <div style="color:${AC.red};font-weight:800;font-size:17px;line-height:1.35;margin:0 0 7px 0">\u{1F534} NO RESEARCH TODAY \u2014 day ${outageDays} of this outage</div>
    <div style="color:#111827;font-size:14px;line-height:1.5;margin:0 0 9px 0">Cause: ${esc(staleCause)}.</div>
    ${staleFix ? `<div style="color:#111827;font-size:14px;line-height:1.5;margin:0 0 5px 0">Fix on the Mac, about 30 seconds:</div>
    <div style="background-color:#111827;color:#f9fafb;font-family:ui-monospace,Menlo,Monaco,monospace;font-size:13px;line-height:1.5;padding:10px 12px;border-radius:5px;margin:0 0 9px 0">${esc(staleFix)}</div>` : ''}
    <div style="color:#7f1d1d;font-size:13px;line-height:1.5;margin:0">Everything below is <b style="color:#7f1d1d">${esc(briefDay || 'an earlier run')}</b> analysis shown under a ${esc(today)} heading \u2014 <b style="color:#7f1d1d">do not trade on it</b>. The dashboard's prices, probabilities and risk still recompute live.</div>
  </div>` : ''}
  ${htmlSection2('TLDR', tldr)}
  ${sections.map(([h, items]) => htmlSection2(h, items)).join('')}
  <div style="margin:26px 0 0 0;padding:12px 0 0 0;border-top:1px solid ${AC.grey}44">
    <a href="${DASH}" style="color:${AC.blue};font-weight:700;text-decoration:none">📈 Open the live dashboard →</a>
    <div style="color:${AC.grey};font-size:12px;padding:7px 0 0 0">Prices, probabilities and risk recompute in-browser on every open.</div>
    <div style="color:${AC.grey};font-size:12px;padding:8px 0 0 0">Sent by <b style="color:${AC.grey}">Claude</b> (Anthropic) · Portfolio Command Center · research 07:02 SGT, delivered 08:15 SGT.</div>
    <div style="color:${AC.grey};font-size:12px;padding:4px 0 0 0">Decision-support only — not financial advice. Nothing is ever traded automatically.</div>
  </div>
</div>`;

// Phase 4: the One Action's `short` line (≤80 chars, one number) leads the push text — it is the
// one line read on a locked phone. The ntfy body drops the header line (its Title carries it).
const tgHeader = `📊 *Portfolio Brief — ${today}* · Claude`;
const tgText = [
  oneAction && oneAction.action.short ? oneAction.action.short : '',
  tgHeader,
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
  // Line 1 is the harness contract (scripts/test-fixtures.js reads the subject from it); line 2 the
  // email banner. Skip reasons for journal.js / one-action.js go to stderr so stdout stays clean.
  console.log('SUBJECT: ' + SUBJ + '\n===== EMAIL =====\n' + fullText + '\n\n===== TELEGRAM =====\n' + tgText);
  if (preLog.length) console.error(preLog.join('\n'));
  process.exit(0);
}

// once-per-day guard: the 08:15 system job owns delivery; anything else needs --force
const FORCE = process.argv.includes('--force');
const STATE = path.join(process.env.HOME, '.claude', 'portfolio-brief.last');
const todayISO = new Date().toISOString().slice(0, 10);
// Phase 4: ONE stamp for every successful send — SMTP or Mail.app, fresh, degraded or --force.
// data/.last-brief-at (ISO) is the SIGNALS / REPLIES window of the next brief; .last-brief-date
// (SGT) its readable twin. Until now only the dead SMTP branch wrote a stamp, so the live path never
// had one and the "since last brief" window was a silent now − 2d every morning.
function markSent() {
  try { fs.writeFileSync(STATE, todayISO); } catch (_) {}
  try { fs.writeFileSync(path.join(ROOT, 'data', '.last-brief-at'), new Date().toISOString()); fs.writeFileSync(path.join(ROOT, 'data', '.last-brief-date'), todaySGT); } catch (_) {}
}
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
    markSent();
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
  // HTML via Mail.app (`html content` above) — the same card-less fullHtml the dormant SMTP path
  // would send. Mail wraps every scripted body in <blockquote type="cite"> whatever the format;
  // what made the 29 Jul brief read as forwarded was the white CARD inside that wrapper, not HTML
  // itself, and the card is gone (see HTML BRIEF above). Replies quote this HTML under Mail's
  // blockquote; journal.js strips it (`>` lines after "On … wrote:").
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
  if (emailOk) markSent();
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
  // Phase 4: urgent + rotating_light ONLY on a push day; a standing condition stays a normal push.
  const plain = tgText.split('\n').filter(l => l !== tgHeader).join('\n').replace(/[*_\[\]()]/g, '');
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
    '-H', `Title: Claude · Portfolio Brief — ${today}`, '-H', `Tags: ${actionPush ? 'rotating_light' : 'chart_with_upwards_trend'}`,
    '-H', `Priority: ${actionPush ? 'urgent' : 'high'}`, '-d', plain.slice(0, 3800),
    `https://ntfy.sh/${env.NTFY_TOPIC}`], { encoding: 'utf8', timeout: 20000 });
  ntfyOk = (r.stdout || '').trim() === '200';
  log.push('ntfy push: ' + (ntfyOk ? 'sent' : 'FAILED ' + (r.stdout || r.stderr || '').slice(0, 100)));
} else log.push('ntfy push: skipped (no NTFY_TOPIC)');

console.log(preLog.concat(log).join('\n'));
process.exit(emailOk || tgOk || ntfyOk ? 0 : 1);
