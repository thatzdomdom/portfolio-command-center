#!/usr/bin/env node
/*
 * validate-all.js — verify EVERY published file before it reaches the dashboard.
 *
 * Requested 31 Jul 2026 ("please check all results that you extract and send")
 * after an insider item turned out to be a Dec-2020 article re-stamped with a
 * 2026 date. The price gate (validate-intel.js) covers asserted insider prices;
 * this covers the rest of the surface, mechanically:
 *
 *   news.json      dates not in the future / not stale-as-fresh; sources present
 *                  and document-level; every ticker resolvable
 *   model.json     probabilities in [0,1] and internally coherent with EV sign;
 *                  full universe present; asOf fresh
 *   market.json    Fear&Greed 0-100, breadth percentages 0-100, dates sane
 *   track.json     APPEND-ONLY — past snapshots must never change (rewriting
 *                  history would silently flatter the model's hit rate)
 *   investors.json 13F timing sanity (a quarter cannot be "current" before its
 *                  45-day deadline), stamp freshness
 *   brief.json     dated today, and consistent with model.json's regime
 *
 * Exit 0 clean · 2 warnings only · 1 something is wrong enough to block.
 * Report is written to data/.validation.json for the brief and the dashboard.
 */
const fs = require('fs'), path = require('path');
const D = path.join(__dirname, '..', 'data');
const J = f => { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch (e) { return null; } };
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const daysAgo = d => { const t = Date.parse(String(d).slice(0, 10)); return isNaN(t) ? null : Math.floor((Date.parse(today) - t) / 864e5); };

const problems = [], warnings = [], checks = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);
const ok = msg => checks.push(msg);
const isBareDomain = u => { try { const p = new URL(String(u)).pathname; return p === '' || p === '/'; } catch (_) { return true; } };

// ── news.json ──────────────────────────────────────────────────────────────
const news = J('news.json');
if (!news) fail('news.json', 'missing or unparseable');
else {
  const items = news.items || [];
  let future = 0, stale = 0, noSrc = 0, bareSrc = 0;
  items.forEach(n => {
    const a = daysAgo(n.date);
    if (a == null) { warn('news.json', `item has an unparseable date: "${n.headline || ''}".slice(0,60)`); return; }
    if (a < 0) { future++; fail('news.json', `FUTURE-DATED item (${n.date}): ${String(n.headline).slice(0, 70)}`); }
    if (a > 14) stale++;
    const s = (n.sources || []).filter(Boolean);
    if (!s.length) noSrc++; else if (s.every(isBareDomain)) bareSrc++;
  });
  const freshest = items.map(n => daysAgo(n.date)).filter(x => x != null && x >= 0).sort((a, b) => a - b)[0];
  // Age the news against the latest COMPLETED trading session, not against the calendar.
  // (Added 2026-08-17: this rule fired on a correct Monday-morning catch-up. Written before
  // 09:00 SGT on a Monday, the newest close that CAN exist is Friday's — 3 calendar days old —
  // so a flat ">2 days" test fails every Monday and after every holiday. The bug was mine, and
  // silently padding news.json to satisfy it would have been the wrong fix.)
  // Derive the allowance from the SPINE's own most recent completed session rather than guessing
  // from the day of week. The first version hard-coded "Monday → 3 days", which is wrong the
  // moment a holiday lands (SGX shut for National Day on 10 Aug, JPX for Mountain Day on the
  // 11th) and wrong again after midnight SGT, when Asia has closed but the US has not. The spine
  // already knows exactly which sessions completed, so ask it instead of re-deriving a calendar.
  let allowance = 2, basis = 'default';
  try {
    const spine = JSON.parse(fs.readFileSync(path.join(D, '.prices.json'), 'utf8'));
    // Exclude PARTIAL bars AND crypto entirely. Crypto never closes, so it always has the newest
    // bar — first it was Bitcoin's live same-day level, then its Sunday bar — and neither says
    // anything about whether an equity session has closed that the news sweep ought to cover.
    const lastBar = Object.values(spine.instruments || {})
      .filter(i => i.exchange !== 'CRYPTO')
      .flatMap(i => (i.bars || []).filter(b => !b.partial).map(b => b.d))
      .sort().pop();
    if (lastBar) { allowance = Math.max(0, daysAgo(lastBar)); basis = `latest completed session ${lastBar}`; }
  } catch (_) { /* no spine — fall back to the conservative default */ }
  if (freshest == null) fail('news.json', 'no validly dated items at all');
  else if (freshest > allowance) fail('news.json', `newest item is ${freshest} days old but a session has closed since (${basis}) — the sweep is behind`);
  else ok(`news: ${items.length} items, newest ${freshest === 0 ? 'today' : freshest + 'd old'} (${basis})`);
  if (stale) warn('news.json', `${stale} item(s) older than 14 days still published`);
  if (noSrc) fail('news.json', `${noSrc} item(s) cite no source at all`);
  if (bareSrc) warn('news.json', `${bareSrc} item(s) cite only homepage-level URLs (no specific article)`);
}

// ── model.json ─────────────────────────────────────────────────────────────
const model = J('model.json');
if (!model) fail('model.json', 'missing or unparseable');
else {
  const calls = model.calls || [];
  let badProb = 0, incoherent = 0;
  calls.forEach(c => {
    ['pUp1m', 'pUp3m', 'pUp12m'].forEach(k => { const v = c[k]; if (v != null && (v < 0 || v > 1)) { badProb++; fail('model.json', `${c.ticker} ${k}=${v} is not a probability`); } });
    // a call cannot say "more likely up than not" while expecting a loss, or vice versa
    if (c.pUp3m != null && c.ev3m != null) {
      const bull = c.pUp3m > 0.55, bear = c.pUp3m < 0.45;
      if ((bull && c.ev3m < -0.02) || (bear && c.ev3m > 0.02)) { incoherent++; warn('model.json', `${c.ticker}: pUp3m ${c.pUp3m} vs ev3m ${c.ev3m} point opposite ways`); }
    }
  });
  if (!badProb) ok(`model: ${calls.length} calls, all probabilities in range`);
  if (incoherent) warn('model.json', `${incoherent} call(s) have probability/EV disagreeing in sign`);
  const a = daysAgo(model.macro && model.macro.asOf);
  if (a == null) warn('model.json', 'macro.asOf missing/unparseable');
  else if (a > 3) fail('model.json', `macro commentary stamped ${a} days ago — it is being served as current`);
  else ok(`model: macro re-stamped ${a === 0 ? 'today' : a + 'd ago'}`);
}

// ── market.json ────────────────────────────────────────────────────────────
const market = J('market.json');
if (!market) fail('market.json', 'missing or unparseable');
else {
  const fg = market.fearGreed || {};
  [['value', fg.value], ['cryptoValue', fg.cryptoValue]].forEach(([k, v]) => {
    if (v != null && (v < 0 || v > 100)) fail('market.json', `fearGreed.${k}=${v} outside 0-100`);
  });
  (market.breadth && market.breadth.metrics || []).forEach(m => {
    if (m.pct != null && (m.pct < 0 || m.pct > 100)) fail('market.json', `breadth "${String(m.label).slice(0, 40)}" pct=${m.pct} outside 0-100`);
  });
  const a = daysAgo(market.updated);
  if (a != null && a > 3) fail('market.json', `sentiment/breadth stamped ${a} days ago`);
  else ok(`market: F&G ${fg.value ?? '—'}, stamps current`);
}

// ── track.json — APPEND-ONLY is the whole point ───────────────────────────
const track = J('track.json');
if (!track) warn('track.json', 'missing');
else {
  const snaps = track.snapshots || [];
  const dates = snaps.map(s => s.date);
  const sorted = [...dates].sort();
  if (dates.join() !== sorted.join()) fail('track.json', 'snapshots are not in chronological order — history may have been rewritten');
  const dupes = dates.filter((d, i) => dates.indexOf(d) !== i);
  if (dupes.length) fail('track.json', `duplicate snapshot dates: ${[...new Set(dupes)].join(', ')}`);
  // fingerprint history so a later rewrite of a PAST snapshot is detectable
  const FP = path.join(D, '.track-fingerprint.json');
  const fpNow = {};
  snaps.forEach(s => { if (s.date !== today) fpNow[s.date] = (s.calls || []).length + ':' + (s.calls || []).map(c => c.t + (c.p3 ?? '')).join('|').length; });
  const prev = (() => { try { return JSON.parse(fs.readFileSync(FP, 'utf8')); } catch (_) { return null; } })();
  if (prev) {
    const changed = Object.keys(prev).filter(d => fpNow[d] && fpNow[d] !== prev[d]);
    const vanished = Object.keys(prev).filter(d => !fpNow[d]);
    if (changed.length) fail('track.json', `PAST snapshot(s) altered: ${changed.join(', ')} — the model's hit rate is computed off these`);
    if (vanished.length) fail('track.json', `PAST snapshot(s) deleted: ${vanished.join(', ')}`);
    if (!changed.length && !vanished.length) ok(`track: ${snaps.length} snapshots, history intact`);
  } else ok(`track: ${snaps.length} snapshots, fingerprint baseline created`);
  fs.writeFileSync(FP, JSON.stringify(fpNow));
}

// ── investors.json ─────────────────────────────────────────────────────────
const inv = J('investors.json');
if (!inv) warn('investors.json', 'missing');
else {
  const a = daysAgo(inv.updated);
  if (a == null) warn('investors.json', 'no updated stamp');
  else if (a > 3) fail('investors.json', `stamped ${a} days ago — it is meant to be re-verified every run`);
  else ok(`investors: re-verified ${a === 0 ? 'today' : a + 'd ago'}`);
  // a 13F quarter cannot be presented as current before its filing deadline
  const cur = inv.convictionPlays && inv.convictionPlays.current;
  if (cur) {
    const m = /Q([1-4])\s*(\d{4})/.exec(cur);
    if (m) {
      const qEnd = new Date(Date.UTC(+m[2], +m[1] * 3, 0));
      const due = new Date(qEnd.getTime() + 45 * 864e5);
      if (Date.parse(today) < due.getTime()) fail('investors.json', `presents ${cur} as current, but those 13Fs are not due until ${due.toISOString().slice(0, 10)}`);
      else ok(`investors: ${cur} is past its 13F deadline — legitimately current`);
    }
  }
}

// ── flows-investors.json ───────────────────────────────────────────────────
// Cadences differ wildly by market (Korea daily, Japan/SG weekly, HK/CN/US
// proxies only), so this checks the two things that actually mislead: a stale
// period presented as current, and a proxy presented as a direct measurement.
const flows = J('flows-investors.json');
if (flows) {
  const ms = flows.markets || [];
  let noSrc = 0, bare = 0, unlabelled = 0;
  ms.forEach(m => {
    const s = (m.sources || []).filter(Boolean);
    if (!s.length) { noSrc++; fail('flows-investors.json', `${m.market}: no source cited`); }
    else if (s.every(isBareDomain)) bare++;
    // markets with no official split must not present figures as direct measurement
    if (m.available === false) {
      const direct = (m.flows || []).filter(f => !f.isProxy && !/southbound|connect/i.test(f.investorType || ''));
      if (direct.length) { unlabelled++; fail('flows-investors.json', `${m.market} has no official investor-type split, but ${direct.length} flow(s) are not marked isProxy`); }
    }
    const a = daysAgo(m.asOf);
    if (a != null && a > 21) warn('flows-investors.json', `${m.market} data is ${a} days old — check it is labelled as carried forward`);
  });
  if (bare) warn('flows-investors.json', `${bare} market(s) cite only homepage-level sources`);
  if (!noSrc && !unlabelled) ok(`flows: ${ms.length} markets, sources present, proxies labelled`);
  const a = daysAgo(flows.updated);
  if (a != null && a > 8) warn('flows-investors.json', `file stamp is ${a} days old`);
}

// ── brief.json ─────────────────────────────────────────────────────────────
const brief = J('brief.json');
if (!brief) warn('brief.json', 'missing');
else {
  const a = daysAgo(brief.date);
  if (a == null) fail('brief.json', 'no parseable date');
  else if (a > 0) fail('brief.json', `dated ${a} day(s) ago — the morning email would send stale content under today's date`);
  else ok('brief: written today');
  if (model && model.macro && brief.regime && brief.regime.label &&
      String(brief.regime.label).trim() && String(model.macro.regime).trim() &&
      brief.regime.label !== model.macro.regime) {
    warn('brief.json', `regime label "${brief.regime.label}" differs from model.json's "${model.macro.regime}"`);
  }
}

// ── PRICE RECONCILIATION GATE (added 17 Aug 2026) ──────────────────────────
// This replaces work that used to be done by one verification AGENT PER ITEM — roughly thirty
// agents on a busy day, each re-opening quote pages to check arithmetic, which is most of why a
// single daily run cost ~2.4M tokens. Arithmetic is not a research task. Every price an agent
// asserts is now checked in code against data/.prices.json (the deterministic spine), for free.
//
// The point is not only cost. An agent that "verifies" a number by reading another vendor page
// inherits that vendor's errors — which is exactly how a spot/CFD quote got published as a Brent
// exchange settle, and how OCBC carried two different Tuesday closes for days. Code comparing
// against one anchored series cannot make that mistake.
//
// Only claims that FAIL here need a human-or-agent look, so the expensive path is reserved for
// genuine disagreements instead of being paid on every item.
{
  const PF = path.join(D, '.prices.json');
  if (!fs.existsSync(PF)) {
    warn('prices', 'data/.prices.json missing — run `node scripts/price-spine.js` before validating');
  } else {
    const spine = JSON.parse(fs.readFileSync(PF, 'utf8'));
    const ageMin = Math.floor((Date.now() - Date.parse(spine.generated)) / 60000);
    if (ageMin > 24 * 60) warn('prices', `spine is ${Math.floor(ageMin / 60)}h old — re-run price-spine.js`);

    // Build "TICKER @ price" candidates out of the published prose. Deliberately conservative:
    // it only fires on a $/HK$/S$-prefixed number sitting near a ticker we actually track, so a
    // percentage or a share count is never mistaken for a price.
    const CUR = '(?:US\\$|HK\\$|S\\$|\\$)';
    const bySym = spine.instruments || {};
    const alias = { 'Tencent': '0700.HK', 'Xiaomi': '1810.HK', 'SMIC': '0981.HK', 'DBS': 'D05.SI',
      'OCBC': 'O39.SI', 'Singtel': 'Z74.SI', 'UOL': 'U14.SI', 'Keppel REIT': 'K71U.SI',
      'Newmont': 'NEM', 'Barrick': 'GOLD', 'Pan American': 'PAAS', 'MP Materials': 'MP',
      'Brent': 'BZ=F', 'WTI': 'CL=F', 'GDX': 'GDX', 'SILJ': 'SILJ', 'Bitcoin': 'BTC-USD' };

    let checked = 0, matched = 0; const mismatches = [];
    const scan = (text, where) => {
      if (!text) return;
      for (const [name, sym] of Object.entries(alias)) {
        const inst = bySym[sym]; if (!inst) continue;
        const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^.!?]{0,80}?' + CUR + '\\s?([\\d,]+\\.?\\d*)', 'gi');
        let m;
        while ((m = re.exec(text)) !== null) {
          const claimed = parseFloat(m[1].replace(/,/g, ''));
          if (!isFinite(claimed) || claimed <= 0) continue;
          // Reject figures that are not share prices at all. The first version of this gate
          // flagged Barrick's "$1,993/oz" cost of sales and Pan American's "$305m" of net
          // earnings as bad prices, because both sit within 80 characters of the company name.
          // Two filters, in order of reliability:
          //   (a) an explicit unit right after the number (/oz, m, bn, per ounce…);
          //   (b) magnitude — a real price claim lives near the instrument's actual trading band.
          //       Anything outside 0.3x-3x of the recent range is a revenue, a cost, a market cap
          //       or a target, not a quote, so it is silently skipped rather than reported.
          const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
          if (/^\s*(?:\/|per\b|m\b|mn\b|bn\b|k\b|million|billion|trillion|%)/i.test(tail)) continue;
          const lows = inst.bars.map(b => b.l), highs = inst.bars.map(b => b.h);
          const lo = Math.min(...lows) * 0.3, hi = Math.max(...highs) * 3;
          if (claimed < lo || claimed > hi) continue;
          // A claim counts as reconciled if it matches ANY completed close in the window —
          // items legitimately quote several sessions, and highs/lows are quoted too.
          const hit = inst.bars.some(b =>
            Math.abs(b.c - claimed) <= Math.max(0.011, b.c * 0.0025) ||
            Math.abs(b.h - claimed) <= Math.max(0.011, b.h * 0.0025) ||
            Math.abs(b.l - claimed) <= Math.max(0.011, b.l * 0.0025));
          checked++;
          if (hit) matched++;
          else mismatches.push({ where, sym, claimed, near: inst.bars.slice(-4).map(b => b.c) });
        }
      }
    };
    (news.items || []).forEach((n, i) => { scan(n.summary, `news[${i}]`); scan(n.actionable, `news[${i}]`); });
    if (brief) { (brief.tldr || []).forEach((t, i) => scan(t, `brief.tldr[${i}]`)); (brief.signals || []).forEach((t, i) => scan(t, `brief.signals[${i}]`)); }
    if (model && model.macro) scan(model.macro.narrative, 'model.macro.narrative');

    if (!checked) ok('prices: spine loaded; no ticker-anchored price claims to reconcile');
    else if (!mismatches.length) ok(`prices: ${matched}/${checked} asserted prices reconcile against the spine`);
    else {
      mismatches.slice(0, 6).forEach(x =>
        fail('prices', `${x.where} asserts ${x.sym} at ${x.claimed}, which matches no traded close/high/low (recent closes: ${x.near.join(', ')})`));
      if (mismatches.length > 6) fail('prices', `…and ${mismatches.length - 6} more unreconciled price claim(s)`);
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────
const report = { checkedOn: today, at: new Date().toISOString(), problems, warnings, passed: checks };
fs.writeFileSync(path.join(D, '.validation.json'), JSON.stringify(report, null, 1) + '\n');

console.log(`validate-all — ${today}\n`);
checks.forEach(c => console.log('  ✓ ' + c));
if (warnings.length) { console.log(''); warnings.forEach(w => console.log('  ⚠ ' + w)); }
if (problems.length) { console.log(''); problems.forEach(p => console.log('  ❌ ' + p)); }
console.log(`\n${checks.length} passed · ${warnings.length} warning(s) · ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : warnings.length ? 2 : 0);
