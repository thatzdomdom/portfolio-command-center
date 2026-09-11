#!/usr/bin/env node
/*
 * silver-backtest.js — the evidence for the ONE signature the owner is asked for.
 *
 * Phase 3 of the 11 Sep 2026 redesign. Decision 1 in the proposal: sign the silver leverage policy
 * — Rule 1 (survivability: never be a forced seller through a 2-day −20% or 2-week −35%) and
 * Rule 2 (leverage above 1.0x only while the trend gate is ON; on flip, reduce the loan to 1.0x).
 * The owner was told he would see this backtest FIRST, over 2006–2026, so he can see exactly when
 * the rules would have de-levered him (2011, 2013, 2020) and what the sideways years would have
 * cost. This computes that, from SLV daily closes (the ETF proxy: no contract rolls, no thin bars).
 *
 * Three books are run side by side on the same price path:
 *   ALWAYS 1.6x     — leverage held constant, rebalanced monthly (what the position is today)
 *   GATED 1.6x/1.0x — 1.6x while the gate is ON, de-levered to 1.0x on 5 closes below the 200-day,
 *                     re-levered when the gate turns back ON (Rule 2)
 *   UNLEVERED       — the metal, 1.0x
 * Margin calls are checked daily at the STRESSED maintenance rate (1.5x current), against the
 * drawdown since the last rebalance: a call fires when V·(1−m) < L. Loan cost accrues daily.
 * Nothing here is advice; it is arithmetic on the owner's own stated rules.
 */
const fs = require('fs'), path = require('path');
const D = f => path.join(__dirname, '..', 'data', f);
const H = JSON.parse(fs.readFileSync(D('.silver-history.json'), 'utf8'));          // [{d,o,h,l,c}]
const book = JSON.parse(fs.readFileSync(D('book.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(D('policy.json'), 'utf8'));
const SL = policy.silverLeverage || {};
const LEV = SL.targetLeverage || 1.6, HYST = (policy.trend && policy.trend.offAfterConsecutiveClosesBelow) || 5;
const m0 = book.ibkr.maintenanceRate.value, mS = Math.min(0.95, m0 * ((SL.stressMultiplier) || 1.5));
const rate = book.ibkr.loanRate.value;

const bars = H.filter(b => b.c > 0).sort((a, b) => a.d.localeCompare(b.d));
const C = bars.map(b => b.c), N = C.length;
const sma = (i, n) => i + 1 >= n ? C.slice(i + 1 - n, i + 1).reduce((s, x) => s + x, 0) / n : null;

// ── gate path with hysteresis ─────────────────────────────────────────────
const gate = new Array(N).fill(null); let below = 0;
for (let i = 0; i < N; i++) {
  const s = sma(i, 200), mom = i >= 253 ? C[i - 22] / C[i - 253] - 1 : null;
  if (s == null || mom == null) { gate[i] = null; continue; }
  below = C[i] < s ? below + 1 : 0;
  const prev = gate[i - 1];
  if (prev === true) gate[i] = below >= HYST ? false : true;               // stay ON until HYST closes below
  else gate[i] = (C[i] > s && mom > 0) ? true : false;                     // turn ON only on both conditions
}

// ── run a book ────────────────────────────────────────────────────────────
function run(mode) {
  let E = 1, peak = 1, maxDD = 0, lev = mode === 'unlevered' ? 1 : LEV, rebalPx = C[0], rebalE = 1;
  const events = [], calls = []; let calledUntil = -1; const eq = [];
  let year = bars[0].d.slice(0, 4), yStart = 1, byYear = {};
  for (let i = 1; i < N; i++) {
    const r = C[i] / C[i - 1] - 1;
    const want = mode === 'always' ? LEV : mode === 'gated' ? (gate[i] === true ? LEV : 1) : 1;
    if (want !== lev) { events.push({ d: bars[i].d, action: want > lev ? 're-lever' : 'de-lever', from: lev, to: want, price: +C[i].toFixed(2) }); lev = want; rebalPx = C[i]; rebalE = E; }
    // monthly rebalance to target leverage (resets the loan base)
    if (bars[i].d.slice(0, 7) !== bars[i - 1].d.slice(0, 7)) { rebalPx = C[i - 1]; rebalE = E; }
    E *= 1 + lev * r - (lev - 1) * rate / 252;
    // margin check at the STRESSED rate vs the loan struck at the last rebalance: V(1−m) < L
    if (lev > 1) {
      const V = rebalE * lev * (C[i] / rebalPx), L = rebalE * (lev - 1);
      if (V * (1 - mS) < L && calledUntil < i) { calls.push({ d: bars[i].d, price: +C[i].toFixed(2), dropFromRebalPct: +((C[i] / rebalPx - 1) * 100).toFixed(1), leverage: lev }); calledUntil = i + 60; }
    }
    if (E > peak) peak = E; maxDD = Math.min(maxDD, E / peak - 1);
    if (bars[i].d.slice(0, 4) !== year) { byYear[year] = +((E / yStart - 1) * 100).toFixed(1); year = bars[i].d.slice(0, 4); yStart = E; }
    if (i % 5 === 0 || i === N - 1) eq.push([bars[i].d, +E.toFixed(4)]);
  }
  byYear[year] = +((E / yStart - 1) * 100).toFixed(1);
  const yrs = (Date.parse(bars[N - 1].d) - Date.parse(bars[0].d)) / (365.25 * 864e5);
  return { mode, final: +E.toFixed(3), cagrPct: +((Math.pow(E, 1 / yrs) - 1) * 100).toFixed(2), maxDDPct: +(maxDD * 100).toFixed(1), marginCalls: calls, events, byYear, equity: eq };
}
const always = run('always'), gated = run('gated'), unlev = run('unlevered');

// sideways cost: years where the metal moved less than ±10% — what gating cost vs always
const sideways = Object.keys(unlev.byYear).filter(y => Math.abs(unlev.byYear[y]) < 10)
  .map(y => ({ year: y, metalPct: unlev.byYear[y], alwaysPct: always.byYear[y], gatedPct: gated.byYear[y] }));
const whipsaws = gated.events.filter((e, i, a) => e.action === 're-lever' && i > 0 && (Date.parse(e.d) - Date.parse(a[i - 1].d)) < 45 * 864e5).length;
// biggest metal drawdowns (the crashes the rules exist for)
const crashes = []; { let pk = C[0], pkd = bars[0].d, tr = C[0], trd = bars[0].d; for (let i = 1; i < N; i++) { if (C[i] > pk) { if (tr / pk - 1 < -0.25) crashes.push({ from: pkd, to: trd, dropPct: +((tr / pk - 1) * 100).toFixed(1) }); pk = C[i]; pkd = bars[i].d; tr = C[i]; trd = bars[i].d; } else if (C[i] < tr) { tr = C[i]; trd = bars[i].d; } } if (tr / pk - 1 < -0.25) crashes.push({ from: pkd, to: trd, dropPct: +((tr / pk - 1) * 100).toFixed(1) }); }
const gateAtCrash = crashes.map(c => { const i = bars.findIndex(b => b.d >= c.from); const dl = gated.events.filter(e => e.action === 'de-lever' && e.d >= c.from && e.d <= c.to)[0]; return { ...c, deleveredOn: dl ? dl.d : null, deleveredAtPrice: dl ? dl.price : null, deleveredPctFromPeak: dl ? +((dl.price / C[i] - 1) * 100).toFixed(1) : null }; });

const out = {
  asOf: bars[N - 1].d, from: bars[0].d, generatedAt: new Date().toISOString(), source: 'SLV daily closes (Yahoo, full history) — ETF proxy, no contract roll',
  rules: { targetLeverage: LEV, gate: 'close > SMA200 and 12-1 momentum > 0; OFF after ' + HYST + ' closes below', maintenanceRate: m0, stressedRate: +mS.toFixed(3), loanRatePct: +(rate * 100).toFixed(2), marginCallRule: 'V·(1−m_stressed) < L, loan struck at last monthly rebalance',
    status: SL.status || 'default · CIO recommendation · unconfirmed' },
  summary: {
    always: { cagrPct: always.cagrPct, maxDDPct: always.maxDDPct, final: always.final, marginCalls: always.marginCalls.length },
    gated: { cagrPct: gated.cagrPct, maxDDPct: gated.maxDDPct, final: gated.final, marginCalls: gated.marginCalls.length, delevers: gated.events.filter(e => e.action === 'de-lever').length, whipsawsUnder45d: whipsaws },
    unlevered: { cagrPct: unlev.cagrPct, maxDDPct: unlev.maxDDPct, final: unlev.final },
  },
  crashes: gateAtCrash, marginCalls: { always: always.marginCalls, gated: gated.marginCalls }, delevers: gated.events, sidewaysYears: sideways,
  byYear: { metal: unlev.byYear, always: always.byYear, gated: gated.byYear },
  equity: { always: always.equity, gated: gated.equity, unlevered: unlev.equity },
  gateNow: gate[N - 1],
};
fs.writeFileSync(D('silver-backtest.json'), JSON.stringify(out) + '\n');
const S = out.summary;
console.log(`silver-backtest: ${out.from} → ${out.asOf} (${N} sessions) · gate now ${out.gateNow}`);
console.log(`  ALWAYS ${LEV}x : CAGR ${S.always.cagrPct}% · maxDD ${S.always.maxDDPct}% · final ${S.always.final}x · MARGIN CALLS ${S.always.marginCalls} at stressed ${(mS * 100).toFixed(0)}%`);
console.log(`  GATED         : CAGR ${S.gated.cagrPct}% · maxDD ${S.gated.maxDDPct}% · final ${S.gated.final}x · margin calls ${S.gated.marginCalls} · de-levers ${S.gated.delevers} · whipsaws<45d ${S.gated.whipsawsUnder45d}`);
console.log(`  UNLEVERED     : CAGR ${S.unlevered.cagrPct}% · maxDD ${S.unlevered.maxDDPct}% · final ${S.unlevered.final}x`);
console.log('  crashes ≥25% and where the gate stood:'); gateAtCrash.forEach(c => console.log(`    ${c.from} → ${c.to}  ${c.dropPct}%  ${c.deleveredOn ? 'de-levered ' + c.deleveredOn + ' at ' + c.deleveredPctFromPeak + '% off peak' : 'NOT de-levered inside the crash'}`));
if (always.marginCalls.length) console.log('  always-levered calls: ' + always.marginCalls.map(c => c.d + ' (' + c.dropFromRebalPct + '%)').join(', '));
if (sideways.length) console.log('  sideways years (metal within ±10%): ' + sideways.map(s => `${s.year} metal ${s.metalPct}% · always ${s.alwaysPct}% · gated ${s.gatedPct}%`).join(' | '));
