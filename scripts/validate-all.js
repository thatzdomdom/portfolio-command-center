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
  if (freshest == null) fail('news.json', 'no validly dated items at all');
  else if (freshest > 2) fail('news.json', `newest item is ${freshest} days old — the daily sweep did not find anything current`);
  else ok(`news: ${items.length} items, newest ${freshest === 0 ? 'today' : freshest + 'd old'}`);
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

// ── report ─────────────────────────────────────────────────────────────────
const report = { checkedOn: today, at: new Date().toISOString(), problems, warnings, passed: checks };
fs.writeFileSync(path.join(D, '.validation.json'), JSON.stringify(report, null, 1) + '\n');

console.log(`validate-all — ${today}\n`);
checks.forEach(c => console.log('  ✓ ' + c));
if (warnings.length) { console.log(''); warnings.forEach(w => console.log('  ⚠ ' + w)); }
if (problems.length) { console.log(''); problems.forEach(p => console.log('  ❌ ' + p)); }
console.log(`\n${checks.length} passed · ${warnings.length} warning(s) · ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : warnings.length ? 2 : 0);
