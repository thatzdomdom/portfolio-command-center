#!/usr/bin/env node
/*
 * targets.js — the policy's target weights, published in SHADOW. Diffed against the actual book
 * every morning, divergence logged, NO action asked. Ratification is the owner's, after 90 days.
 *
 * Phase 3 of the 11 Sep 2026 redesign. The regime is the one the July post-mortem found — gate +
 * cluster cap + inverse-vol, no vol ceiling, no P&L de-grossing — which gave ~13% CAGR at ~−25%
 * max drawdown at the risk-sleeve level. Weights are of the QUOTED sleeve; property, SSB and cash
 * have no return series and are not pretended to.
 *
 *   universe   every quoted holding in book.json (futures routed to their ETF proxy for returns)
 *   eligible   gate ON (technicals.json)
 *   raw weight min(0.04 / σ60, 0.10)            — inverse-vol, hard 10% single-name cap
 *   clusters   merge any pair with 60-day return correlation ρ > 0.75 (union-find), so the eight
 *              rare-earth names are one position and Tencent/SMIC/Xiaomi another, by correlation
 *              rather than by label
 *   cap        no cluster above 20% of the quoted sleeve; excess goes to cash, not redistributed
 *   risk share w_i (Σw)_i / wᵀΣw per cluster — concentration measured by CONTRIBUTION TO VARIANCE,
 *              not capital weight, because cash and property dilute the capital denominator
 */
const fs = require('fs'), path = require('path');
const D = f => path.join(__dirname, '..', 'data', f);
const J = f => JSON.parse(fs.readFileSync(D(f), 'utf8'));
const book = J('book.json'), P = J('.prices-2y.json'), T = J('technicals.json'), policy = J('policy.json'), val = J('valuation.json');
const S = policy.sizing || {}; const K = S.riskPerNameVolTarget || 0.04, CAPN = S.maxSingleName || 0.10, CAPC = S.maxCluster || 0.20, RHO = S.clusterMergeCorrelation || 0.75, LOOK = 60;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

// ── universe + return series ─────────────────────────────────────────────
const rows = [];
for (const h of book.holdings) {
  if (!h.yf) continue;
  const inst = P.instruments[h.yf]; if (!inst) continue;
  const src = (inst.trust === 'low' && inst.proxy && P.instruments[inst.proxy]) ? inst.proxy : h.yf;
  const C = P.instruments[src].bars.filter(b => !b.partial).map(b => b.c);
  if (C.length < LOOK + 1) continue;
  const r = C.slice(-LOOK - 1).slice(1).map((c, i, a) => Math.log(c / C[C.length - LOOK - 1 + i]));
  const tech = T.instruments[h.yf] || T.instruments[src] || {};
  rows.push({ id: h.id, t: h.t, yf: h.yf, n: h.n, ac: h.ac, series: src, r, vol: (tech.vol60 || 0) / 100 || Math.sqrt(r.reduce((s, x) => s + x * x, 0) / (r.length - 1)) * Math.sqrt(252), gateOn: tech.gate ? tech.gate.on === true : null });
}
const n = rows.length;
// covariance (annualised) and correlation on the common 60-day window
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const cov = (a, b) => { const ma = mean(a), mb = mean(b); return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / (a.length - 1) * 252; };
const SIG = rows.map(a => rows.map(b => cov(a.r, b.r)));
const COR = rows.map((a, i) => rows.map((b, j) => SIG[i][j] / Math.sqrt(SIG[i][i] * SIG[j][j])));

// ── clusters by correlation (union-find) ──────────────────────────────────
const parent = rows.map((_, i) => i); const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (COR[i][j] > RHO) parent[find(i)] = find(j);
const groups = {}; rows.forEach((r, i) => { (groups[find(i)] = groups[find(i)] || []).push(i); });
const clusters = Object.values(groups).map(idx => ({ members: idx.map(i => rows[i].t), idx, name: idx.length === 1 ? rows[idx[0]].t : idx.map(i => rows[i].t).slice(0, 4).join('+') + (idx.length > 4 ? '+' + (idx.length - 4) : '') }));

// ── target weights ────────────────────────────────────────────────────────
const w = rows.map(r => (r.gateOn === true && r.vol > 0) ? Math.min(K / r.vol, CAPN) : 0);
let tot = w.reduce((s, x) => s + x, 0); if (tot > 1) w.forEach((_, i) => w[i] /= tot);
for (const c of clusters) { const cs = c.idx.reduce((s, i) => s + w[i], 0); if (cs > CAPC) c.idx.forEach(i => { w[i] *= CAPC / cs; }); }
const wTot = w.reduce((s, x) => s + x, 0), cashTarget = +(1 - wTot).toFixed(4);

// ── actual weights of the quoted sleeve, from valuation.json ──────────────
const lineVal = {}; (val.lines || []).forEach(l => { lineVal[l.id] = l.valueSGD; });
const sleeve = rows.reduce((s, r) => s + Math.max(0, lineVal[r.id] || 0), 0);
const wa = rows.map(r => sleeve ? Math.max(0, lineVal[r.id] || 0) / sleeve : 0);

// ── risk contribution per cluster, target vs actual ───────────────────────
const riskShares = wv => { const Sw = rows.map((_, i) => rows.reduce((s, _, j) => s + SIG[i][j] * wv[j], 0)); const pv = wv.reduce((s, x, i) => s + x * Sw[i], 0) || 1; return { pv, rc: wv.map((x, i) => x * Sw[i] / pv) }; };
const RA = riskShares(wa), RT = riskShares(w);
const clusterRows = clusters.map(c => ({ name: c.name, members: c.members,
  actualWeight: +c.idx.reduce((s, i) => s + wa[i], 0).toFixed(4), targetWeight: +c.idx.reduce((s, i) => s + w[i], 0).toFixed(4),
  actualRiskShare: +c.idx.reduce((s, i) => s + RA.rc[i], 0).toFixed(4), targetRiskShare: +c.idx.reduce((s, i) => s + RT.rc[i], 0).toFixed(4) }))
  .map(c => ({ ...c, overCapActual: c.actualRiskShare > CAPC * 1.25 })).sort((a, b) => b.actualRiskShare - a.actualRiskShare);

const diff = rows.map((r, i) => ({ t: r.t, n: r.n, gateOn: r.gateOn, vol60: +(r.vol * 100).toFixed(1), target: +w[i].toFixed(4), actual: +wa[i].toFixed(4), delta: +(w[i] - wa[i]).toFixed(4), riskShareActual: +RA.rc[i].toFixed(4) }))
  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

const out = {
  asOf: T.asOf, generatedAt: new Date().toISOString(),
  status: `SHADOW — published and diffed daily, no action asked. Shadow started ${S.shadowStart || today}; ratification is the owner's after 90 days.`,
  regime: policy.regime || null, policy: { riskPerNameVolTarget: K, maxSingleName: CAPN, maxCluster: CAPC, clusterMergeCorrelation: RHO, lookbackDays: LOOK },
  quotedSleeveSGD: +sleeve.toFixed(0), portfolioVolActualPct: +(Math.sqrt(RA.pv) * 100).toFixed(1), portfolioVolTargetPct: +(Math.sqrt(RT.pv) * 100).toFixed(1),
  cash: { target: cashTarget }, eligible: rows.filter(r => r.gateOn === true).length, universe: n,
  clusters: clusterRows, diff,
};
fs.writeFileSync(D('targets.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`targets.json (SHADOW): ${n} quoted names · ${out.eligible} gate-ON · target cash ${(cashTarget * 100).toFixed(0)}% · sleeve S$${(sleeve / 1e6).toFixed(2)}M · vol actual ${out.portfolioVolActualPct}% vs target ${out.portfolioVolTargetPct}%`);
console.log('  risk share by cluster (actual → target):');
clusterRows.slice(0, 6).forEach(c => console.log(`    ${(c.actualRiskShare * 100).toFixed(0).padStart(3)}% → ${(c.targetRiskShare * 100).toFixed(0).padStart(3)}%  ${c.name}${c.overCapActual ? '   OVER 20% CAP' : ''}`));
console.log('  largest target-vs-actual gaps:'); diff.slice(0, 5).forEach(d => console.log(`    ${d.t.padEnd(6)} target ${(d.target * 100).toFixed(1).padStart(5)}% actual ${(d.actual * 100).toFixed(1).padStart(5)}%  gate ${d.gateOn}`));
