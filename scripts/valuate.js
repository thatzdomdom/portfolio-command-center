#!/usr/bin/env node
/*
 * valuate.js — net worth, per-line values, and the silver margin arithmetic, computed in CODE.
 *
 * Phase 1 of the 11 Sep 2026 redesign. Until now NAV existed only inside the browser, computed
 * from eight Yahoo calls made on page load. This reproduces index.html's valSGD() exactly —
 * live: qty × price × fx; fallback: book (already SGD); manual: native × fx — from the
 * deterministic layers (book.json, .prices-2y.json, fx.json), so the number exists on disk with
 * an as-of before any page renders it.
 *
 * It also computes the ONE number the system never told the owner: the silver price at which the
 * IBKR account gets a margin call, at the current maintenance rate AND at 1.5x that rate (IBKR
 * raises it in exactly the conditions where it matters), and whether the account survives a
 * two-day −20% and a two-week −35% silver decline. Those are the proposal's Rule 1.
 *
 * PARALLEL WEEK: this runs beside index.html's own computation. Inputs are identical by
 * construction (book.json is extracted from the HTML and validate-all fails on any drift), so a
 * NAV difference can only come from price timing. Logged daily; cutover in phase 4.
 */
const fs = require('fs'), path = require('path');
const D = f => path.join(__dirname, '..', 'data', f);
const rd = f => JSON.parse(fs.readFileSync(D(f), 'utf8'));

const book = rd('book.json');
const fx = rd('fx.json');
const prices = (() => { try { return rd('.prices-2y.json'); } catch (_) { return rd('.prices.json'); } })();
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

const FX = c => (c === 'SGD' ? 1 : fx.rates[c]);
const lastBar = sym => { const i = prices.instruments && prices.instruments[sym]; if (!i) return null;
  const b = (i.bars || []).filter(x => !x.partial); return b.length ? { bar: b[b.length - 1], prev: b[b.length - 2] || null, trust: i.trust || 'ok', n: b.length, bars: b } : null; };

const stale = [];
let nav = 0, navPrev = 0, priceAsOfMin = null;
const lines = book.holdings.map(h => {
  const fxr = FX(h.cur);
  if (fxr == null) throw new Error(`no FX rate for ${h.cur} (${h.n})`);
  if (h.valued === 'live') {
    const p = lastBar(h.yf);
    if (p && p.bar.c > 0) {
      const v = h.qty * p.bar.c * fxr, vPrev = h.qty * (p.prev ? p.prev.c : p.bar.c) * fxr;
      nav += v; navPrev += vPrev;
      if (!priceAsOfMin || p.bar.d < priceAsOfMin) priceAsOfMin = p.bar.d;
      return { id: h.id, t: h.t, n: h.n, ac: h.ac, cur: h.cur, qty: h.qty, price: p.bar.c, priceAsOf: p.bar.d, fx: fxr,
        valueSGD: +v.toFixed(2), dayChgSGD: +(v - vPrev).toFixed(2), source: 'live', trust: p.trust };
    }
    // no price in the spine → last-known book value, exactly as the page does
    nav += h.book || 0; navPrev += h.book || 0;
    stale.push({ id: h.id, t: h.t, why: 'no completed price bar in the spine — valued at last-known book' });
    return { id: h.id, t: h.t, n: h.n, ac: h.ac, cur: h.cur, qty: h.qty, price: null, priceAsOf: null, fx: fxr,
      valueSGD: h.book || 0, dayChgSGD: 0, source: 'book' };
  }
  const v = h.manualNative * fxr; nav += v; navPrev += v;
  const age = daysBetween(h.mark.asOf, today);
  if (age > 90) stale.push({ id: h.id, t: h.t, why: `manual mark is ${age} days old (limit 90)` });
  return { id: h.id, t: h.t, n: h.n, ac: h.ac, cur: h.cur, native: h.manualNative, fx: fxr, valueSGD: +v.toFixed(2), dayChgSGD: 0,
    source: 'manual', markAsOf: h.mark.asOf, markAgeDays: age };
});

// ── silver margin arithmetic (Rule 1) ─────────────────────────────────────
const S = book.holdings.find(h => h.id === book.ibkr.silverId), L = book.holdings.find(h => h.id === book.ibkr.loanId);
const sp = lastBar(S.yf);
const mRate = book.ibkr.maintenanceRate, lRate = book.ibkr.loanRate;
const mAge = daysBetween(mRate.asOf, today);
if (mAge > 30) stale.push({ id: 'ibkr.maintenanceRate', why: `maintenance rate mark is ${mAge} days old (limit 30)` });
let silver = null;
if (sp) {
  const p = sp.bar.c, fxu = FX(S.cur), oz = S.qty;
  const V = oz * p * fxu, loan = -L.manualNative, E = V - loan;
  const m = mRate.value, mS = Math.min(0.95, m * 1.5);
  // call when equity < m·V  ⇔  V(1−m) < loan  ⇔  price < loan / ((1−m)·oz·fx)
  const callAt = mm => loan / ((1 - mm) * oz * fxu);
  const pc = callAt(m), pcS = callAt(mS);
  const dist = 1 - pc / p, distS = 1 - pcS / p;
  const survive = (drop, pcx) => p * (1 - drop) > pcx;
  // trailing 12m silver return from the ETF proxy if two years of bars exist (carry honesty, Rule 3)
  const slv = lastBar('SLV'); let ret12 = null;
  if (slv && slv.n >= 252) ret12 = +((slv.bar.c / slv.bars[slv.n - 252].c - 1) * 100).toFixed(2);
  silver = {
    oz, priceUSD: p, priceAsOf: sp.bar.d, priceTrust: sp.trust, fxUSD: fxu,
    valueSGD: +V.toFixed(0), loanSGD: +loan.toFixed(0), equitySGD: +E.toFixed(0), leverage: +(V / E).toFixed(3),
    maintenanceRate: m, maintenanceRateStressed: mS, maintenanceRateAsOf: mRate.asOf, maintenanceRateSource: mRate.source,
    callPriceUSD: +pc.toFixed(2), callPriceUSDStressed: +pcS.toFixed(2),
    distanceToCallPct: +(dist * 100).toFixed(1), distanceToCallPctStressed: +(distS * 100).toFixed(1),
    survivability: {
      twoDay20: { current: survive(0.20, pc), stressed: survive(0.20, pcS) },
      twoWeek35: { current: survive(0.35, pc), stressed: survive(0.35, pcS) },
      pass: survive(0.20, pcS) && survive(0.35, pcS),   // must pass at the WORSE (stressed) rate
      rule: 'must survive a 2-day −20% and a 2-week −35% silver decline without a call, at 1.5x the maintenance rate',
    },
    carry: { loanRatePct: +(lRate.value * 100).toFixed(2), loanRateSource: lRate.source, silver12mPct: ret12,
      note: ret12 == null ? 'needs ≥252 SLV bars (2-year spine)' : (ret12 > lRate.value * 100 ? 'silver return exceeds loan cost' : 'LOAN COST EXCEEDS SILVER RETURN — levered carry is negative') },
  };
}

const byClass = {};
lines.forEach(l => { byClass[l.ac] = +((byClass[l.ac] || 0) + l.valueSGD).toFixed(2); });

// ── FX-source sensitivity (phase 4, 12 Sep 2026) — information only, never in the cutover clock.
// The page prices its NAV with Yahoo's =X pairs; this file uses ECB. During the parallel week a
// NAV gap between the two can only come from FX source and bar timing, so the NAV is recomputed
// here with the Yahoo cross-check rates fx.js already records. A currency Yahoo had no bar for
// falls back to ECB and is named in fellBackToEcb, so a 0.0% diff never hides a missing pair.
const fxSourceSensitivity = (() => {
  const y = (fx.crossCheck && fx.crossCheck.yahoo) || null;
  if (!y || !Object.values(y).some(v => v && v.rate > 0)) return null;
  const fellBackToEcb = [];
  const yFX = c => { if (c === 'SGD') return 1; const r = y[c] && y[c].rate; if (r > 0) return r; if (!fellBackToEcb.includes(c)) fellBackToEcb.push(c); return FX(c); };
  const navY = lines.reduce((s, l) => s + (l.source === 'manual' ? l.native * yFX(l.cur) : l.source === 'live' ? l.qty * l.price * yFX(l.cur) : l.valueSGD), 0);
  return { navWithYahooFxSGD: +navY.toFixed(2), diffPct: nav ? +(((navY / nav) - 1) * 100).toFixed(3) : null, fellBackToEcb,
    note: 'NAV recomputed with the browser\'s FX source (Yahoo =X pairs from fx.json crossCheck); the page\'s own NAV differs from navSGD only by FX source and bar timing' };
})();

const out = {
  asOf: priceAsOfMin, generatedAt: new Date().toISOString(), base: 'SGD',
  navSGD: +nav.toFixed(2), navPrevSGD: +navPrev.toFixed(2), dayChgSGD: +(nav - navPrev).toFixed(2),
  dayChgPct: navPrev ? +(((nav / navPrev) - 1) * 100).toFixed(3) : null,
  note: 'dayChg uses today\'s FX for both legs (fx.json carries one date); FX attribution arrives when a second day of fx history exists',
  fxAsOf: fx.asOf, fxSourceSensitivity, byClass, silver, stale, lines,
};
fs.writeFileSync(D('valuation.json'), JSON.stringify(out, null, 2) + '\n');
// NAV history for the drawdown-from-high line (Rule table: >10% = brief lead). Append-only,
// one row per SGT day; carries a balance, so gitignored — the brief reads it locally.
try { const HP = D('nav-history.ndjson'); const last = fs.existsSync(HP) ? fs.readFileSync(HP, 'utf8').trim().split('\n').pop() : '';
  if (!last || JSON.parse(last).date !== today) fs.appendFileSync(HP, JSON.stringify({ date: today, nav: out.navSGD, pricesAsOf: out.asOf }) + '\n'); } catch (_) {}
const sgd = n => 'S$' + (n / 1e6).toFixed(3) + 'M';
console.log(`valuation.json: NAV ${sgd(nav)} (${out.dayChgPct == null ? '—' : (out.dayChgPct >= 0 ? '+' : '') + out.dayChgPct + '%'} vs prev close) · prices as of ${priceAsOfMin} · fx ${fx.asOf} · ${stale.length} stale item(s)`);
if (silver) console.log(`  silver: ${silver.oz} oz @ $${silver.priceUSD} · leverage ${silver.leverage}x · call at $${silver.callPriceUSD} (${silver.distanceToCallPct}% away; $${silver.callPriceUSDStressed} / ${silver.distanceToCallPctStressed}% at 1.5x rate) · survivability ${silver.survivability.pass ? 'PASS' : 'FAIL'} · carry: ${silver.carry.note}`);
console.log(fxSourceSensitivity
  ? `  fxSourceSensitivity: NAV with Yahoo FX ${sgd(fxSourceSensitivity.navWithYahooFxSGD)} (${fxSourceSensitivity.diffPct >= 0 ? '+' : ''}${fxSourceSensitivity.diffPct}% vs ECB)${fxSourceSensitivity.fellBackToEcb.length ? ' · fell back to ECB for ' + fxSourceSensitivity.fellBackToEcb.join(', ') : ''}`
  : '  fxSourceSensitivity: null (fx.json crossCheck has no Yahoo rate)');
stale.slice(0, 5).forEach(s => console.log(`  ~ stale: ${s.t || s.id} — ${s.why}`));
