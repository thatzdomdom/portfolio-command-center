#!/usr/bin/env node
/*
 * silver-backtest.js — the evidence for the ONE signature the owner is asked for (decision 1).
 *
 * Phase 3 of the 11 Sep 2026 redesign. Rule 1: never be a forced seller through a 2-day −20% or a
 * 2-week −35%, at 1.5x the maintenance rate. Rule 2: leverage above 1.0x only while the trend gate
 * is ON; on flip, repay the loan to 1.0x — remove the borrowing, not the thesis.
 *
 * THE MODEL IS A MARGIN ACCOUNT, NOT A CONSTANT-LEVERAGE FUND. v1 of this file re-struck the loan
 * to 1.6x every month, which (a) borrowed more into every decline and (b) reset the margin base so
 * no call could ever fire — it reported a −94.8% drawdown with zero margin calls, which is
 * impossible. Here the loan is a FIXED dollar amount that accrues interest daily; leverage drifts
 * with price exactly as it does in the owner's IBKR account. A margin call is checked daily at the
 * STRESSED maintenance rate (1.5x current) and, when it fires, forces a sale at that day's price to
 * repay the loan in full — the crystallised loss Rule 1 exists to prevent.
 *
 * Books on one SLV price path (daily, 2006 →; the ETF proxy has no contract rolls):
 *   UNLEVERED   1.0x, the metal.
 *   FIXED       borrow to 1.6x once, at the start, and never manage it (the "do nothing" book).
 *               After a forced sale it stays unlevered — that is what happens to the unmanaged.
 *   GATED       Rule 2 with the validated gate (close > 200-day AND 12-1 momentum > 0; OFF after
 *               5 closes below the 200-day). Borrow to 1.6x when ON, repay to 1.0x when OFF.
 *   GATED-FAST  the same, but exiting on 5 closes below the 50-DAY — the faster variant the CIO
 *               asked to test. Reported for comparison only; not the rule.
 */
const fs = require('fs'), path = require('path');
const D = f => path.join(__dirname, '..', 'data', f);
const H = JSON.parse(fs.readFileSync(D('.silver-history.json'), 'utf8'));
const book = JSON.parse(fs.readFileSync(D('book.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(D('policy.json'), 'utf8'));
const SL = policy.silverLeverage || {}, HYST = (policy.trend && policy.trend.offAfterConsecutiveClosesBelow) || 5;
const LEV = SL.targetLeverage || 1.6, m0 = book.ibkr.maintenanceRate.value, mS = Math.min(0.95, m0 * (SL.stressMultiplier || 1.5)), rate = book.ibkr.loanRate.value;

const bars = H.filter(b => b.c > 0).sort((a, b) => a.d.localeCompare(b.d)), C = bars.map(b => b.c), N = C.length;
const sma = (i, n) => i + 1 >= n ? C.slice(i + 1 - n, i + 1).reduce((s, x) => s + x, 0) / n : null;
const S200 = C.map((_, i) => sma(i, 200)), S50 = C.map((_, i) => sma(i, 50));

// ── gate paths with hysteresis ────────────────────────────────────────────
function gatePath(exitSma) {
  const g = new Array(N).fill(null); let below = 0;
  for (let i = 0; i < N; i++) {
    const s = S200[i], x = exitSma[i], mom = i >= 253 ? C[i - 22] / C[i - 253] - 1 : null;
    if (s == null || x == null || mom == null) { g[i] = null; continue; }
    below = C[i] < x ? below + 1 : 0;
    if (g[i - 1] === true) g[i] = below >= HYST ? false : true;
    else g[i] = (C[i] > s && C[i] > x && mom > 0) ? true : false;
  }
  return g;
}
const G200 = gatePath(S200), G50 = gatePath(S50);

// ── one book ──────────────────────────────────────────────────────────────
function run(mode, gate) {
  let oz = 1 / C[0], L = 0, levered = false, forced = false;
  const strike = i => { const E = oz * C[i] - L; L = (LEV - 1) * E; oz += L / C[i]; levered = true; };
  const repay = i => { oz -= L / C[i]; L = 0; levered = false; };
  if (mode !== 'unlevered') strike(0);
  let peak = 1, maxDD = 0, ddDate = null, yStart = 1, year = bars[0].d.slice(0, 4);
  const events = [], calls = [], byYear = {}, eq = [], levPath = [];
  for (let i = 1; i < N; i++) {
    L *= 1 + rate / 252;
    const V = oz * C[i]; let E = V - L;
    // Rule 2 transitions (gated books)
    if (gate) {
      if (levered && gate[i] === false) { repay(i); events.push({ d: bars[i].d, action: 'de-lever', price: +C[i].toFixed(2), equity: +E.toFixed(3) }); }
      else if (!levered && gate[i] === true && !(mode === 'fixed')) { strike(i); events.push({ d: bars[i].d, action: 're-lever', price: +C[i].toFixed(2), equity: +E.toFixed(3) }); }
    }
    // margin call at the stressed rate: E < m·V  — a forced sale to repay the loan at this price
    if (levered && E < mS * V) {
      calls.push({ d: bars[i].d, price: +C[i].toFixed(2), leverageAtCall: +(V / E).toFixed(2), equityDrawdownPct: +((E / peak - 1) * 100).toFixed(1) });
      repay(i); forced = true; if (mode === 'fixed') levered = false;
    }
    E = oz * C[i] - L;
    if (E > peak) peak = E; if (E / peak - 1 < maxDD) { maxDD = E / peak - 1; ddDate = bars[i].d; }
    if (bars[i].d.slice(0, 4) !== year) { byYear[year] = +((E / yStart - 1) * 100).toFixed(1); year = bars[i].d.slice(0, 4); yStart = E; }
    if (i % 5 === 0 || i === N - 1) { eq.push([bars[i].d, +E.toFixed(4)]); levPath.push([bars[i].d, levered ? +((oz * C[i]) / E).toFixed(2) : 1]); }
  }
  byYear[year] = +(((oz * C[N - 1] - L) / yStart - 1) * 100).toFixed(1);
  const E = oz * C[N - 1] - L, yrs = (Date.parse(bars[N - 1].d) - Date.parse(bars[0].d)) / (365.25 * 864e5);
  return { mode, final: +E.toFixed(3), cagrPct: +((Math.pow(E, 1 / yrs) - 1) * 100).toFixed(2), maxDDPct: +(maxDD * 100).toFixed(1), maxDDDate: ddDate,
    marginCalls: calls, events, byYear, equity: eq, leverage: levPath, leveredNow: levered, leverageNow: levered ? +((oz * C[N - 1]) / E).toFixed(2) : 1 };
}
const unlev = run('unlevered', null), fixed = run('fixed', null), gated = run('gated', G200), fast = run('gated', G50);

// ── the crashes Rule 1 is written for: worst rolling 2-week (10-session) drops ──
const drops = []; for (let i = 10; i < N; i++) drops.push({ i, end: bars[i].d, start: bars[i - 10].d, pct: +((C[i] / C[i - 10] - 1) * 100).toFixed(1) });
drops.sort((a, b) => a.pct - b.pct);
const worst = []; for (const d of drops) { if (worst.length >= 8) break; if (worst.some(w => Math.abs(Date.parse(w.end) - Date.parse(d.end)) < 60 * 864e5)) continue;
  worst.push({ ...d, gateOnAtStart: G200[d.i - 10], gatedBookWasLevered: !gated.events.length ? true : (() => { const ev = gated.events.filter(e => e.d <= d.start).pop(); return ev ? ev.action === 're-lever' : true; })(),
    fixedBookCalledInside: fixed.marginCalls.some(c => c.d >= d.start && c.d <= d.end) }); }
worst.forEach(w => delete w.i);
// peak-to-trough episodes ≥ 25%
const crashes = []; { let pk = C[0], pkd = bars[0].d, tr = C[0], trd = bars[0].d; for (let i = 1; i < N; i++) { if (C[i] > pk) { if (tr / pk - 1 < -0.25) crashes.push({ from: pkd, to: trd, dropPct: +((tr / pk - 1) * 100).toFixed(1) }); pk = C[i]; pkd = bars[i].d; tr = C[i]; trd = bars[i].d; } else if (C[i] < tr) { tr = C[i]; trd = bars[i].d; } } if (tr / pk - 1 < -0.25) crashes.push({ from: pkd, to: trd, dropPct: +((tr / pk - 1) * 100).toFixed(1) }); }
const crashRows = crashes.map(c => { const i0 = bars.findIndex(b => b.d >= c.from); const dl = gated.events.filter(e => e.action === 'de-lever' && e.d >= c.from && e.d <= c.to)[0]; const df = fast.events.filter(e => e.action === 'de-lever' && e.d >= c.from && e.d <= c.to)[0];
  return { ...c, gated: dl ? { on: dl.d, pctOffPeak: +((dl.price / C[i0] - 1) * 100).toFixed(1) } : null, gatedFast: df ? { on: df.d, pctOffPeak: +((df.price / C[i0] - 1) * 100).toFixed(1) } : null, fixedCalled: fixed.marginCalls.filter(k => k.d >= c.from && k.d <= c.to).map(k => k.d) }; });
const sideways = Object.keys(unlev.byYear).filter(y => Math.abs(unlev.byYear[y]) < 10).map(y => ({ year: y, metal: unlev.byYear[y], fixed: fixed.byYear[y], gated: gated.byYear[y], gatedFast: fast.byYear[y] }));
const whips = ev => ev.filter((e, i, a) => e.action === 're-lever' && i > 0 && (Date.parse(e.d) - Date.parse(a[i - 1].d)) < 45 * 864e5).length;

// Rule 1 closed form: a book struck at leverage Lv survives a drop d at rate m iff Lv·(1−d)(1−m) ≥ Lv−1
// ⇔ Lv ≤ 1 / (1 − (1−d)(1−m)). The binding leg is the 2-week −35%.
const maxLev = (d, m) => +(1 / (1 - (1 - d) * (1 - m))).toFixed(3);
const rule1 = { stressedRate: +mS.toFixed(3), maxLeverageTwoDay20: maxLev(0.20, mS), maxLeverageTwoWeek35: maxLev(0.35, mS), maxLeverageCurrentRate35: maxLev(0.35, m0),
  binding: Math.min(maxLev(0.20, mS), maxLev(0.35, mS)), targetLeverage: LEV, targetPassesRule1: LEV <= Math.min(maxLev(0.20, mS), maxLev(0.35, mS)),
  note: 'largest leverage AT STRIKE that survives the leg without a call; leverage drifts up as price falls, so a live book needs headroom below this' };
const sum = b => ({ cagrPct: b.cagrPct, maxDDPct: b.maxDDPct, maxDDDate: b.maxDDDate, final: b.final, marginCalls: b.marginCalls.length, delevers: b.events.filter(e => e.action === 'de-lever').length, whipsawsUnder45d: whips(b.events), leverageNow: b.leverageNow });
const out = {
  asOf: bars[N - 1].d, from: bars[0].d, sessions: N, generatedAt: new Date().toISOString(), source: 'SLV daily closes 2006→ (Yahoo, epoch-windowed) — ETF proxy, no contract roll',
  rules: { targetLeverage: LEV, maintenanceRate: m0, stressedRate: +mS.toFixed(3), loanRatePct: +(rate * 100).toFixed(2), gate: `close > SMA200 and 12-1 momentum > 0; OFF after ${HYST} closes below SMA200`,
    gateFast: `same entry; OFF after ${HYST} closes below SMA50 (comparison only)`, marginCall: 'daily: equity < m_stressed × value → forced sale at that price to repay the loan', loan: 'fixed dollar amount, interest accrues daily; leverage drifts', status: SL.status || 'unsigned' },
  summary: { unlevered: sum(unlev), fixed: sum(fixed), gated: sum(gated), gatedFast: sum(fast) },
  worstTwoWeekDrops: worst, crashes: crashRows, marginCalls: { fixed: fixed.marginCalls, gated: gated.marginCalls, gatedFast: fast.marginCalls },
  delevers: { gated: gated.events, gatedFast: fast.events }, sidewaysYears: sideways,
  byYear: { metal: unlev.byYear, fixed: fixed.byYear, gated: gated.byYear, gatedFast: fast.byYear },
  equity: { unlevered: unlev.equity, fixed: fixed.equity, gated: gated.equity, gatedFast: fast.equity }, leverage: { fixed: fixed.leverage, gated: gated.leverage },
  gateNow: { validated: G200[N - 1], fast: G50[N - 1] }, rule1,
};
fs.writeFileSync(D('silver-backtest.json'), JSON.stringify(out) + '\n');
const S = out.summary, line = (k, b) => `  ${k.padEnd(11)} CAGR ${String(b.cagrPct).padStart(6)}% · maxDD ${String(b.maxDDPct).padStart(6)}% (${b.maxDDDate}) · final ${b.final}x · calls ${b.marginCalls} · de-levers ${b.delevers} · whipsaws ${b.whipsawsUnder45d}`;
console.log(`silver-backtest: ${out.from} → ${out.asOf} (${N} sessions) · stressed maintenance ${(mS * 100).toFixed(0)}% · loan ${(rate * 100).toFixed(1)}% · gate now: validated ${out.gateNow.validated}, fast ${out.gateNow.fast}`);
console.log(line('UNLEVERED', S.unlevered)); console.log(line('FIXED 1.6x', S.fixed)); console.log(line('GATED', S.gated)); console.log(line('GATED-FAST', S.gatedFast));
console.log('  fixed-book margin calls: ' + (fixed.marginCalls.map(c => `${c.d} @$${c.price} (lev ${c.leverageAtCall}x, equity ${c.equityDrawdownPct}% off peak)`).join(' · ') || 'none'));
console.log('  worst 2-week drops — was the gated book already de-levered?');
worst.forEach(w => console.log(`    ${w.start} → ${w.end}  ${String(w.pct).padStart(6)}%   gated book ${w.gatedBookWasLevered ? 'STILL LEVERED' : 'de-levered'}${w.fixedBookCalledInside ? '   fixed book CALLED' : ''}`));
console.log('  ≥25% crashes: ' + crashRows.map(c => `${c.from}→${c.to} ${c.dropPct}% [gated de-lever ${c.gated ? c.gated.on + ' @ ' + c.gated.pctOffPeak + '%' : 'NONE'}; fast ${c.gatedFast ? c.gatedFast.pctOffPeak + '%' : 'NONE'}]`).join(' | '));
console.log(`  Rule 1: max leverage at strike that survives 2-week −35% at ${(mS*100).toFixed(0)}% = ${rule1.maxLeverageTwoWeek35}x (2-day −20%: ${rule1.maxLeverageTwoDay20}x; at the current ${(m0*100).toFixed(0)}% rate: ${rule1.maxLeverageCurrentRate35}x) · policy target ${LEV}x ${rule1.targetPassesRule1 ? 'PASSES' : 'FAILS'}`);
if (sideways.length) console.log('  sideways years: ' + sideways.map(s => `${s.year} metal ${s.metal}% fixed ${s.fixed}% gated ${s.gated}%`).join(' | '));
