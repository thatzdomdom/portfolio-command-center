#!/usr/bin/env node
/*
 * technicals.js — the technical layer, computed from data/.prices-2y.json only. No external call,
 * no LLM anywhere near it.
 *
 * Phase 3 of the 11 Sep 2026 redesign. The July post-mortem (signal-lab.js, 12,871 observations
 * over a decade; portfolio-lab.js, 11.5 years monthly) found ONE durable edge: the trend gate —
 * price above its 200-day average AND positive 12-month momentum (skipping the latest month).
 * Everything else tested was noise or worse; the deployed probability model was an anti-signal.
 * This file puts that finding into production, per instrument, every morning.
 *
 * The gate has hysteresis: it turns OFF only after 5 consecutive closes below the 200-day, which
 * is what stops a one-day dip from whipsawing a position. Volatility is computed as a SIZING
 * input for targets.js and is never a directional signal — the post-mortem found the high-vol
 * bucket was the best-performing over 12 years. The 200-day SLOPE is reported as a secondary
 * state but is NOT in the gate until the silver backtest says it should be.
 */
const fs = require('fs'), path = require('path');
const D = f => path.join(__dirname, '..', 'data', f);
const P = JSON.parse(fs.readFileSync(D('.prices-2y.json'), 'utf8'));
const policy = (() => { try { return JSON.parse(fs.readFileSync(D('policy.json'), 'utf8')); } catch (_) { return {}; } })();
const HYST = (policy.trend && policy.trend.offAfterConsecutiveClosesBelow) || 5;

const sma = (a, n) => a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null;
const std = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const pct = (a, b) => b ? +(((a / b) - 1) * 100).toFixed(2) : null;

const out = { asOf: null, generatedAt: new Date().toISOString(), source: '.prices-2y.json (Yahoo chart, ETF-proxied for metals/energy)',
  gate: { rule: 'ON = close > SMA200 AND 12-1 month momentum > 0; OFF after ' + HYST + ' consecutive closes below SMA200', hysteresis: HYST }, instruments: {}, summary: {} };
let gateOn = 0, gateOff = 0; const crossedBelow = [], crossedAbove = [], newHigh = [], newLow = [], volSpike = [];

for (const [sym, inst] of Object.entries(P.instruments)) {
  const bars = (inst.bars || []).filter(b => !b.partial); if (bars.length < 260) continue;
  const C = bars.map(b => b.c), H = bars.map(b => b.h ?? b.c), L = bars.map(b => b.l ?? b.c), n = C.length;
  const close = C[n - 1], asOf = bars[n - 1].d; if (!out.asOf || asOf > out.asOf) out.asOf = asOf;
  const sma200 = sma(C, 200), sma50 = sma(C, 50), sma200prev = sma(C.slice(0, -20), 200);
  // 12-1 momentum: return from 12 months ago to 1 month ago (skip the latest ~21 sessions)
  const mom12_1 = n >= 252 ? pct(C[n - 22], C[n - 253]) : null;
  const rets = C.slice(1).map((c, i) => Math.log(c / C[i]));
  const vol20 = +(std(rets.slice(-20)) * Math.sqrt(252) * 100).toFixed(1), vol60 = +(std(rets.slice(-60)) * Math.sqrt(252) * 100).toFixed(1);
  // 1y median of rolling 20d vol, for the spike flag
  const roll = []; for (let i = 20; i <= Math.min(rets.length, 252 + 20); i++) roll.push(std(rets.slice(i - 20, i)) * Math.sqrt(252) * 100);
  const volMed = roll.length ? roll.slice().sort((a, b) => a - b)[Math.floor(roll.length / 2)] : null;
  const tr = bars.slice(-15).map((b, i, arr) => i === 0 ? (b.h ?? b.c) - (b.l ?? b.c) : Math.max((b.h ?? b.c) - (b.l ?? b.c), Math.abs((b.h ?? b.c) - arr[i - 1].c), Math.abs((b.l ?? b.c) - arr[i - 1].c)));
  const atr14 = +(tr.slice(-14).reduce((s, x) => s + x, 0) / 14).toFixed(4);
  const h52 = Math.max(...H.slice(-252)), l52 = Math.min(...L.slice(-252)), hAll = Math.max(...H);
  // gate with hysteresis
  let below = 0; for (let i = n - 1; i >= 0 && C[i] < (sma(C.slice(0, i + 1), 200) || Infinity); i--) below++;
  let above = 0; for (let i = n - 1; i >= 0 && C[i] >= (sma(C.slice(0, i + 1), 200) || 0); i--) above++;
  const on = close > sma200 && mom12_1 != null && mom12_1 > 0 && below === 0 ? true : (below >= HYST ? false : (mom12_1 != null && mom12_1 > 0 && below < HYST && above === 0 ? 'pending-off' : (close > sma200 && mom12_1 != null && mom12_1 > 0)));
  // last cross of the 200-day
  let lastCross = null; for (let i = n - 1; i > 200; i--) { const s = sma(C.slice(0, i + 1), 200), sp = sma(C.slice(0, i), 200); if ((C[i] > s) !== (C[i - 1] > sp)) { lastCross = { date: bars[i].d, dir: C[i] > s ? 'above' : 'below' }; break; } }
  const flags = [];
  if (lastCross && (n - 1 - bars.findIndex(b => b.d === lastCross.date)) < 5) { flags.push('crossed-' + lastCross.dir + '-200d-5s'); (lastCross.dir === 'below' ? crossedBelow : crossedAbove).push(sym); }
  if (volMed && vol20 > 1.5 * volMed) { flags.push('vol-spike'); volSpike.push(sym); }
  if (close >= h52 * 0.999) { flags.push('52w-high'); newHigh.push(sym); }
  if (close <= l52 * 1.001) { flags.push('52w-low'); newLow.push(sym); }
  if (on === true) gateOn++; else if (on === false) gateOff++;
  out.instruments[sym] = { name: inst.name, exchange: inst.exchange, trust: inst.trust || 'ok', proxy: inst.proxy || null, close, asOf,
    sma200: +sma200.toFixed(4), sma50: +sma50.toFixed(4), distPct200: pct(close, sma200), sma200SlopePct20d: pct(sma200, sma200prev),
    mom12_1Pct: mom12_1, vol20, vol60, volMedian1y: volMed ? +volMed.toFixed(1) : null,
    volRegime: volMed ? (vol20 > 1.5 * volMed ? 'high' : vol20 < 0.67 * volMed ? 'low' : 'normal') : null,
    atr14, high52w: +h52.toFixed(4), low52w: +l52.toFixed(4), dd52wPct: pct(close, h52), ddAllPct: pct(close, hAll),
    gate: { on, belowStreak: below, aboveStreak: above, lastCross, slopeRising: sma200 > sma200prev }, flags };
}
out.summary = { instruments: Object.keys(out.instruments).length, gateOn, gateOff, crossedBelow5d: crossedBelow, crossedAbove5d: crossedAbove, newHigh52w: newHigh, newLow52w: newLow, volSpike };
fs.writeFileSync(D('technicals.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`technicals.json: ${out.summary.instruments} instruments · as of ${out.asOf} · gate ON ${gateOn} / OFF ${gateOff}` +
  (crossedBelow.length ? ` · crossed BELOW 200d (5s): ${crossedBelow.join(', ')}` : '') + (crossedAbove.length ? ` · crossed above: ${crossedAbove.join(', ')}` : '') +
  (volSpike.length ? ` · vol spike: ${volSpike.join(', ')}` : ''));
const s = out.instruments.SLV; if (s) console.log(`  SLV (silver proxy): gate ${s.gate.on} · ${s.distPct200 > 0 ? '+' : ''}${s.distPct200}% vs 200d · 12-1 mom ${s.mom12_1Pct}% · vol20 ${s.vol20}% (${s.volRegime}) · dd52w ${s.dd52wPct}% · slope ${s.gate.slopeRising ? 'rising' : 'falling'}`);
