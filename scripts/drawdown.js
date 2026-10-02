#!/usr/bin/env node
/*
 * drawdown.js — how far things have fallen, and which falls are worth a line.
 *
 * Added 2 Oct 2026 after another assistant emailed the owner a "BREACH" on Xiaomi -4.2%. Three
 * things were wrong with it and all three are design constraints here:
 *   1. It never multiplied the move by position size. Xiaomi is 106bp of this NAV, so -4.2% was
 *      4.5bp of net worth — S$4,609. An alert that cannot tell 4.5bp from 450bp is a siren on noise.
 *   2. It used a FIXED -3% threshold. Xiaomi's vol60 is ~47%, so its 1-sigma day is ~2.95%: -4.2%
 *      is 1.4 sigma, a Tuesday. The same -3% on VICOM (vol60 ~11%, 1-sigma 0.69%) is 4.3 sigma, a
 *      genuine shock. One number cannot serve both.
 *   3. It read an INTRADAY quote on an unfinished session and called it "the day".
 *
 * THIS FILE NEVER ASKS FOR A POSITION TO BE CUT BECAUSE IT FELL. policy.json regime.notRules
 * records two things this book tested and rejected: "P&L-triggered de-grossing (tested: harmful,
 * return/drawdown 0.67 vs 0.80)" and "volatility ceiling (tested: harmful; high-vol bucket was the
 * best over 12y)". Selling into a drawdown is the one response the owner's own backtest measured as
 * destructive, so no row here recommends it, and nothing here sizes or caps by volatility. Sigma is
 * used ONLY to normalise whether a move is anomalous for its own series — anomaly detection, not a
 * vol ceiling. A drawdown earns a line for one of five reasons and no others:
 *
 *   margin        — it consumed headroom in the levered sleeve. This is the ONLY place a price move
 *                   genuinely compels an action, and the action is REPAY (Rule 1), never sell.
 *   regime        — it is testing the drawdown tolerance the regime block itself claims. That is
 *                   calibration of an assumption, the same logic as regime.killSwitch, not a trade.
 *   anomaly       — the move is so far outside the position's own distribution that news must exist.
 *                   The line exists to say the NEWS feed may have missed something, not to trade.
 *   thesis        — the position is far enough below its own peak that the reason for holding it
 *                   deserves to be written down again. The ask is a NOTE reply, not a sale.
 *   concentration — the fall has passively moved a label group through policy.sizing.maxCluster.
 *
 * COMPLETED BARS ONLY, from data/closes.json, each instrument on its own exchange calendar, and
 * every figure carries the bar date it came from. A session still trading has no close, so it has no
 * opinion here — that is the whole difference between this file and the email that prompted it.
 *
 * BANDS, NOT STATES. "Xiaomi is 58% off its high" is true every morning; printing it every morning
 * is wallpaper, the same mistake the theme radar made with a standing stage. Each reason carries
 * BANDS and an event is emitted only when a position enters a WORSE band than the one previously
 * recorded in data/drawdown.json. Recovery is recorded silently (the band is lowered, no event), so
 * a position oscillating around a threshold cannot alert twice for the same fall.
 *
 * Facts and band crossings only. Severity, channels and wording belong to alerts.js and policy.json.
 *
 * CLI: node scripts/drawdown.js [--dry-run]
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), D = f => path.join(ROOT, 'data', f);
const J = f => { try { return JSON.parse(fs.readFileSync(D(f), 'utf8')); } catch (_) { return null; } };
const todaySGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const r2 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(2);

// ── pure helpers (exported; the fixture drives these without touching a file) ────────────────────
// Annualised vol in percent -> one standard deviation of a single session, in percent.
const dailySigma = vol60Pct => (vol60Pct == null || !Number.isFinite(vol60Pct) || vol60Pct <= 0) ? null : vol60Pct / Math.sqrt(252);

// Peak-to-current drawdown over a series. Returns the peak, its date, and the fall from it.
function peakDrawdown(dates, closes) {
  let peak = null, peakOn = null;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    if (peak == null || c > peak) { peak = c; peakOn = dates[i] || null; }
  }
  const last = [...closes].reverse().find(c => c != null && Number.isFinite(c) && c > 0) ?? null;
  if (peak == null || last == null) return { peak: null, peakOn: null, lastClose: null, fromPeakPct: null };
  return { peak, peakOn, lastClose: last, fromPeakPct: (last / peak - 1) * 100 };
}

// The worst band a value has entered. bands are ascending magnitudes [25, 40, 60]; value is the
// NEGATIVE percent fall. Returns the largest band crossed, or null. Used for both thesis and regime.
function bandOf(fallPct, bands) {
  if (fallPct == null || !Number.isFinite(fallPct)) return null;
  const mag = -fallPct;
  let hit = null;
  for (const b of bands) if (mag >= b) hit = b;
  return hit;
}

// Last two COMPLETED bars for one instrument, on its own exchange calendar.
function lastTwoBars(dates, closes) {
  const ix = [];
  for (let i = closes.length - 1; i >= 0 && ix.length < 2; i--) {
    if (closes[i] != null && Number.isFinite(closes[i]) && closes[i] > 0) ix.push(i);
  }
  if (ix.length < 2) return null;
  const [b, a] = ix;   // b = newest, a = the one before
  return { close: closes[b], on: dates[b] || null, prev: closes[a], prevOn: dates[a] || null,
    dayPct: (closes[b] / closes[a] - 1) * 100 };
}

function main() {
  const DRY = process.argv.includes('--dry-run');
  const today = todaySGT(), nowIso = new Date().toISOString();
  const book = J('book.json'), closes = J('closes.json'), tech = J('technicals.json');
  const val = J('valuation.json'), fx = J('fx.json'), pol = J('policy.json') || {};
  const errors = [];
  if (!book || !closes || !val) { console.error('drawdown: book.json, closes.json and valuation.json are all required'); process.exit(1); }
  const P = pol.drawdown || {};
  // Read the SEMANTIC keys (policy.drawdown.thesis.bands / regime.fractions). policy.drawdown.bands was
  // a second copy of the same numbers and this line used to read it, so editing the documented key did
  // nothing while looking like it had. Deleted from policy; drawdown.json's `bands` is now a derived
  // report, not a source.
  const BANDS = { thesis: (P.thesis && P.thesis.bands) || [25, 40, 60],
    regimeFrac: (P.regime && P.regime.fractions) || [0.5, 0.8, 1.0] };
  const TOL = P.tolerance || { riskSleevePct: 25, netWorthPct: 13.5 };
  const prev = J('drawdown.json');
  const prevBand = (kind, key) => {
    const e = prev && (prev.bandState || []).find(x => x.kind === kind && x.key === key);
    return e ? e.band : null;
  };

  const inst = (closes.instruments) || {}, exch = (closes.exchanges) || {};
  const T = (tech && (tech.instruments || tech.byTicker)) || {};
  const rate = c => c === 'SGD' ? 1 : (((fx && fx.rates && fx.rates[c]) ?? (fx && fx[c])) || null);
  const nav = val.navSGD;
  if (!nav) { console.error('drawdown: valuation.json has no navSGD'); process.exit(1); }

  // ── positions: completed bars only, each on its own exchange calendar ──────────────────────────
  const positions = [], bandState = [], events = [], excluded = [];
  for (const h of (book.holdings || [])) {
    if (!h.yf) continue;                       // manual marks have no series; they are a staleness
    const I = inst[h.yf];                      // problem, not a drawdown one (valuate.js flags them)
    if (!I) {
      // NOT an error: a standing, known absence. valuate.js already values these at last-known book and
      // flags them stale. Logging it as an error every morning would make this feed's only WARN a
      // permanent one, and a WARN that is always on gets read as off.
      excluded.push({ t: h.t, n: h.n, yf: h.yf, why: `${h.yf} is not in closes.json, so it has no price series and therefore no drawdown — it is NOT counted as flat` });
      continue;
    }
    const dates = exch[I.ex] || [], cs = I.c || [];
    const bars = lastTwoBars(dates, cs);
    const pk = peakDrawdown(dates, cs);
    const ti = T[h.yf] || {};
    const fxr = rate(h.cur);
    const valueSGD = (bars && fxr) ? h.qty * bars.close * fxr : null;
    const navBp = valueSGD != null ? valueSGD / nav * 1e4 : null;
    const sig = dailySigma(ti.vol60);
    const sigmas = (bars && sig) ? bars.dayPct / sig : null;
    const dayImpactBp = (bars && navBp != null) ? navBp * (bars.dayPct / 100) : null;
    const row = {
      t: h.t, n: h.n, yf: h.yf, cur: h.cur, qty: h.qty,
      valueSGD: valueSGD == null ? null : Math.round(valueSGD), navBp: r2(navBp),
      bar: bars ? { on: bars.on, close: r2(bars.close), prevOn: bars.prevOn, prev: r2(bars.prev) } : null,
      day: bars ? { pct: r2(bars.dayPct), navBp: r2(dayImpactBp),
        navSGD: dayImpactBp != null ? Math.round(nav * dayImpactBp / 1e4) : null,
        sigma: r2(sigmas), vol60: ti.vol60 ?? null, sigmaPct: r2(sig),
        sigmaWhy: sig == null ? 'vol60 unavailable, so this move is NOT expressed in sigma and no anomaly test ran — a fixed percentage is not substituted' : null } : null,
      peak2y: { value: r2(pk.peak), on: pk.peakOn, fromPct: r2(pk.fromPeakPct) },
      high52w: (ti.high52w != null && bars) ? { value: r2(ti.high52w), fromPct: r2((bars.close / ti.high52w - 1) * 100) }
        : ti.high52w != null ? { value: r2(ti.high52w), fromPct: null, why: 'fewer than two completed bars, so the fall from the 52-week high is NOT computed — null*100 is 0 in JS and a fabricated zero is worse than a gap' }
        : null,
      trust: ti.trust || null, proxy: ti.proxy || null,
    };
    positions.push(row);

    // thesis band — how far below its own 2y peak, gated on mattering to NAV at all
    const tb = bandOf(pk.fromPeakPct, BANDS.thesis);
    const key = h.yf, was = prevBand('thesis', key);
    if (tb != null) bandState.push({ kind: 'thesis', key, band: tb, t: h.t, on: today });
    // MATERIALITY BINDS HERE OR THE WHOLE FILE IS THE THING IT REPLACED. A line 54% below its peak
    // and worth 2.9bp of NAV (S$3,000) is not a risk event; it is a rounding error with a big
    // percentage on it. The band is still RECORDED above so the state is honest and a later size-up
    // re-tests it — it just does not earn a line.
    const THESIS_MIN_BP = (P.thesis && P.thesis.minNavBp != null) ? P.thesis.minNavBp : 25;
    const material = navBp != null && navBp >= THESIS_MIN_BP;
    if (tb != null && material && (was == null || tb > was)) {
      events.push({ reason: 'thesis', t: h.t, n: h.n, yf: h.yf, band: tb, bandWas: was,
        fromPeakPct: r2(pk.fromPeakPct), peakOn: pk.peakOn, navBp: r2(navBp),
        valueSGD: valueSGD == null ? null : Math.round(valueSGD), barOn: bars ? bars.on : null,
        ask: 'NOTE', minNavBp: THESIS_MIN_BP, bootstrap: !prev, why: `${h.t} closed ${r2(pk.fromPeakPct)}% below its 2-year peak (${r2(pk.peak)} on ${pk.peakOn}), crossing the ${tb}% band. It is ${r2(navBp)}bp of NAV. The ask is a written reason for still holding it — regime.notRules records that selling into a drawdown tested harmful in this book, so this is not a request to trim.` });
    }

    // anomaly band — sigma AND materiality must BOTH bind, or it is noise with a number on it
    if (bars && sig && navBp != null) {
      const A = P.anomaly || { notableSigma: 3, logSigma: 2, notableNavBp: 10, logNavBp: 3 };
      const mag = Math.abs(sigmas), bp = Math.abs(dayImpactBp);
      const tier = (mag >= A.notableSigma && bp >= A.notableNavBp) ? 'notable'
        : (mag >= A.logSigma && bp >= A.logNavBp) ? 'log' : null;
      if (tier) {
        const akey = `${h.yf}:${bars.on}`;
        events.push({ reason: 'anomaly', t: h.t, n: h.n, yf: h.yf, tier,
          dayPct: r2(bars.dayPct), sigma: r2(sigmas), vol60: ti.vol60, navBp: r2(dayImpactBp),
          navSGD: Math.round(nav * dayImpactBp / 1e4), barOn: bars.on, key: akey,
          dir: bars.dayPct < 0 ? 'down' : 'up',
          why: `${h.t} ${bars.dayPct < 0 ? 'fell' : 'rose'} ${r2(Math.abs(bars.dayPct))}% on its ${bars.on} close — ${r2(mag)} sigma against its own vol60 of ${ti.vol60}% (1 sigma = ${r2(sig)}%/day) and ${r2(bp)}bp of NAV (S$${Math.abs(Math.round(nav * dayImpactBp / 1e4)).toLocaleString()}). Both gates bind: a move this far outside the series' own distribution usually means news exists, so the line is here to ask whether news.json carried it.` });
      }
    }
  }

  // ── scope 1: net worth, over the only history that exists ─────────────────────────────────────
  let netWorth = null;
  try {
    const nh = fs.readFileSync(D('nav-history.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const pk = peakDrawdown(nh.map(r => r.date), nh.map(r => r.nav));
    netWorth = { navSGD: Math.round(nav), peak: { value: pk.peak == null ? null : Math.round(pk.peak), on: pk.peakOn },
      drawdownPct: r2(pk.fromPeakPct), tolerancePct: TOL.netWorthPct,
      usedOfTolerancePct: r2(pk.fromPeakPct == null ? null : (-pk.fromPeakPct) / TOL.netWorthPct * 100),
      historyFrom: nh[0] && nh[0].date, historySessions: nh.length,
      note: `nav-history.ndjson starts ${nh[0] && nh[0].date} and holds ${nh.length} session(s), so this is the drawdown over that window and is NOT a 1-year or max drawdown — it is not presented as one. It is also structurally damped: cash and property are ${r2(((val.byClass && ((val.byClass.Cash || 0) + (val.byClass.Property || 0))) || 0) / nav * 100)}% of NAV and cannot move, so the risk sleeve below is the number that tests the regime.` };
  } catch (e) { errors.push({ stage: 'netWorth', why: `nav-history.ndjson unreadable (${e.message}) — no net-worth drawdown computed, and none is guessed` }); }

  // ── scope 2: the risk sleeve, reconstructed at CURRENT quantities over 2y of real closes ───────
  let riskSleeve = null;
  try {
    const EXCL = P.riskSleeveExcludes || ['Cash', 'Property', 'Private Equity'];
    const members = (book.holdings || []).filter(h => h.yf && inst[h.yf] && !EXCL.includes(h.ac));
    // One common calendar: the union of every member's exchange dates, carrying each series forward.
    const cal = [...new Set(members.flatMap(h => exch[inst[h.yf].ex] || []))].sort();
    const series = cal.map(() => 0);
    let used = 0;
    for (const h of members) {
      const I = inst[h.yf], dts = exch[I.ex] || [], cs = I.c || [], fxr = rate(h.cur);
      if (!fxr) { errors.push({ stage: 'sleeve', t: h.t, why: `no fx rate for ${h.cur}` }); continue; }
      const byDate = new Map();
      for (let i = 0; i < dts.length; i++) if (cs[i] != null && Number.isFinite(cs[i])) byDate.set(dts[i], cs[i]);
      let carry = null;
      for (let k = 0; k < cal.length; k++) {
        const c = byDate.get(cal[k]); if (c != null) carry = c;
        if (carry != null) series[k] += h.qty * carry * fxr;
      }
      used++;
    }
    const firstFull = series.findIndex(v => v > 0);
    const dts = cal.slice(firstFull), vals = series.slice(firstFull);
    const pk = peakDrawdown(dts, vals);
    const cur = vals[vals.length - 1];
    riskSleeve = { valueSGD: Math.round(cur), pctOfNav: r2(cur / nav * 100), members: used,
      excludes: EXCL, peak: { value: pk.peak == null ? null : Math.round(pk.peak), on: pk.peakOn },
      drawdownPct: r2(pk.fromPeakPct), tolerancePct: TOL.riskSleevePct,
      usedOfTolerancePct: r2(pk.fromPeakPct == null ? null : (-pk.fromPeakPct) / TOL.riskSleevePct * 100),
      historyFrom: dts[0] || null, historySessions: dts.length,
      note: `reconstructed from closes.json at TODAY's quantities, so it answers "what would this sleeve have done if held unchanged" — it is NOT a time-weighted return and it does not know about past trades. Completed bars only, each name on its own exchange calendar, carried forward across holidays.` };
    const frac = pk.fromPeakPct == null ? null : (-pk.fromPeakPct) / TOL.riskSleevePct;
    const rb = bandOf(frac == null ? null : -frac * 100, (BANDS.regimeFrac || [0.5, 0.8, 1.0]).map(f => f * 100));
    const was = prevBand('regime', 'riskSleeve');
    if (rb != null) bandState.push({ kind: 'regime', key: 'riskSleeve', band: rb, on: today });
    if (rb != null && (was == null || rb > was)) {
      events.push({ reason: 'regime', scope: 'riskSleeve', band: rb, bandWas: was,
        drawdownPct: r2(pk.fromPeakPct), tolerancePct: TOL.riskSleevePct, usedPct: r2(frac * 100),
        why: `the risk sleeve is ${r2(pk.fromPeakPct)}% below its peak (${pk.peakOn}), which is ${r2(frac * 100)}% of the ${TOL.riskSleevePct}% tolerance the regime block claims. That tests an ASSUMPTION about this portfolio, not the positions in it: regime.status is still "${(pol.regime || {}).status || '?'}". Calibration, the same logic as regime.killSwitch — nothing here asks for a trade.` });
    }
  } catch (e) { errors.push({ stage: 'sleeve', why: `risk-sleeve reconstruction failed (${e.message})` }); }

  // ── scope 3: the levered sleeve — the one place a fall genuinely compels an action ─────────────
  let levered = null;
  const S = val.silver || null;
  if (S) {
    const si = inst['SI=F'], sPk = si ? peakDrawdown(exch[si.ex] || [], si.c || []) : { fromPeakPct: null, peak: null, peakOn: null };
    levered = { instrument: 'SI=F', oz: S.oz, priceUSD: S.priceUSD, priceAsOf: S.priceAsOf, priceTrust: S.priceTrust,
      valueSGD: S.valueSGD, loanSGD: S.loanSGD, equitySGD: S.equitySGD, leverage: S.leverage,
      ceiling: (pol.silverLeverage || {}).maxLeverage ?? null,
      overCeilingBy: ((pol.silverLeverage || {}).maxLeverage != null && S.leverage != null)
        ? r2(S.leverage - pol.silverLeverage.maxLeverage) : null,
      fromPeakPct: r2(sPk.fromPeakPct), peak: r2(sPk.peak), peakOn: sPk.peakOn,
      callPriceUSD: S.callPriceUSD, callPriceUSDStressed: S.callPriceUSDStressed,
      distanceToCallPct: S.distanceToCallPct, distanceToCallPctStressed: S.distanceToCallPctStressed,
      survivability: S.survivability || null, maintenanceRateSource: S.maintenanceRateSource || null,
      note: 'the ONLY scope where a price fall forces a response, and the response is REPAY (Rule 1), never sell. Both rates are ASSUMED until confirmed on the IBKR account, so every figure here inherits that.' };
    const M = P.margin || { stressedDistanceNotablePct: 30, stressedDistanceLogPct: 40 };
    const d = S.distanceToCallPctStressed;
    const mb = (d != null && d <= M.stressedDistanceNotablePct) ? M.stressedDistanceNotablePct
      : (d != null && d <= M.stressedDistanceLogPct) ? M.stressedDistanceLogPct : null;
    const was = prevBand('margin', 'silver');
    // margin bands tighten as distance SHRINKS, so a lower band number is the worse state
    // band = percent of the stressed distance-to-call still REMAINING when the band tripped, so a
    // SMALLER band is the worse state. Stored and reported in one orientation; it used to be negated in
    // bandState and positive in the event, so a consumer could print "band -40 -> 30" about a tightening.
    if (mb != null) bandState.push({ kind: 'margin', key: 'silver', band: mb, on: today });
    const worse = was == null ? mb != null : (mb != null && mb < was);
    if (worse || (S.survivability && S.survivability.pass === false && prevBand('margin', 'survivability') == null)) {
      if (S.survivability && S.survivability.pass === false) bandState.push({ kind: 'margin', key: 'survivability', band: 1, on: today });
      events.push({ reason: 'margin', scope: 'silver', band: mb, bandWas: was,
        bandMeans: 'percent of the stressed distance-to-call still remaining when this band tripped; SMALLER is worse',
        leverage: S.leverage, ceiling: levered.ceiling, fromPeakPct: r2(sPk.fromPeakPct),
        distanceToCallPctStressed: d, survivabilityPass: S.survivability ? S.survivability.pass : null,
        ask: 'DONE | DEFER',
        why: `silver is ${r2(sPk.fromPeakPct)}% below its 2-year peak, leverage is ${S.leverage}x against a signed ceiling of ${levered.ceiling}x, and the stressed call sits ${d}% away. ${S.survivability && S.survivability.pass === false ? `The survivability test FAILS: ${Object.entries(S.survivability).filter(([k, v]) => v && typeof v === 'object' && v.stressed === false).map(([k]) => k).join(', ')} would be called at 1.5x the maintenance rate. ` : ''}This is the one drawdown in the book that compels an action, and one-action.js already sizes it — repay, do not sell.` });
    }
  }

  // ── concentration: a fall changes weights without a trade ──────────────────────────────────────
  const clusters = [];
  const capPct = ((pol.sizing || {}).maxCluster ?? 0.2) * 100;
  const groups = {};
  for (const p of positions) {
    const h = (book.holdings || []).find(x => x.yf === p.yf) || {};
    for (const [dim, k] of [['ac', h.ac], ['region', h.region]]) {
      if (!k) continue;
      const gk = `${dim}:${k}`;
      groups[gk] = groups[gk] || { key: gk, dim, label: k, valueSGD: 0, members: [] };
      groups[gk].valueSGD += p.valueSGD || 0;
      groups[gk].members.push(p.t);
    }
  }
  const sleeveVal = riskSleeve ? riskSleeve.valueSGD : null;
  for (const g of Object.values(groups)) {
    const ofSleeve = sleeveVal ? g.valueSGD / sleeveVal * 100 : null;
    clusters.push({ ...g, valueSGD: Math.round(g.valueSGD), pctOfNav: r2(g.valueSGD / nav * 100),
      pctOfRiskSleeve: r2(ofSleeve) });
  }
  clusters.sort((a, b) => b.valueSGD - a.valueSGD);
  // DELIBERATELY NO CONCENTRATION EVENTS. policy.sizing.maxCluster governs CORRELATION clusters for
  // position sizing (clusterMergeCorrelation 0.75), and these are label groups. Measuring one against
  // the other flagged "ac:Equity = 92.5% of the risk sleeve" — tautological, since the sleeve is
  // DEFINED as the non-cash non-property part — plus 3 of 4 regions, which is noise wearing a cap's
  // authority. The numbers are published as CONTEXT for the drawdown rows; the authoritative cluster
  // check belongs to targets.js, which runs in shadow. Wiring an event here would ship a fifth
  // reason code that cries every morning, which is the failure this whole file exists to avoid.
  const concentrationNote = `label groups only (asset class, region), published as context. NOT compared against policy.sizing.maxCluster: that cap governs correlation clusters for sizing, and "${(clusters[0]||{}).key}" at ${(clusters[0]||{}).pctOfRiskSleeve}% of the sleeve is tautological because the sleeve excludes cash, property and PE by construction. targets.js owns the real cluster test and runs in shadow.`;

  if (!prev) for (const e of events) e.bootstrap = true;
  // Stable id per crossing, so alerts.js can dedupe with the same mechanism every other family uses.
  // The id carries the BAND, not the date, for band events: re-crossing 40% after recovering to 30%
  // is the same fact and must not alert twice. Anomalies carry the BAR date, because a second 3-sigma
  // day genuinely is a second event.
  for (const e of events) {
    e.id = e.reason === 'anomaly' ? `risk:anomaly:${e.yf}:${e.barOn}`
      : e.reason === 'thesis' ? `risk:thesis:${e.yf}:${e.band}`
      : e.reason === 'regime' ? `risk:regime:${e.scope}:${e.band}`
      : e.reason === 'margin' ? `risk:margin:${e.scope}:${e.band == null ? 'survivability' : e.band}`
      : `risk:${e.reason}:${e.key || e.scope || e.t}`;
    e.firstSeen = e.firstSeen || today;
  }
  // Carry prior events forward within the window, newest first, deduped by id.
  const RETAIN_DAYS = (P.retainDays != null) ? P.retainDays : 45;
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - RETAIN_DAYS * 864e5).toISOString().slice(0, 10);
  const seen = new Set(events.map(e => e.id));
  const carried = ((prev && prev.events) || []).filter(e => e && e.id && !seen.has(e.id) && String(e.firstSeen || e.on || '') >= cutoff);
  const allEvents = events.concat(carried);
  const freshCount = events.length;
  const bootCohort = allEvents.filter(e => e && e.bootstrap).length;
  const out = {
    asOf: today, generatedAt: nowIso,
    source: 'completed closes from data/closes.json (each instrument on its own exchange calendar), vol60 from data/technicals.json, NAV and the levered sleeve from data/valuation.json; thresholds from data/policy.json drawdown',
    purpose: P.purpose || 'information, never de-grossing: regime.notRules records that P&L-triggered de-grossing and a volatility ceiling both tested harmful in this book',
    scan: { checkedAt: nowIso, ok: !errors.length, errors, excluded },
    tolerance: TOL, bands: BANDS,
    bootstrap: !prev,
    // DURABLE. `bootstrap` alone answers "was THIS run the first", which stops being the useful question
    // the moment run 2 happens: it flipped to false while 13 events still carried bootstrap:true and this
    // note — which tells consumers to collapse them — went null while that instruction was still live.
    bootstrapOn: !prev ? today : ((prev && prev.bootstrapOn) || null),
    bootstrapCohort: bootCohort,
    bootstrapNote: (!prev || bootCohort > 0) ? `FIRST READINGS PRESENT: ${bootCohort} event(s) were recorded when this monitor first ran (${!prev ? today : ((prev && prev.bootstrapOn) || 'an earlier run')}) and NONE of them crossed today — Xiaomi passed 40% below its peak on a 2025 bar. alerts.js must collapse every event carrying bootstrap:true into ONE first-reading summary and never emit them as individual rows: a first reading is not news, the same rule the 13F backfill and the theme radar got. Gate on the EVENT flag, not on the top-level bootstrap boolean, which is true only on the very first run.` : null,
    scopes: { netWorth, riskSleeve, levered },
    positions: positions.sort((a, b) => (b.valueSGD || 0) - (a.valueSGD || 0)),
    clusters: { note: concentrationNote, groups: clusters },
    events: allEvents, eventsFresh: freshCount, retainDays: RETAIN_DAYS, bandState,
  };
  if (DRY) {
    console.log(JSON.stringify({ ...out, positions: `[${positions.length} positions]` }, null, 1).slice(0, 2600));
    console.log(`\n--dry-run: nothing written (${JSON.stringify(out).length} bytes)`);
    return;
  }
  fs.writeFileSync(D('drawdown.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`drawdown.json: ${positions.length} priced position(s) · ${freshCount} new event(s), ${allEvents.length} retained (${RETAIN_DAYS}d) · ${errors.length} error(s)`);
  if (netWorth) console.log(`  net worth: ${netWorth.drawdownPct}% off peak (${netWorth.peak.on}) — ${netWorth.usedOfTolerancePct}% of the ${TOL.netWorthPct}% tolerance · ${netWorth.historySessions} session(s) of history only`);
  if (riskSleeve) console.log(`  risk sleeve: S$${riskSleeve.valueSGD.toLocaleString()} (${riskSleeve.pctOfNav}% of NAV) · ${riskSleeve.drawdownPct}% off peak (${riskSleeve.peak.on}) — ${riskSleeve.usedOfTolerancePct}% of the ${TOL.riskSleevePct}% tolerance`);
  if (levered) console.log(`  levered: silver ${levered.fromPeakPct}% off peak · leverage ${levered.leverage}x vs ${levered.ceiling}x · stressed call ${levered.distanceToCallPctStressed}% away · survivability ${levered.survivability && levered.survivability.pass === false ? 'FAIL' : 'pass'}`);
  console.log(`  clusters: ${clusters.length} label group(s) published as context, no events (see clusters.note)`);
  if (!prev) console.log('  FIRST RUN — every event below is a bootstrap reading, nothing crossed today');
  events.forEach(e => console.log(`  ${e.bootstrap ? 'b' : '!'} ${e.reason}${e.t ? ' ' + e.t : e.scope ? ' ' + e.scope : ''}${e.band != null ? ' band ' + e.band : ''}${e.navBp != null ? ' · ' + e.navBp + 'bp' : ''}`));
}

if (require.main === module) main();
module.exports = { dailySigma, peakDrawdown, bandOf, lastTwoBars };
