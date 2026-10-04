#!/usr/bin/env node
/*
 * portfolio-lab.js — the test that actually answers "don't lose money".
 *
 * Per-call expectancy (signal-lab.js) says nothing about drawdown, because it
 * ignores how much you SIZED each call and how correlated the calls were. The
 * live blow-up was not one bad forecast: it was eight correlated rare-earth
 * calls held at full size with no exit. So this harness builds actual
 * portfolios month by month and measures CAGR, max drawdown, Sharpe and worst
 * month under different selection / weighting / risk rules.
 *
 * Reads the observation cache written by signal-lab.js.
 */
const fs = require('fs'), path = require('path');
const CACHE = path.join(__dirname, '..', '.signal-lab-cache');
const obs = JSON.parse(fs.readFileSync(path.join(CACHE, 'obs.json'), 'utf8'));

// price series (for month-by-month portfolio returns)
const series = {};
for (const f of fs.readdirSync(CACHE)) {
  if (f === 'obs.json') continue;
  const sym = f.replace(/\.json$/, '').replace(/_/g, '-');
  try { series[sym] = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch (_) {}
}
const SYMS = Object.keys(series);
const idx = {}; SYMS.forEach(s => { idx[s] = {}; series[s].forEach((x, i) => idx[s][x.d] = i); });
const closes = {}; SYMS.forEach(s => closes[s] = series[s].map(x => x.c));
const dates = [...new Set(SYMS.flatMap(s => series[s].map(x => x.d)))].sort();

// observation lookup: sym -> date -> features
const O = {}; obs.forEach(o => { (O[o.s] = O[o.s] || {})[o.d] = o; });
// nearest observation on/before a date
function feat(sym, d) { const m = O[sym]; if (!m) return null; let best = null;
  for (const k in m) { if (k <= d && (!best || k > best)) best = k; }
  return best && (Date.parse(d) - Date.parse(best)) < 20 * 864e5 ? m[best] : null; }
function priceOn(sym, d) { const s = series[sym]; if (!s) return null; let lo = 0, hi = s.length - 1, r = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].d <= d) { r = s[m].c; lo = m + 1; } else hi = m - 1; } return r; }

// monthly rebalance dates
const months = [...new Set(dates.filter(d => d >= '2015-01-01').map(d => d.slice(0, 7)))].sort();
const rebalDates = months.map(m => dates.filter(d => d.startsWith(m)).pop()).filter(Boolean);

function run(name, opts) {
  const { select, weight = 'equal', themeCap = 99, maxPos = 99, trendExit = false, targetVol = null, cashIfEmpty = true } = opts;
  let nav = 1, peak = 1, maxDD = 0; const rets = []; let held = {};
  for (let i = 0; i < rebalDates.length - 1; i++) {
    const d = rebalDates[i], dn = rebalDates[i + 1];
    // candidates
    let cands = SYMS.map(s => ({ s, f: feat(s, d) })).filter(x => x.f && select(x.f));
    // theme budget: cap positions per correlated cluster
    if (themeCap < 99) { const cnt = {}; cands = cands.filter(x => { const t = x.f.th; cnt[t] = (cnt[t] || 0) + 1; return cnt[t] <= themeCap; }); }
    if (cands.length > maxPos) cands = cands.sort((a, b) => b.f.p - a.f.p).slice(0, maxPos);
    // weights
    let w = {};
    if (!cands.length) { if (!cashIfEmpty) { rets.push(0); continue; } }
    if (weight === 'equal') cands.forEach(x => w[x.s] = 1 / cands.length);
    else if (weight === 'invvol') { const inv = cands.map(x => 1 / Math.max(0.05, x.f.v)); const tot = inv.reduce((a, b) => a + b, 0); cands.forEach((x, k) => w[x.s] = inv[k] / tot); }
    // vol targeting: scale gross exposure so ex-ante portfolio vol ~ target
    let gross = 1;
    if (targetVol) { const pv = cands.reduce((s, x) => s + w[x.s] * x.f.v, 0) || 0.15; gross = Math.min(1, targetVol / pv); }
    // realise one month
    let r = 0;
    for (const s in w) {
      const p0 = priceOn(s, d), p1 = priceOn(s, dn); if (!p0 || !p1) continue;
      let mr = p1 / p0 - 1;
      if (trendExit) { const f = feat(s, d); if (f && !(f.a2 && f.r2)) mr = 0; }   // sit in cash if trend broken
      r += w[s] * mr;
    }
    r *= gross;
    rets.push(r); nav *= (1 + r); peak = Math.max(peak, nav); maxDD = Math.min(maxDD, nav / peak - 1);
  }
  const yrs = rets.length / 12;
  const cagr = Math.pow(nav, 1 / yrs) - 1;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const sharpe = (mean * 12) / (sd * Math.sqrt(12));
  const worst = Math.min(...rets);
  const neg = rets.filter(x => x < 0), dsd = Math.sqrt(neg.reduce((a, b) => a + b * b, 0) / Math.max(1, neg.length));
  const sortino = (mean * 12) / (dsd * Math.sqrt(12));
  console.log(name.padEnd(46),
    'CAGR ' + (cagr * 100).toFixed(1).padStart(5) + '%',
    'maxDD ' + (maxDD * 100).toFixed(1).padStart(6) + '%',
    'Sharpe ' + sharpe.toFixed(2).padStart(5),
    'Sortino ' + sortino.toFixed(2).padStart(5),
    'worst mo ' + (worst * 100).toFixed(1).padStart(6) + '%',
    'x' + nav.toFixed(2));
  return { cagr, maxDD, sharpe };
}

console.log(`portfolio backtest ${rebalDates[0]} → ${rebalDates[rebalDates.length - 1]}, monthly rebalance\n`);
const ALL = () => true;
const PUP = f => f.p >= 0.55;
const TREND = f => f.a2 && f.r2;
const TRENDPUP = f => f.p >= 0.55 && f.a2 && f.r2;

console.log('══ BENCHMARKS ══');
run('equal-weight everything (no signal)', { select: ALL });
run('SPY only', { select: f => false, cashIfEmpty: false });   // placeholder; SPY handled below
(() => { // SPY buy & hold
  let nav = 1, peak = 1, maxDD = 0, rets = [];
  for (let i = 0; i < rebalDates.length - 1; i++) { const p0 = priceOn('SPY', rebalDates[i]), p1 = priceOn('SPY', rebalDates[i + 1]); if (!p0 || !p1) continue; const r = p1 / p0 - 1; rets.push(r); nav *= 1 + r; peak = Math.max(peak, nav); maxDD = Math.min(maxDD, nav / peak - 1); }
  const yrs = rets.length / 12, cagr = Math.pow(nav, 1 / yrs) - 1;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length, sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  console.log('SPY buy & hold'.padEnd(46), 'CAGR ' + (cagr * 100).toFixed(1).padStart(5) + '%', 'maxDD ' + (maxDD * 100).toFixed(1).padStart(6) + '%', 'Sharpe ' + ((mean * 12) / (sd * Math.sqrt(12))).toFixed(2).padStart(5), '', '', 'x' + nav.toFixed(2));
})();

console.log('\n══ THE DEPLOYED MODEL ══');
run('pUp>=.55, equal weight (as deployed)', { select: PUP });
run('pUp>=.55, equal weight, top 8 by pUp', { select: PUP, maxPos: 8 });

console.log('\n══ ADD THE TREND GATE ══');
run('trend only, equal weight', { select: TREND });
run('trend + pUp>=.55, equal weight', { select: TRENDPUP });

console.log('\n══ THE SIZING FIX (inverse-vol instead of equal weight) ══');
run('trend, INVERSE-VOL weight', { select: TREND, weight: 'invvol' });
run('trend + pUp, INVERSE-VOL weight', { select: TRENDPUP, weight: 'invvol' });

console.log('\n══ THE CORRELATION FIX (theme budget) ══');
run('trend, inv-vol, max 2 per theme', { select: TREND, weight: 'invvol', themeCap: 2 });
run('trend, inv-vol, max 1 per theme', { select: TREND, weight: 'invvol', themeCap: 1 });

console.log('\n══ FULL STACK: trend + inv-vol + theme cap + vol target ══');
run('+ vol target 10%', { select: TREND, weight: 'invvol', themeCap: 2, targetVol: 0.10 });
run('+ vol target 12%', { select: TREND, weight: 'invvol', themeCap: 2, targetVol: 0.12 });
run('+ vol target 15%', { select: TREND, weight: 'invvol', themeCap: 2, targetVol: 0.15 });
run('full stack + top 10 positions', { select: TREND, weight: 'invvol', themeCap: 2, targetVol: 0.12, maxPos: 10 });

console.log('\n══ DOES pUp ADD ANYTHING ONCE SIZING IS FIXED? ══');
run('full stack WITHOUT pUp', { select: TREND, weight: 'invvol', themeCap: 2, targetVol: 0.12 });
run('full stack WITH pUp>=.55', { select: TRENDPUP, weight: 'invvol', themeCap: 2, targetVol: 0.12 });
run('full stack WITH pUp>=.58', { select: f => f.p >= 0.58 && f.a2 && f.r2, weight: 'invvol', themeCap: 2, targetVol: 0.12 });
