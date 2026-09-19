#!/usr/bin/env node
/*
 * signal-lab.js — test candidate signal designs over a DECADE, not 8 weeks.
 *
 * WHY: the live track record (8 Jun – 31 Jul 2026) shows the deployed model at
 * -1.80% expectancy per call with inverted calibration. Filters derived from
 * that window alone would be fitted to a single event — a rare-earth/commodity
 * crash. This harness re-creates the model's QUANT signal from price history
 * alone (the research blend is not reconstructible historically, which is
 * itself informative: it isolates what the maths contributes) and replays it
 * across many years and regimes.
 *
 * For each (date, ticker) it computes the live formulas verbatim:
 *   drift252, vol = 0.6*vol90 + 0.4*vol252 (floor 0.04)
 *   mu  = clip(0.30*drift252 + 0.50*prior + 0.10*sLong, ±cap)
 *   pUp = Phi((mu - vol^2/2)*T / (vol*sqrt(T)))
 * then applies each candidate gate set and scores the forward return.
 *
 *   node scripts/signal-lab.js            full run
 *   node scripts/signal-lab.js --quick    fewer dates, for iteration
 */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const CACHE = path.join(__dirname, '..', '.signal-lab-cache');
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
const QUICK = process.argv.includes('--quick');

// Same universe the live model scores, minus instruments with no long history.
const UNIVERSE = [
  ['SPY',.07],['QQQ',.08],['IWM',.07],['EFA',.06],['EEM',.07],['VGK',.06],['EWJ',.06],['INDA',.08],['FXI',.06],
  ['MTUM',.07],['QUAL',.07],['USMV',.06],['VLUE',.06],
  ['XLK',.08],['SMH',.09],['XLF',.07],['XLE',.05],['XLV',.06],['XLI',.07],['XLU',.05],['XLP',.05],['XLY',.07],
  ['GLD',.04],['SLV',.04],['DBC',.03],['USO',.02],['URA',.06],['COPX',.05],['DBA',.03],
  ['BTC-USD',.15],['ETH-USD',.15],
  ['TLT',.03],['IEF',.03],['SHY',.02],['TIP',.03],['LQD',.03],['HYG',.04],['EMB',.04],['BND',.03],
  ['REMX',.05],['MP',.06],['UUUU',.06],
];
const NORM = x => (1 + Math.sign(x) * (1 - Math.exp(-Math.abs(x) / 2))) / 2; // logistic-ish CDF stand-in
function Phi(z) { // Abramowitz-Stegun normal CDF
  const b = [.319381530, -.356563782, 1.781477937, -1.821255978, 1.330274429], p = .2316419;
  const s = z < 0 ? -1 : 1; z = Math.abs(z);
  const t = 1 / (1 + p * z), d = .3989422804014327 * Math.exp(-z * z / 2);
  let sum = 0, tp = t; for (const c of b) { sum += c * tp; tp *= t; }
  return .5 * (1 + s * (1 - 2 * (d * sum)));
}
function fetchSeries(sym) {
  const f = path.join(CACHE, sym.replace(/[^A-Za-z0-9.-]/g, '_') + '.json');
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} }
  const out = [];
  for (let y = 2013; y <= 2026; y += 4) {   // 4-year chunks: Yahoo silently returns MONTHLY bars on long ranges
    const p1 = Math.floor(Date.UTC(y, 0, 1) / 1000), p2 = Math.floor(Date.UTC(Math.min(y + 4, 2027), 0, 1) / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`;
    try {
      const j = JSON.parse(execSync(`curl -s --max-time 30 -H "User-Agent: Mozilla/5.0" -H "Origin: https://finance.yahoo.com" ${JSON.stringify(url)}`, { encoding: 'utf8', timeout: 35000, maxBuffer: 1 << 26 }));
      const r = j?.chart?.result?.[0]; if (!r?.timestamp) continue;
      if (r.meta?.dataGranularity && r.meta.dataGranularity !== '1d') continue;  // refuse downgraded data
      const q = r.indicators.quote[0];
      r.timestamp.forEach((t, i) => { if (q.close[i] != null) out.push({ d: new Date(t * 1000).toISOString().slice(0, 10), c: q.close[i] }); });
    } catch (_) {}
  }
  const seen = new Set(), clean = out.filter(x => !seen.has(x.d) && seen.add(x.d)).sort((a, b) => a.d.localeCompare(b.d));
  fs.writeFileSync(f, JSON.stringify(clean));
  return clean;
}

// ── signal reconstruction, matching the live engine ──
function signalAt(closes, i, prior) {
  if (i < 260) return null;
  const px = closes[i];
  const ret = (a, b) => closes[a] / closes[b] - 1;
  const drift252 = ret(i, i - 252);
  const rets = [];
  for (let k = i - 252 + 1; k <= i; k++) rets.push(closes[k] / closes[k - 1] - 1);
  const sd = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const vol252 = sd(rets) * Math.sqrt(252), vol90 = sd(rets.slice(-90)) * Math.sqrt(252);
  const vol = Math.max(0.04, 0.6 * vol90 + 0.4 * vol252);
  const sma = w => closes.slice(i - w + 1, i + 1).reduce((s, x) => s + x, 0) / w;
  const s200 = sma(200), s200prev = closes.slice(i - 219, i - 19).reduce((s, x) => s + x, 0) / 200;
  const s50 = sma(50);
  const sLong = Math.max(-1, Math.min(1, (px / s200 - 1) * 4));
  const cap = 0.25;
  const mu = Math.max(-cap, Math.min(cap, 0.30 * drift252 + 0.50 * prior + 0.10 * sLong));
  const T = 0.25;
  const pUp = Phi(((mu - vol * vol / 2) * T) / (vol * Math.sqrt(T)));
  // drawdown from 1y high — a cheap proxy for "falling knife"
  const hi = Math.max(...closes.slice(Math.max(0, i - 252), i + 1));
  return { px, mu, vol, pUp, above200: px > s200, rising200: s200 > s200prev, above50: px > s50, ddFromHigh: px / hi - 1, drift252 };
}

const THEME = { REMX: 'RE', MP: 'RE', UUUU: 'RE', URA: 'RE', COPX: 'RE', 'BTC-USD': 'CRYPTO', 'ETH-USD': 'CRYPTO',
  GLD: 'METALS', SLV: 'METALS', USO: 'ENERGY', XLE: 'ENERGY', DBC: 'ENERGY', DBA: 'AG',
  TLT: 'RATES', IEF: 'RATES', SHY: 'RATES', TIP: 'RATES', LQD: 'CREDIT', HYG: 'CREDIT', EMB: 'CREDIT', BND: 'RATES' };

console.log('fetching price history…');
const data = {};
for (const [sym] of UNIVERSE) { const s = fetchSeries(sym); if (s.length > 600) data[sym] = s; }
console.log(`${Object.keys(data).length}/${UNIVERSE.length} instruments with usable daily history\n`);

// build aligned observation set
const HOLD = 63;                     // ~3 trading months
const obs = [];
for (const [sym, prior] of UNIVERSE) {
  const s = data[sym]; if (!s) continue;
  const closes = s.map(x => x.c);
  const step = QUICK ? 21 : 10;
  for (let i = 260; i + HOLD < closes.length; i += step) {
    const sig = signalAt(closes, i, prior); if (!sig) continue;
    obs.push({ sym, theme: THEME[sym] || 'EQUITY', date: s[i].d, ...sig, fwd: closes[i + HOLD] / closes[i] - 1 });
  }
}
console.log(`${obs.length} observations, ${obs[0].date} → ${obs[obs.length - 1].date}\n`);

const volPctl = (() => { const v = obs.map(o => o.vol).sort((a, b) => a - b); return p => v[Math.floor(p * (v.length - 1))]; })();
const V75 = volPctl(0.75), V50 = volPctl(0.50);
console.log(`vol percentiles: median ${(V50 * 100).toFixed(0)}%, 75th ${(V75 * 100).toFixed(0)}%\n`);

function evaluate(name, pick) {
  const sel = obs.filter(pick).map(o => ({ ...o, pnl: o.fwd }));
  if (sel.length < 30) return console.log(name.padEnd(52) + ' n=' + sel.length + '  (too few)');
  const w = sel.filter(x => x.pnl > 0), l = sel.filter(x => x.pnl <= 0);
  const av = a => a.length ? a.reduce((s, x) => s + x.pnl, 0) / a.length : 0;
  const exp = av(sel), sorted = sel.map(x => x.pnl).sort((a, b) => a - b);
  const worstDecile = sorted.slice(0, Math.ceil(sel.length * .1)).reduce((a, b) => a + b, 0) / Math.ceil(sel.length * .1);
  const sd = Math.sqrt(sel.reduce((s, x) => s + (x.pnl - exp) ** 2, 0) / (sel.length - 1));
  console.log(name.padEnd(52),
    'n=' + String(sel.length).padEnd(6),
    'hit ' + (w.length / sel.length * 100).toFixed(0).padStart(3) + '%',
    'exp ' + (exp * 100).toFixed(2).padStart(6) + '%',
    'win ' + (av(w) * 100).toFixed(2).padStart(5) + '%',
    'loss ' + (av(l) * 100).toFixed(2).padStart(6) + '%',
    'p/l ' + (av(w) / Math.abs(av(l))).toFixed(2).padStart(4),
    'wrst10% ' + (worstDecile * 100).toFixed(1).padStart(6) + '%',
    'IR ' + (exp / (sd || 1) * Math.sqrt(4)).toFixed(2).padStart(5));
}

console.log('══ BASELINE: what the deployed model does ══');
evaluate('all observations (buy-and-hold benchmark)', () => true);
evaluate('CURRENT: long when pUp3m >= 0.55', o => o.pUp >= 0.55);
evaluate('CURRENT: long when pUp3m >= 0.58 (higher bar)', o => o.pUp >= 0.58);

console.log('\n══ SINGLE GATES ══');
evaluate('G1  trend: above rising 200DMA', o => o.above200 && o.rising200);
evaluate('G2  vol below 75th pctl', o => o.vol < V75);
evaluate('G3  vol below median', o => o.vol < V50);
evaluate('G4  not a falling knife (>-20% from 1y high)', o => o.ddFromHigh > -0.20);

console.log('\n══ COMBINED (capital preservation stack) ══');
evaluate('S1  pUp>=.55 + above rising 200DMA', o => o.pUp >= 0.55 && o.above200 && o.rising200);
evaluate('S2  S1 + vol<75th', o => o.pUp >= 0.55 && o.above200 && o.rising200 && o.vol < V75);
evaluate('S3  S2 + above 50DMA', o => o.pUp >= 0.55 && o.above200 && o.rising200 && o.vol < V75 && o.above50);
evaluate('S4  S3 + not falling knife', o => o.pUp >= 0.55 && o.above200 && o.rising200 && o.vol < V75 && o.above50 && o.ddFromHigh > -0.20);
evaluate('S5  trend+vol ONLY (no pUp at all)', o => o.above200 && o.rising200 && o.vol < V75 && o.above50);

console.log('\n══ IS pUp ADDING ANYTHING? (within the gated set) ══');
const gated = o => o.above200 && o.rising200 && o.vol < V75 && o.above50;
evaluate('gated + pUp bottom half', o => gated(o) && o.pUp < 0.53);
evaluate('gated + pUp top half', o => gated(o) && o.pUp >= 0.53);
evaluate('gated + pUp top decile', o => gated(o) && o.pUp >= 0.58);

console.log('\n══ BY VOLATILITY BUCKET (does the vol finding hold over a decade?) ══');
evaluate('vol < 15%', o => o.vol < 0.15);
evaluate('vol 15-25%', o => o.vol >= 0.15 && o.vol < 0.25);
evaluate('vol 25-40%', o => o.vol >= 0.25 && o.vol < 0.40);
evaluate('vol > 40%', o => o.vol >= 0.40);
evaluate('vol > 40% AND pUp>=.55 (what killed the book)', o => o.vol >= 0.40 && o.pUp >= 0.55);

fs.writeFileSync(path.join(CACHE, 'obs.json'), JSON.stringify(obs.map(o => ({ s: o.sym, d: o.date, p: +o.pUp.toFixed(4), v: +o.vol.toFixed(4), a2: o.above200, r2: o.rising200, a5: o.above50, dd: +o.ddFromHigh.toFixed(4), f: +o.fwd.toFixed(4), th: o.theme }))));
console.log(`\nobservations cached → ${path.join(CACHE, 'obs.json')}`);
