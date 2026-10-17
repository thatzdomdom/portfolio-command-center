/*
 * 22 — phase 9, 2 Oct 2026. The incident is not a bug in this pipeline; it is an email another
 * assistant sent the owner, calling a 4.2% day on Xiaomi a "BREACH" of a -3% rule that does not
 * exist in this book. Three things were wrong with it, and all three are what this fixture holds
 * down:
 *
 *   (a) IT NEVER MULTIPLIED THE MOVE BY POSITION SIZE. Xiaomi is ~106bp of this NAV, so -4.2% was
 *       4.47bp of net worth. An alert that cannot tell 4.5bp from 450bp is a siren on noise.
 *   (b) IT USED A FIXED PERCENTAGE. Xiaomi's vol60 is ~46.8, so its 1-sigma day is ~2.95%: -4.2% is
 *       1.42 sigma, a Tuesday. The same -3% on VICOM (vol60 ~11) is 4.33 sigma, a genuine shock.
 *   (c) IT READ AN INTRADAY QUOTE on an unfinished session and called it "the day".
 *
 * And the fourth failure is the one the WIRING could still commit, which is why most of this file is
 * about alerts.js and not about arithmetic: the monitor's first run records every standing fall at
 * once. Xiaomi passed 40% below its peak on a 2025 bar. Emitting those as thirteen Notables on the
 * first morning is the "a first reading is not news" mistake the 13F backfill made on 13 Sep and the
 * theme radar made on 20 Sep, for the third time. So the bootstrap cohort must collapse into ONE Log
 * summary — and, critically, it must KEEP doing so on the second run, when drawdown.json's
 * top-level `bootstrap` has already flipped to false (it is written as `!prev`) while the carried
 * events are still bootstrap readings.
 *
 * NOTHING HERE MAY ASK FOR A TRIM. policy.json regime.notRules records two things this book TESTED
 * AND REJECTED — P&L-triggered de-grossing (return/drawdown 0.67 vs 0.80) and a volatility ceiling.
 * Selling into a drawdown is the one response the owner's own backtest measured as destructive, so
 * the only actions any row may request are REPAY (margin) or a written NOTE (thesis), and the last
 * assertion in this file is a scan of every surface for language that asks for anything else.
 *
 * HOW THIS FIXTURE AVOIDS BEING 20-hkex AND 21-themes. Both of those are RED today because they
 * assert ABSOLUTE COUNTS over the sandbox's copy of the live, daily-drifting alerts.json: a fixture
 * that goes red because a scheduled job ran on time is a fixture nobody trusts. So here:
 *   - every COUNT is asserted over a SYNTHETIC data/drawdown.json this file writes, whose tickers
 *     are named FIXTURE-22 so they can never be mistaken for a book line, and the sandbox's risk
 *     rows are cleared before each run so the count is of THIS run and not of the log's history;
 *   - the Xiaomi and VICOM numbers are FROZEN here as the incident's own figures, never read from
 *     the live file. Whether the live file still agrees is printed in the note line, never failed;
 *   - where the LIVE file is touched at all, the assertion is an INVARIANT or a RELATIONSHIP ("every
 *     thesis event's navBp is at or above the policy gate", "no event lacks an id", "a line past the
 *     band but under the gate has no event") — never a count that changes tomorrow.
 * It never touches the network: drawdown.js's exported helpers are pure, and every run is a local
 * script against files in the sandbox.
 */
const path = require('path'), fs = require('fs');
const REPO = path.join(__dirname, '..');
const js = v => JSON.stringify(v);
const r2 = x => +Number(x).toFixed(2);

// The emailed incident, frozen. These are the numbers the 2 Oct email was wrong about; they are NOT
// read from data/drawdown.json, which moves every session.
const EMAIL = { t: '1810', vol60: 46.8, dayPct: -4.2, navBp: 106.34, fixedRulePct: -3 };
const VICOM = { t: 'V01', vol60: 11, dayPct: -3 };

module.exports = {
  name: '22-drawdown',
  incident: 'phase 9 — an emailed "BREACH" on a 1.4-sigma, 4.5bp Xiaomi day against a -3% rule this book does not have; then a monitor that would have opened with 13 Notables about falls months old',
  requires: ['scripts/drawdown.js', 'scripts/alerts.js', 'data/drawdown.json', 'data/policy.json', 'data/alerts.json'],
  run(ctx) {
    const DJ = require(path.join(ctx.root, 'scripts', 'drawdown.js'));
    const POL = ctx.read('policy.json') || {};
    const PD = POL.drawdown || {};
    const LIVE = ctx.read('drawdown.json');

    // ── (1) the pure helpers, which is where the arithmetic has to be right ──────────────────
    const sig = DJ.dailySigma(EMAIL.vol60);
    ctx.check('dailySigma: an annualised vol becomes one session by ÷√252 — vol60 46.8 ⇒ 2.95% a day',
      sig != null && r2(sig) === 2.95, `dailySigma(46.8) = ${sig}`);
    ctx.check('dailySigma refuses a non-number, a zero and a negative rather than returning 0 — a 0 sigma would make EVERY move infinitely anomalous',
      DJ.dailySigma(null) === null && DJ.dailySigma(0) === null && DJ.dailySigma(-5) === null && DJ.dailySigma(NaN) === null && DJ.dailySigma(undefined) === null,
      js([DJ.dailySigma(null), DJ.dailySigma(0), DJ.dailySigma(-5), DJ.dailySigma(NaN)]));

    const dates = ['2024-10-01', '2024-10-02', '2024-10-03', '2024-10-04', '2024-10-07'];
    const pk = DJ.peakDrawdown(dates, [10, 20, 15, null, 12]);
    ctx.check('peakDrawdown: the peak, ITS OWN DATE, and the fall from it — 20 on 2024-10-02, last 12, −40%',
      pk.peak === 20 && pk.peakOn === '2024-10-02' && pk.lastClose === 12 && r2(pk.fromPeakPct) === -40,
      js(pk));
    ctx.check('peakDrawdown: a null, a ZERO and a NEGATIVE close are skipped entirely — the last VALID close is 20, so the fall is 0%, not the −100% a 0 close would otherwise read as',
      (() => { const p = DJ.peakDrawdown(dates, [10, 20, 0, -3, null]); return p.peak === 20 && p.peakOn === '2024-10-02' && p.lastClose === 20 && r2(p.fromPeakPct) === 0; })(),
      js(DJ.peakDrawdown(dates, [10, 20, 0, -3, null])));
    ctx.check('peakDrawdown: and a valid close AFTER the holes is still the one compared — [10,20,0,null,12] is −40% from the 20 peak',
      (() => { const p = DJ.peakDrawdown(dates, [10, 20, 0, null, 12]); return p.peak === 20 && p.lastClose === 12 && r2(p.fromPeakPct) === -40; })(),
      js(DJ.peakDrawdown(dates, [10, 20, 0, null, 12])));
    ctx.check('peakDrawdown: a tied peak keeps the EARLIER date — the peak is a historical event, so a flat retest does not reset when it happened',
      (() => { const p = DJ.peakDrawdown(dates, [10, 20, 15, 20, 12]); return p.peakOn === '2024-10-02'; })(),
      js(DJ.peakDrawdown(dates, [10, 20, 15, 20, 12]).peakOn));
    ctx.check('peakDrawdown: an all-null series yields nulls, not a zero drawdown',
      (() => { const p = DJ.peakDrawdown(dates, [null, null, null, null, null]); return p.peak === null && p.fromPeakPct === null; })(),
      js(DJ.peakDrawdown(dates, [null, null, null, null, null])));

    const BANDS = (PD.thesis && PD.thesis.bands) || [25, 40, 60];
    ctx.check(`bandOf: the WORST band entered, on the live policy ladder (${BANDS.join('/')}) — −58.04% ⇒ ${BANDS[1]}, −24.9% ⇒ null, −61% ⇒ ${BANDS[2]}`,
      DJ.bandOf(-58.04, BANDS) === BANDS[1] && DJ.bandOf(-24.9, BANDS) === null && DJ.bandOf(-61, BANDS) === BANDS[2]
      && DJ.bandOf(-25, BANDS) === BANDS[0], js([DJ.bandOf(-58.04, BANDS), DJ.bandOf(-24.9, BANDS), DJ.bandOf(-61, BANDS), DJ.bandOf(-25, BANDS)]));
    ctx.check('bandOf: a band is entered AT the threshold (−25 ⇒ 25) and not a hair below (−24.999 ⇒ null); a POSITIVE return and a null are never a band',
      DJ.bandOf(-24.999, BANDS) === null && DJ.bandOf(12, BANDS) === null && DJ.bandOf(null, BANDS) === null && DJ.bandOf(NaN, BANDS) === null,
      js([DJ.bandOf(-24.999, BANDS), DJ.bandOf(12, BANDS), DJ.bandOf(null, BANDS)]));

    const l2 = DJ.lastTwoBars(dates, [10, 20, 15, null, 12]);
    ctx.check('lastTwoBars: the last two COMPLETED bars with their own dates, skipping the hole — 15 (10-03) → 12 (10-07), −20%',
      l2 && l2.close === 12 && l2.on === '2024-10-07' && l2.prev === 15 && l2.prevOn === '2024-10-03' && r2(l2.dayPct) === -20,
      js(l2));
    ctx.check('lastTwoBars: fewer than two valid closes returns null — a single bar has no day move, and inventing one is exactly the intraday failure this file replaces',
      DJ.lastTwoBars(['2024-10-01'], [10]) === null && DJ.lastTwoBars(dates, [null, null, 12, null, null]) === null,
      js([DJ.lastTwoBars(['2024-10-01'], [10]), DJ.lastTwoBars(dates, [null, null, 12, null, null])]));

    // ── (2) THE EMAILED CASE IS SILENT UNDER BOTH GATES ──────────────────────────────────────
    // The whole point of policy.drawdown.anomaly: sigma AND materiality must BOTH bind. Xiaomi's
    // -4.2% fails the sigma leg on its own, and would fail the materiality leg too at the Notable
    // tier. Both are asserted, because a future edit that drops either one re-opens the incident.
    const A = PD.anomaly || {};
    const xSigma = Math.abs(EMAIL.dayPct) / DJ.dailySigma(EMAIL.vol60);
    const xNavBp = Math.abs(EMAIL.navBp * EMAIL.dayPct / 100);
    ctx.check(`the emailed Xiaomi day is ${r2(xSigma)} SIGMA on its own 46.8 vol60 (1 sigma = 2.95%) and ${r2(xNavBp)}bp of net worth — the two numbers the email never computed`,
      r2(xSigma) === 1.42 && r2(xNavBp) === 4.47, `sigma ${r2(xSigma)} · navBp ${r2(xNavBp)}`);
    const notable = A.bothMustBind !== false
      ? (xSigma >= A.notableSigma && xNavBp >= A.notableNavBp)
      : (xSigma >= A.notableSigma || xNavBp >= A.notableNavBp);
    const logged = A.bothMustBind !== false
      ? (xSigma >= A.logSigma && xNavBp >= A.logNavBp)
      : (xSigma >= A.logSigma || xNavBp >= A.logNavBp);
    ctx.check(`SILENT UNDER BOTH GATES: ${r2(xSigma)} sigma is under the Notable ${A.notableSigma} AND under the Log ${A.logSigma}, so the emailed day produces NO row at all — not a Notable, not even a Log`,
      notable === false && logged === false, `notable ${notable} · log ${logged} · bothMustBind ${A.bothMustBind}`);
    ctx.check(`and it fails the MATERIALITY leg independently: ${r2(xNavBp)}bp is under the Notable ${A.notableNavBp}bp gate, so dropping the sigma leg alone would still not revive it`,
      xNavBp < A.notableNavBp, `${r2(xNavBp)}bp vs ${A.notableNavBp}bp`);
    ctx.check(`the FIXED ${EMAIL.fixedRulePct}% rule the email claimed WOULD have fired on it — which is the whole reason a fixed percentage is not the test here`,
      EMAIL.dayPct <= EMAIL.fixedRulePct, `${EMAIL.dayPct}% ≤ ${EMAIL.fixedRulePct}%`);
    const vSigma = Math.abs(VICOM.dayPct) / DJ.dailySigma(VICOM.vol60);
    ctx.check(`ONE NUMBER CANNOT SERVE BOTH: the same ${VICOM.dayPct}% is ${r2(vSigma)} sigma on VICOM (vol60 ${VICOM.vol60}) against ${r2(Math.abs(VICOM.dayPct) / DJ.dailySigma(EMAIL.vol60))} on Xiaomi — a 3× difference in how surprising the identical move is`,
      r2(vSigma) === 4.33 && vSigma > A.notableSigma, `VICOM ${r2(vSigma)} sigma`);
    ctx.check('sigma is used ONLY to normalise a move against its own series — policy.drawdown.anomaly says so in the file, and regime.notRules records a volatility CEILING as tested and harmful, so nothing may be sized or capped by vol',
      /anomaly detection and NOT the volatility ceiling/i.test(String(A.why || ''))
      && /volatility ceiling/i.test(js((POL.regime || {}).notRules || [])), String(A.why || '').slice(0, 80));

    // ── (3) the SYNTHETIC monitor file, and the wiring over it ───────────────────────────────
    // Named FIXTURE-22 throughout. Every count below is a count over THIS file.
    const GATE = (PD.thesis && PD.thesis.minNavBp) != null ? PD.thesis.minNavBp : 25;
    const T = ctx.today, NOW = new Date().toISOString();
    const pos = (t, navBp, fromPct, extra) => Object.assign({
      t, n: 'FIXTURE-22 ' + t, yf: t + '.SI', cur: 'SGD', qty: 1000, valueSGD: Math.round(navBp * 1000),
      navBp, bar: { on: T, close: 10, prevOn: ctx.daysAgo(1), prev: 10.1 },
      day: { pct: -1, navBp: r2(-navBp / 100), navSGD: -100, sigma: -0.5, vol60: 20, sigmaPct: 1.26, sigmaWhy: null },
      peak2y: { value: 20, on: '2025-01-02', fromPct }, high52w: { value: 19, fromPct: fromPct + 1 },
      trust: 'ok', proxy: null,
    }, extra || {});
    const scopes = () => ({
      netWorth: { navSGD: 10000000, peak: { value: 10100000, on: ctx.daysAgo(5) }, drawdownPct: -0.99,
        tolerancePct: 13.5, usedOfTolerancePct: 7.33, historyFrom: ctx.daysAgo(20), historySessions: 21,
        note: 'FIXTURE-22: 21 session(s) only, so this is NOT a 1-year or max drawdown.' },
      riskSleeve: { valueSGD: 1800000, pctOfNav: 18, members: 3, excludes: ['Cash', 'Property', 'Private Equity'],
        peak: { value: 2200000, on: '2026-01-28' }, drawdownPct: -18.18, tolerancePct: 25, usedOfTolerancePct: 72.73,
        historyFrom: '2024-09-30', historySessions: 518, note: 'FIXTURE-22 reconstructed sleeve.' },
      levered: { instrument: 'SI=F', oz: 1777, priceUSD: 61.33, priceAsOf: T, priceTrust: 'low',
        valueSGD: 139485, loanSGD: 56240, equitySGD: 83245, leverage: 1.676, ceiling: 1.4, overCeilingBy: 0.28,
        fromPeakPct: -46.71, peak: 115.08, peakOn: '2026-01-26', callPriceUSD: 35.33, callPriceUSDStressed: 44.96,
        distanceToCallPct: 42.4, distanceToCallPctStressed: 26.7,
        survivability: { twoDay20: { current: true, stressed: true }, twoWeek35: { current: true, stressed: false }, pass: false,
          rule: 'must survive a 2-day −20% and a 2-week −35% silver decline without a call, at 1.5x the maintenance rate' },
        maintenanceRateSource: 'ASSUMED — FIXTURE-22',
        note: 'FIXTURE-22: the ONLY scope where a price fall forces a response, and the response is REPAY, never sell.' },
    });
    // The two lines the materiality gate exists to separate: one deep and BIG, one deeper and tiny.
    const BIG = pos('FX22BIG', 106.34, -58.04);
    const TINY = pos('FX22TINY', 2.91, -54.2);
    const thesisEvent = (band, bandWas, boot) => Object.assign({
      reason: 'thesis', t: BIG.t, n: BIG.n, yf: BIG.yf, band, bandWas, fromPeakPct: -58.04, peakOn: '2025-01-02',
      navBp: BIG.navBp, valueSGD: BIG.valueSGD, barOn: T, ask: 'NOTE', minNavBp: GATE,
      why: `FIXTURE-22 ${BIG.t} closed -58.04% below its 2-year peak, crossing the ${band}% band. It is ${BIG.navBp}bp of NAV. The ask is a written reason for still holding it — not a request to trim.`,
      id: `risk:thesis:${BIG.yf}:${band}`, firstSeen: T,
    }, boot ? { bootstrap: true } : {});
    const regimeEvent = boot => Object.assign({
      reason: 'regime', scope: 'riskSleeve', band: 50, bandWas: null, drawdownPct: -18.18, tolerancePct: 25,
      usedPct: 72.73, why: 'FIXTURE-22: the sleeve is -18.18% below its peak, 72.73% of the 25% tolerance the regime block claims. That tests an ASSUMPTION, not the holdings — nothing here asks for a trade.',
      id: 'risk:regime:riskSleeve:50', firstSeen: T,
    }, boot ? { bootstrap: true } : {});
    const marginEvent = boot => Object.assign({
      reason: 'margin', scope: 'silver', band: 30, bandWas: null, leverage: 1.676, ceiling: 1.4, fromPeakPct: -46.71,
      distanceToCallPctStressed: 26.7, survivabilityPass: false, ask: 'DONE | DEFER',
      why: 'FIXTURE-22: silver is -46.71% below its peak, leverage 1.676x against a 1.4x signed ceiling, stressed call 26.7% away, survivability FAILS. This is the one drawdown that compels an action — repay, do not sell.',
      id: 'risk:margin:silver:30', firstSeen: T,
    }, boot ? { bootstrap: true } : {});
    const monitor = o => Object.assign({
      asOf: T, generatedAt: NOW, source: 'FIXTURE-22 synthetic — no network, no price feed',
      purpose: PD.purpose || 'information, never de-grossing',
      scan: { checkedAt: NOW, ok: true, errors: [] },
      tolerance: { riskSleevePct: 25, netWorthPct: 13.5 }, bands: { thesis: BANDS, regimeFrac: [0.5, 0.8, 1] },
      bootstrap: false, bootstrapNote: null, scopes: scopes(),
      positions: [BIG, TINY], clusters: { note: 'FIXTURE-22 label groups, context only.', groups: [] },
      events: [], eventsFresh: 0, retainDays: 45, bandState: [],
    }, o || {});

    // Clear the sandbox's risk rows so every count below is a count of THIS run, not of the live
    // log's history. This is the 20-hkex/21-themes mistake, refused: no absolute count over
    // alerts.json ever appears in this file.
    const resetRisk = () => ctx.edit('alerts.json', a => { a.alerts = (a.alerts || []).filter(x => x.family !== 'risk'); return a; });
    const riskRows = () => ((ctx.read('alerts.json') || {}).alerts || []).filter(x => x && x.family === 'risk');
    const runAlerts = (dd, label) => {
      ctx.write('drawdown.json', dd);
      const before = riskRows().length;
      const r = ctx.run('alerts.js');
      if (r.exit !== 0) ctx.check(`${label}: alerts.js exit 0`, false, (r.stderr || r.stdout).slice(0, 200));
      const rows = riskRows();
      return { r, rows, added: rows.length - before };
    };

    // (3a) BOOTSTRAP — one summary, no per-event rows.
    resetRisk();
    let A1 = runAlerts(monitor({ bootstrap: true,
      bootstrapNote: 'FIRST RUN: nothing here crossed today.',
      events: [thesisEvent(40, null, true), regimeEvent(true), marginEvent(true)], eventsFresh: 3 }), 'bootstrap run');
    ctx.check('BOOTSTRAP: 3 standing states produce exactly ONE row, and it is a Log summary — not 3 rows, and not a Notable. A first reading is not news (the 13F backfill and the theme radar learned this twice)',
      A1.added === 1 && A1.rows.length === 1 && A1.rows[0].severity === 'Log' && /^risk:bootstrap:/.test(A1.rows[0].id),
      `+${A1.added} · ${A1.rows.map(x => x.severity + ' ' + x.id).join(' | ')}`);
    ctx.check('BOOTSTRAP: no per-event row exists for ANY of the three — no thesis, no regime, no margin id reached the log',
      !A1.rows.some(x => /^risk:(thesis|regime|margin|anomaly):/.test(x.id)), A1.rows.map(x => x.id).join(' | '));
    ctx.check('BOOTSTRAP: the one row names the counts, both headline scopes and the as-of, and SAYS these are first readings rather than today’s moves',
      /first reading/i.test(A1.rows[0].headline) && /FIRST READINGS OF STATES THAT ALREADY EXISTED/.test(A1.rows[0].detail)
      && /1 thesis, 1 regime, 1 margin/.test(A1.rows[0].detail) && /risk sleeve -18\.18%/.test(A1.rows[0].detail)
      && /leverage 1\.676x/.test(A1.rows[0].detail) && A1.rows[0].detail.indexOf(T) > -1,
      A1.rows[0].detail.slice(0, 200));
    ctx.check('BOOTSTRAP: stdout says so out loud, so a reader of the 07:02 log can see the 3 were collapsed rather than lost',
      /risk: \+1 row\(s\).*3 bootstrap reading\(s\) collapsed into ONE Log summary/.test(A1.r.stdout), (A1.r.stdout.match(/ {2}risk:.*/) || [''])[0]);

    // (3b) THE CARRIED-BOOTSTRAP TRAP. drawdown.js writes `bootstrap: !prev`, so the SECOND run has
    // bootstrap:false while the carried events are still bootstrap readings. This is the live state
    // of the file on 2 Oct 2026. Keying only on the top-level flag emits 3 rows about nothing.
    const A2 = runAlerts(monitor({ bootstrap: false, bootstrapNote: null,
      events: [thesisEvent(40, null, true), regimeEvent(true), marginEvent(true)], eventsFresh: 0 }), 'second run');
    ctx.check('THE TRAP: on the second run drawdown.json.bootstrap is already FALSE while the carried events still read bootstrap:true — and NO per-event row is emitted for them. Keying on the top-level flag alone would fire a Notable about a fall months old',
      A2.added === 0 && !A2.rows.some(x => /^risk:(thesis|regime|margin):/.test(x.id)),
      `+${A2.added} · ${A2.rows.map(x => x.id).join(' | ')}`);
    ctx.check('THE TRAP: the summary row is not reprinted either — its id is keyed to the cohort’s firstSeen, not to today, so it dedupes for the whole retention window instead of appearing every morning',
      A2.rows.filter(x => /^risk:bootstrap:/.test(x.id)).length === 1, A2.rows.filter(x => /^risk:bootstrap:/.test(x.id)).map(x => x.id).join(','));

    // (3c) A REAL CROSSING — per-event rows resume, with the documented severities.
    resetRisk();
    const A3 = runAlerts(monitor({ events: [thesisEvent(40, 25), regimeEvent(), marginEvent()], eventsFresh: 3 }), 'real crossings');
    const byId = id => A3.rows.filter(x => x.id === id)[0] || null;
    ctx.check('REAL CROSSINGS: 3 non-bootstrap events produce exactly 3 per-event rows, with drawdown.json’s OWN ids — alerts.js invents none',
      A3.added === 3 && byId('risk:thesis:FX22BIG.SI:40') && byId('risk:regime:riskSleeve:50') && byId('risk:margin:silver:30'),
      `+${A3.added} · ${A3.rows.map(x => x.id).join(' | ')}`);
    ctx.check('SEVERITY BY SCOPE: margin is always Notable (it is the only scope where a fall compels a response); thesis at band 40 is Notable; regime at band 50 is Log (Notable needs 80)',
      byId('risk:margin:silver:30').severity === 'Notable' && byId('risk:thesis:FX22BIG.SI:40').severity === 'Notable'
      && byId('risk:regime:riskSleeve:50').severity === 'Log',
      A3.rows.map(x => x.severity + ' ' + x.id).join(' | '));
    ctx.check('every row carries the numbers from its event AND an as-of, and quotes drawdown.json’s own sentence rather than composing a new one',
      A3.rows.every(x => /drawdown\.json's own sentence, quoted/.test(x.detail))
      && /-58\.04%/.test(byId('risk:thesis:FX22BIG.SI:40').detail) && /106\.34bp/.test(byId('risk:thesis:FX22BIG.SI:40').detail)
      && byId('risk:thesis:FX22BIG.SI:40').date === T && /close /.test(byId('risk:thesis:FX22BIG.SI:40').detail),
      byId('risk:thesis:FX22BIG.SI:40').detail.slice(0, 160));
    ctx.check('tags carry ‘risk’, the reason, and the BOOK tag — not tagOf(), whose map drops .SI/.HK and would answer ‘market-wide’ about a line in the book',
      A3.rows.every(x => (x.tags || []).indexOf('risk') > -1)
      && (byId('risk:thesis:FX22BIG.SI:40').tags || []).indexOf('thesis') > -1
      && (byId('risk:margin:silver:30').tags || []).indexOf('margin') > -1,
      js(A3.rows.map(x => x.tags)));
    ctx.check('the thesis row asks for a NOTE and the margin row for DONE | DEFER — and the margin row says one-action.js sizes the repay, so this family never sizes anything itself',
      /NOTE reply/.test(byId('risk:thesis:FX22BIG.SI:40').detail) && /REPAY, never sell/.test(byId('risk:margin:silver:30').detail)
      && /one-action\.js — not this row — sizes it/.test(byId('risk:margin:silver:30').detail),
      byId('risk:margin:silver:30').detail.slice(-220));

    // (3d) A BAND DOES NOT RE-ALERT ON A SECOND RUN.
    const A4 = runAlerts(monitor({ events: [thesisEvent(40, 25), regimeEvent(), marginEvent()], eventsFresh: 0 }), 'rerun unchanged');
    ctx.check('BANDS, NOT STATES: the identical file run again adds ZERO rows. "FX22BIG is 58% off its high" is true every morning and printing it every morning is wallpaper — the id carries the band, so one fall cannot alert twice',
      A4.added === 0 && A4.rows.length === 3, `+${A4.added} · ${A4.rows.length} total`);

    // (3e) A BAND DOES RE-ALERT WHEN IT WORSENS.
    const A5 = runAlerts(monitor({ events: [thesisEvent(60, 40), regimeEvent(), marginEvent()], eventsFresh: 1 }), 'band worsens');
    const worse = A5.rows.filter(x => x.id === 'risk:thesis:FX22BIG.SI:60')[0] || null;
    ctx.check('A WORSENING BAND IS NEWS: 40 → 60 adds exactly ONE new row, at Notable, and its line says the band WORSENED — recovery, by contrast, lowers a band with no row at all',
      A5.added === 1 && worse && worse.severity === 'Notable' && worse.band === 60 && worse.bandWas === 40
      && /WORSENED, which is the only thing that emits a row/.test(worse.detail),
      `+${A5.added} · ${worse ? worse.id + ' ' + worse.severity : 'missing'}`);
    ctx.check('and the 40% row it replaced is still in the log, untouched — alerts.json is append-only, so a deeper band never rewrites the shallower one',
      A5.rows.some(x => x.id === 'risk:thesis:FX22BIG.SI:40'), A5.rows.map(x => x.id).join(' | '));

    // (3f) THE MATERIALITY GATE, demonstrated on the pair the synthetic file was built around.
    ctx.check(`THE MATERIALITY GATE: the synthetic file carries a ${TINY.navBp}bp line that is ${TINY.peak2y.fromPct}% below its peak — DEEPER than the ${BIG.navBp}bp line that alerted — and it produces no row at all, because ${TINY.navBp}bp is under the ${GATE}bp gate`,
      -TINY.peak2y.fromPct >= BANDS[0] && TINY.navBp < GATE && !A5.rows.some(x => x.ticker === TINY.t),
      `${TINY.t}: ${TINY.peak2y.fromPct}% at ${TINY.navBp}bp vs gate ${GATE}bp`);
    ctx.check('a percentage move is not a risk fact until it is multiplied by position size — policy.drawdown.materialityFirst says so, and the gate is what makes that claim binding rather than decorative',
      /multiplied by position size/i.test(String(PD.materialityFirst || '')), String(PD.materialityFirst || '').slice(0, 90));

    // ── (4) the validator: every contradiction FAILS, and the git guard cannot pass blind ─────
    resetRisk();
    ctx.write('drawdown.json', monitor({ events: [thesisEvent(40, 25), regimeEvent(), marginEvent()] }));
    ctx.expect('validate-all (clean synthetic monitor)', ctx.validateAll('validate-all clean'), {
      passed: [/^drawdown: checked /, /^drawdown: data\/drawdown\.json is not tracked by git \(checked, exit 0\)/],
      notProblems: [/drawdown/i],
    });
    ctx.write('drawdown.json', monitor({ events: [Object.assign(thesisEvent(40, 25), { navBp: 2.91, t: TINY.t, yf: TINY.yf, id: 'risk:thesis:' + TINY.yf + ':40' })] }));
    ctx.expect('validate-all (thesis event UNDER the materiality gate)', ctx.validateAll('validate-all gate'), {
      exit: [1], problems: [new RegExp(`thesis event risk:thesis:${TINY.t}\\.SI:40 is 2\\.91bp of NAV, under the ${GATE}bp materiality gate`)],
    });
    ctx.write('drawdown.json', monitor({ events: [{ reason: 'anomaly', t: BIG.t, yf: BIG.yf, tier: 'notable', dayPct: -11, vol60: 20, navBp: BIG.navBp, barOn: T, id: 'risk:anomaly:' + BIG.yf + ':' + T, firstSeen: T, why: 'FIXTURE-22 anomaly with no sigma.' }] }));
    ctx.expect('validate-all (anomaly with NO sigma)', ctx.validateAll('validate-all sigma'), {
      exit: [1], problems: [/anomaly event risk:anomaly:FX22BIG\.SI:.* carries no sigma/],
    });
    ctx.write('drawdown.json', monitor({ positions: [Object.assign({}, BIG, { bar: { on: null, close: 10, prevOn: null, prev: 10.1 } }), TINY] }));
    ctx.expect('validate-all (a day figure with no bar date)', ctx.validateAll('validate-all stamp'), {
      exit: [1], problems: [/FX22BIG carries a day figure .* with no bar\.on/],
    });
    ctx.write('drawdown.json', monitor({ scan: { checkedAt: new Date(Date.parse(ctx.daysAgo(4) + 'T07:00:00Z')).toISOString(), ok: true, errors: [] },
      events: [thesisEvent(40, 25)] }));
    ctx.expect('validate-all (monitor 4 days stale)', ctx.validateAll('validate-all dead'), {
      exit: [1], problems: [/the drawdown monitor is DEAD, not quiet \(it is a DAILY feed/],
    });
    ctx.write('drawdown.json', monitor({ scan: { checkedAt: NOW, ok: true,
      errors: [{ stage: 'series', t: 'FX22GONE', why: 'FX22GONE.SI is not in closes.json, so it has no drawdown here' }] },
      events: [thesisEvent(40, 25)] }));
    ctx.expect('validate-all (scan errors are a WARNING, not a failure — a line with no series is named, never counted as flat)', ctx.validateAll('validate-all errs'), {
      warnings: [/last scan recorded 1 error\(s\) — FX22GONE: FX22GONE\.SI is not in closes\.json/], notProblems: [/drawdown/i],
    });

    // The plaintext guard. drawdown.json carries navSGD and a valueSGD per position, so only the
    // envelope may ship. Tracked, it must be a FAIL and not a warning.
    ctx.write('drawdown.json', monitor({ events: [thesisEvent(40, 25)] }));
    ctx.git('add', '-f', 'data/drawdown.json');
    const c = ctx.git('commit', '-q', '-m', 'oops: plaintext drawdown');
    ctx.check('precondition: data/drawdown.json committed in the sandbox repo (it is gitignored in the real one)',
      c.exit === 0 && ctx.git('ls-files', '--', 'data/drawdown.json').stdout.trim() === 'data/drawdown.json', c.out);
    ctx.expect('validate-all (drawdown.json TRACKED)', ctx.validateAll('validate-all tracked'), {
      exit: [1], problems: [/^drawdown\.json: TRACKED by git — it carries navSGD and a valueSGD for every position/],
    });
    ctx.git('rm', '-q', '--cached', 'data/drawdown.json'); ctx.git('commit', '-q', '-m', 'untrack');

    // AND the guard must not report success when git itself failed. /usr/bin/git is Apple's xcrun
    // shim and exits 69 ("You have not agreed to the Xcode license agreements") until DEVELOPER_DIR
    // is aimed at the Command Line Tools — which is exactly what research-headless.sh exports and
    // exactly what a hand-run misses. `git ls-files` then prints NOTHING and exits non-zero, and a
    // guard that reads only stdout answers "no plaintext tracked" having checked nothing at all.
    const gitStub = path.join(ctx.stub, 'git');
    fs.writeFileSync(gitStub, '#!/bin/sh\n# FIXTURE-22: Apple\'s xcrun git shim, refusing every command\necho "xcrun: error: You have not agreed to the Xcode license agreements." 1>&2\nexit 69\n', { mode: 0o755 });
    const blind = ctx.validateAll('validate-all git-exit-69');
    ctx.expect('validate-all (git itself exits 69)', blind, {
      problems: [/git ls-files exited 69 for data\/drawdown\.json .* the drawdown plaintext guard did NOT run, and an empty answer from a failed git must never be read as "nothing is tracked"/],
      notPassed: [/^drawdown: data\/drawdown\.json is not tracked by git/],
    });
    // The phase-1 guard beside it checks only `g.error` and not the exit status, so under the same
    // failure it still reports success. Reported, never silently accepted — and it is not this
    // fixture's licence to rewrite a phase-1 check.
    const rep = blind.report || {};
    if ((rep.passed || []).some(l => /^git: no sensitive plaintext tracked/.test(l))) {
      ctx.gap('validate-all/plaintext-exit-status',
        "the phase-1 plaintext guard tests only spawnSync's `error`, not git's exit STATUS, so when git exits non-zero with empty stdout it reports 'git: no sensitive plaintext tracked' having checked nothing",
        `confirmed ${ctx.today}: with git exiting 69, phase 9 FAILED correctly while phase 1 still passed`);
    }
    fs.rmSync(gitStub, { force: true });

    // ── (5) the 08:15 brief block ────────────────────────────────────────────────────────────
    resetRisk();
    ctx.write('drawdown.json', monitor({ events: [thesisEvent(40, 25), regimeEvent(), marginEvent()], eventsFresh: 3 }));
    const B = ctx.dailyBrief('daily-brief with a live monitor');
    const head = (B.stdout.match(/━━ ([^\n]*RISK[^\n]*) ━━/) || [])[1] || null;
    const sect = (() => { const m = /━━ [^\n]*RISK[^\n]*━━\n([\s\S]*?)(?:\n━━ |\n─{10})/.exec(B.stdout); return m ? m[1] : ''; })();
    ctx.check('the brief carries a RISK block, under a 🔔 SIGNALS heading so the DEGRADED (no-research) rebuild keeps it — the drawdown numbers are computed in code and survive that outage',
      !!head && /^🔔 SIGNALS/.test(head), head || '(no RISK heading)');
    ctx.check('it is DAILY, not Monday-only: it rendered today whatever weekday today is, with no --weekday argument',
      !!sect && sect.length > 200, `${sect.length} chars`);
    ctx.check('it leads with the THREE SCOPES and their tolerance usage — the portfolio-level facts before any one line',
      /risk sleeve: -18\.18% below its peak[\s\S]*72\.73% of the 25% tolerance/.test(sect)
      && /net worth: -0\.99% below its peak[\s\S]*7\.33% of the 13\.5% tolerance/.test(sect)
      && /levered \(silver\): -46\.71%[\s\S]*leverage 1\.676x against a signed ceiling of 1\.4x/.test(sect),
      sect.slice(0, 200));
    ctx.check('and net worth carries its WINDOW caveat every time: 21 sessions is not a 1-year or a max drawdown, and must never be read as one',
      /21 session\(s\)/.test(sect) && /NOT a 1-year or max drawdown/i.test(sect), (sect.match(/.*21 session.*/) || [''])[0].slice(0, 160));
    ctx.check('fresh crossings are listed after the scopes, each with its own numbers and its own as-of',
      /CROSSED TODAY · thesis · FX22BIG band 40/.test(sect) && /CROSSED TODAY · margin · silver band 30/.test(sect)
      && /-58\.04% from peak/.test(sect) && /106\.34bp of NAV/.test(sect), (sect.match(/CROSSED TODAY.*/g) || []).join(' | ').slice(0, 220));
    ctx.check('THE ONE ACTION still leads the brief — the risk block sits among the signal blocks and never above it',
      B.stdout.indexOf('━━ THE ONE ACTION ━━') > -1 && B.stdout.indexOf('━━ THE ONE ACTION ━━') < B.stdout.indexOf('RISK'),
      `one-action at ${B.stdout.indexOf('━━ THE ONE ACTION ━━')}, RISK at ${B.stdout.indexOf('RISK')}`);
    // A QUIET DAY MUST NOT LOOK LIKE A DEAD FEED, and a dead one must not look quiet.
    ctx.write('drawdown.json', monitor({ events: [] }));
    const Bq = ctx.dailyBrief('daily-brief on a quiet day');
    const sq = (() => { const m = /━━ [^\n]*RISK[^\n]*━━\n([\s\S]*?)(?:\n━━ |\n─{10})/.exec(Bq.stdout); return m ? m[1] : ''; })();
    ctx.check('A QUIET DAY: the block does NOT disappear — it says no band crossed and stamps drawdown.json’s own scan.checkedAt, because a vanished block is indistinguishable from a dead file',
      /no band crossed today/.test(sq) && /monitor checked /.test(sq), sq.slice(0, 220));
    ctx.write('drawdown.json', monitor({ scan: { checkedAt: new Date(Date.parse(ctx.daysAgo(4) + 'T07:00:00Z')).toISOString(), ok: true, errors: [] }, events: [] }));
    const Bd = ctx.dailyBrief('daily-brief with a dead monitor');
    ctx.check('A DEAD MONITOR: 4 days without a check reads "DEAD, not quiet" in the brief as well as in the validator — a daily feed cannot legitimately be silent',
      /the drawdown monitor is DEAD, not quiet/.test(Bd.stdout), (Bd.stdout.match(/.*DEAD, not quiet.*/) || [''])[0].slice(0, 180));
    ctx.write('drawdown.json', monitor({ events: [thesisEvent(40, 25)] }));

    // ── (6) the manifest ─────────────────────────────────────────────────────────────────────
    const M = ctx.run('manifest.js');
    const man = ctx.read('manifest.json'), mf = (man && man.files && man.files['drawdown.json']) || null;
    const dd = ctx.read('drawdown.json');
    ctx.check('manifest: drawdown.json is listed, cadence daily, asOf = its OWN asOf (the run date), count = positions.length, and it is marked as publishing drawdown.enc rather than itself',
      M.exit === 0 && mf && mf.cadence === 'daily' && mf.asOf === dd.asOf && mf.count === dd.positions.length && mf.published === 'drawdown.enc',
      js(mf));

    // ── (7) the inbox family (inbox.html is not copied into the sandbox; read from the repo) ──
    const inbox = fs.readFileSync(path.join(REPO, 'inbox.html'), 'utf8');
    ctx.check("inbox.html: 'risk' is in the FAM array, so the family chip, the counts and the ?fam= deep link all exist for it",
      /var FAM = \[[^\]]*'risk'[^\]]*\]/.test(inbox), (inbox.match(/var FAM = \[[^\]]*\]/) || [''])[0]);
    ctx.check("inbox.html: the chip carries a readable label, following 'fund'→'funds (13F)' and 'theme'→'themes (radar)'",
      /'risk' \? 'risk \(drawdown\)'/.test(inbox), (inbox.match(/s === 'risk'[^:]*: '[^']*'/) || [''])[0]);

    // ── (8) THE GOVERNING CONSTRAINT, scanned across every surface this phase writes ──────────
    // regime.notRules records P&L-triggered de-grossing and a volatility ceiling as TESTED AND
    // HARMFUL. No row, no brief line and no page line may ask for a position to be cut because it
    // fell. The scan allows the phrases only where they are NEGATED or quoted as the rejected rule.
    const ASK_TO_CUT = /\b(consider (?:reducing|trimming|cutting)|should (?:reduce|trim|cut|sell)|recommend (?:reducing|trimming|selling)|reduce the position|trim the position|cut the position|de-?risk (?:the|this|by)|lighten up|sell into)\b/i;
    resetRisk();
    ctx.write('drawdown.json', monitor({ events: [thesisEvent(40, 25), regimeEvent(), marginEvent()], eventsFresh: 3 }));
    ctx.run('alerts.js');
    const rows = riskRows();
    const offenders = rows.filter(x => ASK_TO_CUT.test(String(x.headline) + ' ' + String(x.detail)));
    ctx.check('NO RISK ROW ASKS FOR A TRIM: not one of the rows this phase writes contains language asking for a position to be cut, reduced or de-risked because it fell',
      rows.length > 0 && offenders.length === 0, offenders.map(x => x.id).join(' | ') || `${rows.length} row(s) clean`);
    const Bf = ctx.dailyBrief('daily-brief, trim scan');
    const sf = (() => { const m = /━━ [^\n]*RISK[^\n]*━━\n([\s\S]*?)(?:\n━━ |\n─{10})/.exec(Bf.stdout); return m ? m[1] : ''; })();
    ctx.check('NOR DOES THE BRIEF BLOCK — and it quotes policy.drawdown.purpose verbatim rather than paraphrasing it, because a paraphrase is how "information" becomes "consider reducing" three edits from now',
      !ASK_TO_CUT.test(sf) && /policy\.drawdown\.purpose, quoted:/.test(sf) && sf.indexOf('INFORMATION, NEVER DE-GROSSING') > -1,
      ASK_TO_CUT.test(sf) ? (sf.match(ASK_TO_CUT) || [''])[0] : 'clean, purpose quoted');
    ctx.check('every risk row names the only two actions this family may request — REPAY (margin) or a written NOTE (thesis) — and nothing else',
      rows.filter(x => x.reason === 'thesis').every(x => /NOTE/.test(x.detail))
      && rows.filter(x => x.reason === 'margin').every(x => /REPAY, never sell/.test(x.detail)),
      rows.map(x => x.reason).join(','));

    // ── (9) THE LIVE FILE: invariants and relationships only, never a count ───────────────────
    // Deliberately not "13 events" or "38 positions": those move every session, and a fixture that
    // goes red because the 07:02 job ran is a fixture nobody trusts (see 20-hkex and 21-themes).
    if (LIVE) {
      const le = (LIVE.events || []).filter(Boolean);
      ctx.check('LIVE INVARIANT: every event carries an id and a reason, so alerts.js can dedupe every one of them and none can be emitted twice under two names',
        le.every(e => typeof e.id === 'string' && e.id && typeof e.reason === 'string' && e.reason),
        `${le.filter(e => !e.id || !e.reason).length} of ${le.length} malformed`);
      ctx.check('LIVE INVARIANT: ids are unique — a repeated id would silently drop a crossing, because the first one in the log wins',
        new Set(le.map(e => e.id)).size === le.length, `${le.length} event(s), ${new Set(le.map(e => e.id)).size} distinct id(s)`);
      ctx.check(`LIVE INVARIANT: every thesis event is at or above the ${GATE}bp materiality gate — the gate BINDS in the live file, not only in the synthetic one`,
        le.filter(e => e.reason === 'thesis').every(e => e.navBp != null && e.navBp >= GATE),
        le.filter(e => e.reason === 'thesis' && !(e.navBp >= GATE)).map(e => `${e.t} ${e.navBp}bp`).join(', ') || 'all above the gate');
      ctx.check('LIVE INVARIANT: every anomaly event carries a sigma, and every figure wears its as-of — no position has a day move without the bar date it came from',
        le.filter(e => e.reason === 'anomaly').every(e => Number.isFinite(Number(e.sigma)))
        && (LIVE.positions || []).every(p => p.day == null || (p.bar && p.bar.on)),
        (LIVE.positions || []).filter(p => p.day != null && !(p.bar && p.bar.on)).map(p => p.t).join(', ') || 'all stamped');
      ctx.check('LIVE RELATIONSHIP: a line past the first thesis band but UNDER the gate exists and has NO event — the gate is doing work in the live book, not sitting decoratively in policy.json',
        (() => {
          const under = (LIVE.positions || []).filter(p => p.peak2y && p.peak2y.fromPct != null && -p.peak2y.fromPct >= BANDS[0] && p.navBp != null && p.navBp < GATE);
          return under.length > 0 && under.every(p => !le.some(e => e.reason === 'thesis' && e.yf === p.yf));
        })(),
        (LIVE.positions || []).filter(p => p.peak2y && -p.peak2y.fromPct >= BANDS[0] && p.navBp < GATE).map(p => `${p.t} ${p.peak2y.fromPct}%/${p.navBp}bp`).join(', ') || 'none');
      ctx.check('LIVE RELATIONSHIP: tolerance usage is the drawdown over the tolerance, for both scopes — a usedOfTolerancePct that does not reconcile would be a number with nothing behind it',
        ['netWorth', 'riskSleeve'].every(k => {
          const s = (LIVE.scopes || {})[k]; if (!s || s.drawdownPct == null || !s.tolerancePct) return false;
          const want = Math.abs(s.drawdownPct) / s.tolerancePct * 100;
          const got = k === 'netWorth' ? s.usedOfTolerancePct : s.usedOfTolerancePct;
          return Math.abs(want - got) < 0.05;
        }), ['netWorth', 'riskSleeve'].map(k => { const s = (LIVE.scopes || {})[k] || {}; return `${k} ${s.drawdownPct}/${s.tolerancePct} ⇒ ${s.usedOfTolerancePct}`; }).join(' · '));
      ctx.check('LIVE RELATIONSHIP: the net-worth scope says out loud that its window is short, so the figure can never be read as a max drawdown by someone who only reads the number',
        /NOT a 1-year or max drawdown/i.test(String(((LIVE.scopes || {}).netWorth || {}).note || '')),
        String(((LIVE.scopes || {}).netWorth || {}).note || '').slice(0, 110));
      // Whether the live file still matches the emailed figures is a NOTE, never a failure: vol60
      // and navBp move every session, and the incident's numbers are frozen above.
      const lx = (LIVE.positions || []).filter(p => p.t === EMAIL.t)[0] || null;
      ctx.note = `live monitor: ${le.length} retained state(s) over ${(LIVE.positions || []).length} priced position(s), bootstrap ${LIVE.bootstrap}, ${le.filter(e => e.bootstrap === true).length} carrying bootstrap:true`
        + ` · gate ${GATE}bp binds · ` + (lx
          ? `${EMAIL.t} today: vol60 ${lx.day && lx.day.vol60} (email froze ${EMAIL.vol60}), ${lx.navBp}bp (email froze ${EMAIL.navBp}), ${lx.peak2y && lx.peak2y.fromPct}% off its 2y peak — the emailed day is asserted against the FROZEN figures, never these`
          : `${EMAIL.t} is no longer a priced position; the emailed day is asserted against the frozen figures alone`);
    } else {
      ctx.note = 'data/drawdown.json absent from the sandbox: the synthetic assertions ran, the live invariants did not';
    }
  },
};
