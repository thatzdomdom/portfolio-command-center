/*
 * 21 — phase 8, 20 Sep 2026. Objective 4 ("trade ideas or new trend identification, e.g. Physical
 * AI") was the one the 11 Sep audit found did not exist at all: every theme sentence in the brief
 * was an LLM writing prose about a mood. scripts/themes.js counts EDGAR full-text search hits per
 * quarter instead, and this fixture holds down BOTH halves of that — the parser and the stage rules
 * against the real numbers, and the wiring (alerts, the Monday brief block, validate-all, the
 * manifest, the publish allow-list) against a synthetic file that cannot move when the live one
 * rolls. It NEVER touches the network: themes.js's exported functions are pure.
 *
 * The incident it exists to prevent is one the radar committed on its first real run. The file it
 * wrote said stage "Crowded" while carrying, three lines above, the sentence explaining why the
 * theme was not even a Candidate — because Crowded had been folded into the ladder as a top rung
 * and the stage was re-derived from the newest quarter pair alone. The contract now is:
 *
 *  (a) stage is the DISCOVERY LADDER and nothing else — Watching | Candidate | Evidenced | Priced —
 *      and it is the HIGHEST RUNG EVER ATTAINED, because discovery is a historical event. physical
 *      AI is Evidenced with candidateOn 2026-03-31 on a quarter that did not double.
 *  (b) crowding is a SEPARATE AXIS, and 'crowded' needs three DISTINCT TRUSTS with an EFFECTIVE
 *      (485BPOS) prospectus — never three filings, because one trust amending one prospectus eight
 *      times is one ETF family.
 *  (c) a theme can be crowded having NEVER been a Candidate. humanoid robot is exactly that: its
 *      distinct filers peaked at 9 and four trusts already have an effective prospectus. Product
 *      without breadth is a real reading, and no surface may render it as a contradiction.
 *  (d) entryWindow is a boolean the file computes — stage Priced AND crowding not crowded.
 *  (e) only COMPLETE quarters are scored; the open one is reported partial and never compared, and
 *      a quarter at the 200-hit paging ceiling carries a floor, so any pair touching it is set
 *      aside unscored.
 *  (f) the price leg is never faked: fewer than three of the theme's names in closes.json and the
 *      rung stays Evidenced with the count said out loud.
 *
 * The stored pages in fixtures/data/themes/ are RECONSTRUCTED from data/themes.json, not captured
 * from efts.sec.gov — see fixtures/README.md. They carry only values that file vouches for, and the
 * first assertion below is the round trip that makes them worth having: the parser run over them
 * must reproduce filersNewest, etfs and sic EXACTLY as the live file holds them.
 */
const fs = require('fs'), path = require('path');
const FILE = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'themes', f), 'utf8'));
const js = v => JSON.stringify(v);

module.exports = {
  name: '21-themes', incident: 'phase 8 — no trend identification at all; then a radar that called a theme Crowded three lines under the reason it was not a Candidate',
  requires: ['scripts/themes.js', 'data/themes.json', 'data/policy.json', 'data/alerts.json'],
  run(ctx) {
    const S = require(path.join(ctx.root, 'scripts', 'themes.js'));
    const LIVE = ctx.read('themes.json');
    const POL = ctx.read('policy.json') || {};
    const LADDER = (POL.themes && POL.themes.ladder) || ['Watching', 'Candidate', 'Evidenced', 'Priced'];

    // ── (1) the parser, round-tripped against the real file ───────────────────────────────────
    const page = FILE('physical-ai-2026q3-hits.json'), epage = FILE('physical-ai-etfs-24m-hits.json');
    const live = (LIVE && (LIVE.themes || []).find(t => t.term === 'physical AI')) || null;
    const docs = page.hits.hits.map(h => h._source);
    const filers = S.filersOf(docs);
    // The expectation is FROZEN inside the stored page (_expect), not read from data/themes.json:
    // the radar is weekly and the live file WILL roll to a new quarter. A fixture that went red
    // because a scheduled job ran on time is a fixture nobody trusts. Whether the live file still
    // agrees is reported at the end of this fixture as a note, never as a failure.
    ctx.check('the stored page parses back to the frozen expectation EXACTLY — 56 filers, same CIK, name, ticker and filing count, in the same order',
      filers.length === page._expect.filers.length && js(filers.map(f => [f.cik, f.name, f.ticker, f.filings])) === js(page._expect.filers),
      `${filers.length} parsed vs ${page._expect.filers.length} expected`);
    ctx.check('THE AGGREGATION LIES: entity_filter returns 30 buckets while paging the same hits finds 56 distinct filers — a 46% undercount, which is why distinct filers are paged and the aggregation is only kept beside them as filersAgg',
      page.aggregations.entity_filter.buckets.length === 30 && filers.length === 56,
      `buckets ${page.aggregations.entity_filter.buckets.length} · paged ${filers.length}`);
    const pd = S.parseDisplayName('FARADAY FUTURE INTELLIGENT ELECTRIC INC. (FFAI) (CIK 0001805521)');
    ctx.check('a display name splits into name, ticker and unpadded CIK, and a name with no ticker keeps its whole name',
      pd.name === 'FARADAY FUTURE INTELLIGENT ELECTRIC INC.' && pd.tickers[0] === 'FFAI' && pd.cik === '1805521'
      && S.parseDisplayName('Iron Horse Acquisition II Corp. (CIK 0002051985)').name === 'Iron Horse Acquisition II Corp.', js(pd));
    const etfs = S.etfRows(epage.hits.hits.map(h => h._source));
    ctx.check('the ETF page parses back to the frozen expectation EXACTLY, and the repeated accession is deduped — 37 hits, 36 rows',
      epage.hits.hits.length === epage._expect.hits && etfs.length === epage._expect.etfs.length && js(etfs) === js(epage._expect.etfs),
      `${epage.hits.hits.length} hits → ${etfs.length} rows`);
    ctx.check('485BPOS is effective and 485APOS is not — the distinction the crowding test is built on',
      etfs.filter(e => e.form === '485BPOS').every(e => e.effective === true)
      && etfs.filter(e => e.form !== '485BPOS').every(e => e.effective === false)
      && etfs.some(e => e.form === '485APOS'), js(etfs.slice(0, 2).map(e => [e.form, e.effective])));
    ctx.check('sic_filter parses back to the frozen expectation exactly (27 buckets, 120 documents)',
      js(S.sicRows(page.aggregations).map(s => [s.code, s.count])) === js(page._expect.sic)
      && S.sicRows(page.aggregations).reduce((n, s) => n + s.count, 0) === page._expect.sicDocs, `${page._expect.sic.length} buckets`);

    // ── (2) every stage rule, on synthetic quarter series ─────────────────────────────────────
    const qq = (label, filers2, to, extra) => Object.assign({ q: label, from: null, to: to, filings: filers2,
      filingsDistinct: filers2, filers: filers2, filersAgg: filers2, pagedDocs: filers2, truncated: false, partial: false }, extra || {});
    const ETF_EFF = (trust, cik, date) => ({ trust: trust, cik: cik, form: '485BPOS', date: date, adsh: cik + '-' + date, url: null, effective: true });
    const ETF_PRO = (trust, cik, date) => ({ trust: trust, cik: cik, form: '485APOS', date: date, adsh: cik + '-p-' + date, url: null, effective: false });
    const CLUSTER = [{ cik: '1', ticker: 'FIXC', name: 'Fixture Cluster Co', filings: 3, buys: 3, sells: 0, latest: '2026-08-01', side: 'buy', cluster: true, clusterOn: '2026-08-01', insiders: 3 }];
    const LEG_OK = { coMovement: { rising: true, prior: 0.21, recent: 0.55, window: 60 }, gate: { on: true, onCount: 3, total: 3 } };
    const base = { asOf: '2026-09-20', etfs: [], insiderOverlap: [], pricedNames: [], priceLeg: null, newsInitiations: { count: 0, items: [] } };
    const stage = o => S.stageFor(Object.assign({}, base, o));
    const seen = [];
    const at = o => { const r = stage(o); seen.push(r.stage); return r; };

    const ten = at({ quarters: [qq('A', 10, '2026-03-31'), qq('B', 20, '2026-06-30')] });
    ctx.check('THE 2× RULE NEEDS A BASE ABOVE TEN: 10 → 20 is a doubling and is NOT a Candidate — stays Watching, and why[] names the pair it refused',
      ten.stage === 'Watching' && ten.candidateOn === null && ten.why.some(w => /not a Candidate/.test(w)), `${ten.stage} · ${js(ten.why)}`);
    const eleven = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')] });
    ctx.check('11 → 22 IS a Candidate, candidateOn is the quarter that doubled (2026-06-30), and why[] carries the two counts',
      eleven.stage === 'Candidate' && eleven.candidateOn === '2026-06-30' && eleven.why.some(w => /11 → 22/.test(w)), `${eleven.stage} ${eleven.candidateOn}`);
    const byEtf = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')], etfs: [ETF_PRO('One Trust', '100', '2026-06-01')] });
    ctx.check('EVIDENCED BY PRODUCT: a Candidate plus one ETF filing in the last 12 months — a PROPOSED one counts for Evidenced, which is a different test from crowding',
      byEtf.stage === 'Evidenced' && byEtf.why.some(w => /Evidenced by product/.test(w)), `${byEtf.stage}`);
    const byCluster = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')], insiderOverlap: CLUSTER });
    ctx.check('EVIDENCED BY INSIDERS: a Candidate plus a cluster among the theme’s own filers, with no ETF at all',
      byCluster.stage === 'Evidenced' && byCluster.why.some(w => /Evidenced by insiders/.test(w)), `${byCluster.stage}`);
    const notEvidenced = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')], etfs: [ETF_PRO('Old Trust', '100', '2024-01-01')] });
    ctx.check('a Candidate with neither a cluster nor an ETF inside 12 months stays Candidate and says which two it looked for',
      notEvidenced.stage === 'Candidate' && notEvidenced.why.some(w => /no insider cluster .* and no ETF filing since/.test(w)), `${notEvidenced.stage}`);

    const priced2 = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')], insiderOverlap: CLUSTER, pricedNames: ['AAA', 'BBB'], priceLeg: LEG_OK });
    ctx.check('THE PRICE LEG IS NEVER FAKED: 2 priced names and a perfect price leg still stays Evidenced, and why[] prints the count it had',
      priced2.stage === 'Evidenced' && priced2.why.some(w => /only 2 of the theme's names are priced here \(AAA, BBB\)/.test(w)), `${priced2.stage} · ${js(priced2.why.slice(-2))}`);
    const priced3 = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')], insiderOverlap: CLUSTER, pricedNames: ['AAA', 'BBB', 'CCC'], priceLeg: LEG_OK });
    ctx.check('3 priced names with rising co-movement and a positive gate reach Priced, and why[] carries the correlation pair and the gate count',
      priced3.stage === 'Priced' && priced3.why.some(w => /0\.21→0\.55/.test(w) && /3\/3 names/.test(w)), `${priced3.stage}`);
    const pricedFlat = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')], insiderOverlap: CLUSTER, pricedNames: ['AAA', 'BBB', 'CCC'],
      priceLeg: { coMovement: { rising: false, prior: 0.5, recent: 0.3, window: 60 }, gate: { on: true, onCount: 3, total: 3 } } });
    ctx.check('3 priced names but co-movement falling → stays Evidenced and says which leg failed',
      pricedFlat.stage === 'Evidenced' && pricedFlat.why.some(w => /price leg fails/.test(w)), `${pricedFlat.stage}`);

    // ── crowding: the separate axis ───────────────────────────────────────────────────────────
    const oneTrust3 = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')],
      etfs: [ETF_EFF('One Trust', '100', '2026-06-01'), ETF_EFF('One Trust', '100', '2026-05-01'), ETF_EFF('One Trust', '100', '2026-04-01')] });
    ctx.check('CROWDED COUNTS TRUSTS, NOT FILINGS: three EFFECTIVE filings from ONE trust is packaged, never crowded — one trust amending one prospectus is one ETF family',
      oneTrust3.crowding.level === 'packaged' && oneTrust3.crowding.effectiveTrusts === 1 && oneTrust3.crowding.effectiveFilings === 3
      && oneTrust3.why.some(w => /repeat amendments by one trust are one ETF family/.test(w)), js(oneTrust3.crowding));
    const three = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')],
      etfs: [ETF_EFF('T One', '100', '2026-06-01'), ETF_EFF('T Two', '200', '2026-05-01'), ETF_EFF('T Three', '300', '2026-04-01')] });
    ctx.check('three DISTINCT trusts with an effective prospectus is crowded, and the rung is untouched by it',
      three.crowding.level === 'crowded' && three.crowding.effectiveTrusts === 3 && three.stage === 'Evidenced'
      && LADDER.indexOf(three.stage) > -1, `${three.stage} / ${three.crowding.level}`);
    const proposed = at({ quarters: [qq('A', 5, '2026-03-31'), qq('B', 6, '2026-06-30')], etfs: [ETF_PRO('T One', '100', '2026-06-01')] });
    ctx.check('proposals alone are crowding "proposed", not packaged — crowding counts prospectuses that went effective',
      proposed.crowding.level === 'proposed' && proposed.crowding.proposedFilings === 1 && proposed.crowding.effectiveTrusts === 0, js(proposed.crowding));
    ctx.check('no ETF at all is crowding "none", with every counter at zero and no sentence claiming otherwise',
      ten.crowding.level === 'none' && ten.crowding.effectiveTrusts === 0 && ten.crowding.effectiveFilings === 0 && !ten.why.some(w => /Crowded|packaged/.test(w)), js(ten.crowding));
    const crowdedNoCand = at({ quarters: [qq('A', 9, '2026-03-31'), qq('B', 8, '2026-06-30')],
      etfs: [ETF_EFF('T One', '100', '2026-06-01'), ETF_EFF('T Two', '200', '2026-05-01'), ETF_EFF('T Three', '300', '2026-04-01')] });
    ctx.check('(c) PRODUCT WITHOUT BREADTH: crowded while the rung is Watching and candidateOn is null — the humanoid-robot case, and both readings stand together',
      crowdedNoCand.stage === 'Watching' && crowdedNoCand.candidateOn === null && crowdedNoCand.crowding.level === 'crowded'
      && crowdedNoCand.entryWindow === false, `${crowdedNoCand.stage} / ${crowdedNoCand.crowding.level} / candidateOn ${crowdedNoCand.candidateOn}`);
    // The LIVE file, checked on the INVARIANTS rather than on today's values — those are the radar's
    // to change every Monday, but a file that contradicts itself is never acceptable in any week.
    const liveThemes = (LIVE && LIVE.themes) || [];
    const broken = liveThemes.filter(t => !t || LADDER.indexOf(t.stage) < 0
      || t.entryWindow !== (t.stage === 'Priced' && (t.crowding || {}).level !== 'crowded')
      || (t.candidateOn && t.stage === 'Watching')
      || (t.stage === 'Priced' && (t.pricedNames || []).length < 3)
      || ((t.crowding || {}).level === 'crowded' && (t.crowding.effectiveTrusts || 0) < 3 && (t.crowding.initiations || 0) < 3));
    ctx.check(`the LIVE data/themes.json obeys every invariant in whatever week it is read: ${liveThemes.length} term(s), stage on the ladder, entryWindow === (Priced AND not crowded), candidateOn never under Watching, no Priced without 3 priced names, crowded never on fewer than 3 effective trusts`,
      liveThemes.length > 0 && broken.length === 0,
      js(broken.length ? broken.map(t => [t.term, t.stage, t.candidateOn, (t.crowding || {}).level, t.entryWindow])
        : liveThemes.map(t => [t.term, t.stage, t.candidateOn, (t.crowding || {}).level, t.entryWindow])));
    ctx.check('(c) and at least one live term is crowded — the axis is not theoretical; product exists for these phrases whatever the filer base did',
      liveThemes.some(t => (t.crowding || {}).level === 'crowded'),
      js(liveThemes.map(t => [t.term, (t.crowding || {}).level, (t.crowding || {}).effectiveTrusts])));

    // ── the window, the open quarter, the ceiling, and the ladder itself ──────────────────────
    const pricedCrowded = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30')], insiderOverlap: CLUSTER, pricedNames: ['AAA', 'BBB', 'CCC'], priceLeg: LEG_OK,
      etfs: [ETF_EFF('T One', '100', '2026-06-01'), ETF_EFF('T Two', '200', '2026-05-01'), ETF_EFF('T Three', '300', '2026-04-01')] });
    ctx.check('(d) entryWindow is Priced AND NOT crowded: Priced alone opens it, Priced while crowded does not',
      priced3.entryWindow === true && pricedCrowded.stage === 'Priced' && pricedCrowded.crowding.level === 'crowded' && pricedCrowded.entryWindow === false,
      `Priced ${priced3.entryWindow} · Priced+crowded ${pricedCrowded.entryWindow}`);
    const highest = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30'), qq('C', 23, '2026-09-30')], insiderOverlap: CLUSTER });
    ctx.check('(a) THE RUNG IS THE HIGHEST EVER ATTAINED: a later quarter that does not double keeps Evidenced — re-deriving from the newest pair is what called physical AI "Watching" while six ETFs naming it were trading',
      highest.stage === 'Evidenced' && highest.candidateOn === '2026-06-30', `${highest.stage} ${highest.candidateOn}`);
    const open = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30'), qq('C', 3, '2026-09-20', { partial: true })], insiderOverlap: CLUSTER });
    ctx.check('(e) the OPEN quarter is reported and never scored: 3 filers in a part quarter does not undo Evidenced, and why[] says why it was not compared',
      open.stage === 'Evidenced' && open.why.some(w => /still open \(counted through 2026-09-20\) — reported but never scored/.test(w)), `${open.stage}`);
    const ceiling = at({ quarters: [qq('A', 11, '2026-03-31'), qq('B', 22, '2026-06-30', { truncated: true })] });
    ctx.check('(e) a pair touching the 200-hit paging ceiling is SET ASIDE unscored — a floor divided by a floor is not a measurement',
      ceiling.stage === 'Watching' && ceiling.candidateOn === null && ceiling.why.some(w => /hit the 200-hit paging ceiling/.test(w)), `${ceiling.stage} · ${js(ceiling.why[0])}`);
    ctx.check(`(b) no rule anywhere returned a stage off the ladder: ${[...new Set(seen)].join(', ')} — all of ${LADDER.join(' → ')}`,
      seen.length > 10 && seen.every(s => LADDER.indexOf(s) > -1), js([...new Set(seen)]));

    // ── (3) the wiring, on a synthetic themes.json that cannot move ───────────────────────────
    // Three terms, each a case alerts.js has to get right, named FIXTURE-21 so they can never be
    // mistaken for a seeded theme. The live file is left alone: its assertions are above.
    const nowIso = new Date().toISOString();
    const Q4 = [qq('2026 Q1', 11, '2026-03-31'), qq('2026 Q2', 22, '2026-06-30'), qq('2026 Q3', 9, ctx.today, { partial: true })];
    const term = n => `FIXTURE-21 ${n}`;
    const theme = (n, o) => Object.assign({ term: term(n), seeded: '2026-09-20', note: 'fixture 21 — not a seeded theme',
      stage: 'Watching', stagePrev: null, changedOn: ctx.today, why: ['fixture'], candidateOn: null,
      crowding: { level: 'none', effectiveTrusts: 0, effectiveFilings: 0, proposedFilings: 0, initiations: 0, trusts: [] },
      entryWindow: false, quarters: Q4, filersNewest: [], etfs: [], sic: [], insiderOverlap: [], pricedNames: [],
      priceLeg: { coMovement: { rising: null, why: 'fixture' }, gate: { on: null, why: 'fixture' } }, newsInitiations: { count: 0, items: [] } }, o);
    const synth = {
      asOf: ctx.today, generatedAt: nowIso, source: 'fixture 21 — synthetic, never fetched',
      scan: { checkedAt: nowIso, ok: true, requests: 9, errors: [] },
      guidance: LIVE.guidance,
      themes: [
        theme('transition', { stage: 'Evidenced', stagePrev: 'Candidate', candidateOn: '2026-06-30',
          crowding: { level: 'packaged', effectiveTrusts: 2, effectiveFilings: 2, proposedFilings: 1, initiations: 0, trusts: [{ trust: 'T One', date: '2026-06-01', form: '485BPOS' }] },
          filersNewest: [{ cik: '1801368', name: 'MP Materials Corp.', ticker: 'MP', filings: 4 }], pricedNames: ['MP'] }),
        theme('first', { stage: 'Watching',
          crowding: { level: 'crowded', effectiveTrusts: 3, effectiveFilings: 5, proposedFilings: 2, initiations: 0, trusts: [{ trust: 'T One', date: '2026-06-01', form: '485BPOS' }] },
          filersNewest: [{ cik: '9999999', name: 'Fixture Only Inc.', ticker: 'ZZZZFIX', filings: 1 }],
          etfs: [{ trust: 'T One', cik: '100', form: '485BPOS', date: '2026-06-01', adsh: '0000000000-26-000001', url: 'https://www.sec.gov/Archives/edgar/data/100/000000000026000001/0000000000-26-000001-index.htm', effective: true }] }),
        theme('superseded', { stage: 'Evidenced', candidateOn: '2026-06-30' }),
      ],
      history: [
        { at: ctx.today, term: term('transition'), from: 'Candidate', to: 'Evidenced', why: ['fixture: a real move between two rungs'] },
        { at: ctx.today, term: term('first'), from: null, to: 'Watching', why: ['fixture: the first reading'], bootstrap: true },
        { at: ctx.today, term: term('superseded'), from: null, to: 'Crowded', why: ['fixture: written by the superseded shape of the file'], bootstrap: true },
        { at: ctx.today, term: term('superseded'), from: 'Crowded', to: 'Evidenced', why: ['fixture: the same theme re-derived on the ladder'] },
      ],
    };
    ctx.write('themes.json', synth);

    const r1 = ctx.run('alerts.js');
    const A1 = ctx.read('alerts.json') || { alerts: [] };
    const th1 = A1.alerts.filter(a => a.family === 'theme');
    const byId = id => th1.find(a => a.id === id) || null;
    ctx.check('alerts.js: exit 0 and one themes line on stdout naming the superseded history row it did NOT announce',
      r1.exit === 0 && / {2}themes: \+3 stage · \+2 crowding · 1 history row\(s\) name a stage that is not on the ladder/.test(r1.stdout),
      String(r1.stdout).trim().split('\n').slice(-3).join(' / '));
    ctx.check('(b) the row whose `to` is "Crowded" is NOT alerted: 4 history rows, 3 stage rows, and no row anywhere claims a stage off the ladder',
      th1.filter(a => a.axis === 'stage').length === 3 && !th1.some(a => a.stage && LADDER.indexOf(a.stage) < 0),
      js(th1.filter(a => a.axis === 'stage').map(a => a.id)));
    const move = byId(`theme:fixture-21-transition:stage:Candidate->Evidenced:${ctx.today}`);
    ctx.check('a move between two rungs is NOTABLE, family theme, tagged by the book first then [theme, stage, <rung>], and carries both filer counts',
      !!move && move.severity === 'Notable' && move.family === 'theme' && js(move.tags) === js(['watchlist', 'theme', 'stage', 'Evidenced'])
      && /distinct filers 2026 Q1 11 → 2026 Q2 22/.test(move.detail || '') && move.headline === 'FIXTURE-21 transition · theme stage Candidate → Evidenced',
      js(move && { sev: move.severity, tags: move.tags, head: move.headline }));
    const firstRow = byId(`theme:fixture-21-first:stage:none->Watching:${ctx.today}`);
    ctx.check('the tag comes from the theme’s OWN filers: MP is on the watchlist so the row is tagged watchlist and names it; a theme with no book name is market-wide',
      !!move && /book\/watchlist overlap: MP \(watchlist\)/.test(move.detail || '')
      && !!firstRow && (firstRow.tags || [])[0] === 'market-wide'
      && /none of the theme’s filers is in the book or on the watchlist/.test(firstRow.detail || ''),
      js([move && (move.tags || [])[0], firstRow && (firstRow.tags || [])[0]]));
    const first = firstRow;
    ctx.check('a FIRST READING is Log, not Notable — the rung is the highest ever attained, so finding a theme is not the same as it moving (the 13F backfill rule)',
      !!first && first.severity === 'Log' && (first.tags || []).indexOf('first-reading') > -1 && /first reading/.test(first.headline || ''),
      js(first && { sev: first.severity, tags: first.tags, head: first.headline }));
    const rederived = byId(`theme:fixture-21-superseded:stage:Crowded->Evidenced:${ctx.today}`);
    ctx.check('a row whose `from` is off the ladder is written as a FIRST READING and explicitly NOT as a demotion — nothing about the theme fell',
      !!rederived && rederived.severity === 'Log' && /first reading/.test(rederived.headline || '')
      && /is not on the discovery ladder/.test(rederived.detail || '') && /nothing about the theme fell/.test(rederived.detail || ''),
      js(rederived && { sev: rederived.severity, head: rederived.headline }));
    const crowd1 = byId(`theme:fixture-21-first:crowding:none->crowded:${ctx.today}`);
    ctx.check('(c) crowding is its own row with its own id segment (:crowding: not :stage:), at Log, and it says product-without-breadth in words when the theme was never a Candidate',
      !!crowd1 && crowd1.severity === 'Log' && crowd1.axis === 'crowding' && crowd1.crowding === 'crowded'
      && js(crowd1.tags) === js(['market-wide', 'theme', 'crowding', 'crowded', 'first-reading'])
      && /product without breadth/.test(crowd1.detail || '') && /^https:\/\/www\.sec\.gov\//.test(crowd1.url || ''),
      js(crowd1 && { id: crowd1.id, sev: crowd1.severity, tags: crowd1.tags }));
    ctx.check('a crowding level of "none" is never a row: the absence of product is not an event',
      !th1.some(a => a.axis === 'crowding' && a.crowding === 'none'), js(th1.filter(a => a.axis === 'crowding').map(a => a.id)));
    ctx.check('every theme row quotes themes.json’s guidance as the FILE’s line and carries policy.themes’ "never sizes a position" note — a quotation, not an instruction',
      th1.filter(a => /crowded/.test(js(a.tags)) || /entry window OPEN/.test(a.detail || '')).every(a => /themes\.json’s own guidance line, quoted:/.test(a.detail || ''))
      && th1.every(a => /never sizes a position and never enters The One Action/.test(a.detail || '')),
      js(th1.map(a => /guidance line, quoted/.test(a.detail || ''))));
    ctx.check('no theme row carries a ticker, a usd figure or a clearsWhen other than "read" — a filing count is not a position and never sorts against money',
      th1.every(a => a.ticker === null && a.usd === undefined && a.clearsWhen === 'read'), js(th1.map(a => [a.ticker, a.usd])));

    const r2 = ctx.run('alerts.js');
    const th2 = (ctx.read('alerts.json') || { alerts: [] }).alerts.filter(a => a.family === 'theme');
    ctx.check('a second run adds NOTHING: the log is append-only and every theme id is deduped',
      r2.exit === 0 && / {2}themes: \+0 stage · \+0 crowding/.test(r2.stdout) && th2.length === th1.length,
      `${th1.length} → ${th2.length} · ${(String(r2.stdout).match(/ {2}themes:[^\n]*/) || [])[0]}`);

    // the "never initiate" trigger: packaged → crowded must be logged, once
    ctx.edit('themes.json', t => { t.themes[0].crowding = { level: 'crowded', effectiveTrusts: 3, effectiveFilings: 4, proposedFilings: 1, initiations: 0, trusts: [{ trust: 'T One', date: '2026-06-01', form: '485BPOS' }] }; });
    const r3 = ctx.run('alerts.js');
    const th3 = (ctx.read('alerts.json') || { alerts: [] }).alerts.filter(a => a.family === 'theme');
    const moved = th3.find(a => a.id === `theme:fixture-21-transition:crowding:packaged->crowded:${ctx.today}`);
    ctx.check('packaged → crowded is logged exactly once, diffed against the previous crowding row in this same log, with the rung unchanged beside it',
      r3.exit === 0 && th3.length === th1.length + 1 && !!moved && moved.severity === 'Log'
      && /crowding moved packaged → crowded; the discovery rung is unchanged at Evidenced/.test(moved.detail || ''),
      js(moved && { id: moved.id, sev: moved.severity }));
    const r4 = ctx.run('alerts.js');
    ctx.check('and a fourth run adds nothing again', r4.exit === 0 && / {2}themes: \+0 stage · \+0 crowding/.test(r4.stdout),
      (String(r4.stdout).match(/ {2}themes:[^\n]*/) || [])[0]);
    ctx.note = `${th3.length} theme rows (1 Notable stage move, 2 first readings, ${th3.filter(a => a.axis === 'crowding').length} crowding)`;

    // ── (4) the Monday brief block ────────────────────────────────────────────────────────────
    const mon = ctx.run('daily-brief.js', ['--dry-run', '--weekday=Mon']);
    ctx.check('daily-brief --dry-run --weekday=Mon renders ONE themes section, under a heading validate-pages maps to blk-changed',
      mon.exit === 0 && (mon.stdout.match(/SIGNALS — THEME RADAR/g) || []).length >= 1, (mon.stdout.match(/━━[^\n]*THEME[^\n]*/) || [])[0]);
    ctx.check('the Monday block lists the stage change with its two filer counts and refuses the price leg out loud',
      /FIXTURE-21 transition: Candidate → Evidenced/.test(mon.stdout)
      && /distinct filers 2026 Q1 11 → 2026 Q2 22/.test(mon.stdout)
      && /co-movement needs 3, so the price leg is refused rather than invented/.test(mon.stdout),
      (mon.stdout.match(/FIXTURE-21 transition:[^\n]*/) || [])[0]);
    ctx.check('with no entry window open it reports the STATE and says in words that it is not a suggestion — a caution read as information, never as advice',
      /entry window: none open\./.test(mon.stdout)
      && /it is not a suggestion to do anything or to avoid anything/.test(mon.stdout)
      && /themes\.json’s own guidance line, quoted:/.test(mon.stdout),
      (mon.stdout.match(/entry window: none open[^\n]{0,160}/) || [])[0]);
    const tue = ctx.run('daily-brief.js', ['--dry-run', '--weekday=Tue']);
    ctx.check('and on any other weekday the block is absent entirely — filing counts move on a quarterly clock, so a daily theme line is the same sentence five mornings running',
      tue.exit === 0 && !/THEME RADAR/.test(tue.stdout), (tue.stdout.match(/━━[^\n]*THEME[^\n]*/) || ['(absent)'])[0]);
    ctx.edit('themes.json', t => { t.history.forEach(h => { h.at = ctx.daysAgo(30); }); });
    const quiet = ctx.run('daily-brief.js', ['--dry-run', '--weekday=Mon']);
    ctx.check('a QUIET Monday says "no stage change this week" and still stamps the radar — a block that vanished would read exactly like a file that died',
      /no stage change this week/.test(quiet.stdout) && /radar checked .* weekly by design/.test(quiet.stdout),
      (quiet.stdout.match(/no stage change this week[^\n]{0,120}/) || [])[0]);
    ctx.edit('themes.json', t => { t.history.forEach(h => { h.at = ctx.today; }); });

    // ── (5) validate-all PHASE 8, on the sandbox's themes.json ────────────────────────────────
    const setTh = mutate => { const F = JSON.parse(JSON.stringify(synth)); mutate(F); ctx.write('themes.json', F); };
    setTh(() => {});
    ctx.expect('themes.json as scanned', ctx.validateAll('validate-all (themes as scanned)'), {
      passed: [/^themes: last checked \d{4}-\d{2}-\d{2} \(today\) · 3 term\(s\)/, /^themes: all 3 term\(s\) internally consistent/],
      warnings: [/^themes\.json: 1 history row\(s\) name a stage that is not on the ladder \(Crowded\)/],
      notProblems: [/^themes\.json/] });

    setTh(F => { F.scan.checkedAt = `${ctx.daysAgo(11)}T06:20:00.000Z`; });
    ctx.expect('the radar has not run for 11 days', ctx.validateAll(), {
      exit: [1], problems: [/^themes\.json: last checked 11 days ago \(\d{4}-\d{2}-\d{2}\) — the theme radar is DEAD, not quiet \(weekly cadence plus 3 days of slack\)$/] });
    setTh(F => { F.scan.checkedAt = `${ctx.daysAgo(8)}T06:20:00.000Z`; });
    ctx.expect('but one missed Monday (8 days) is not a failure — the file is SUPPOSED to sit still for weeks', ctx.validateAll(), {
      passed: [/^themes: last checked \d{4}-\d{2}-\d{2} \(8d ago\)/], notProblems: [/^themes\.json/] });

    setTh(F => { F.themes[0].stage = 'Priced'; F.themes[0].pricedNames = ['MP', 'AAA']; });
    ctx.expect('Priced on 2 priced names is a FABRICATED PRICE LEG and blocks the publish', ctx.validateAll(), {
      exit: [1], problems: [/^themes\.json: FIXTURE-21 transition: stage Priced with only 2 of its names in closes\.json — co-movement needs 3, so this price leg was fabricated$/] });
    setTh(F => { F.themes[0].stage = 'Crowded'; });
    ctx.expect('(b) a stage of "Crowded" is a REGRESSION to the folded ladder and is a FAIL, not a warning', ctx.validateAll(), {
      exit: [1], problems: [/^themes\.json: FIXTURE-21 transition: stage "Crowded" is not on the discovery ladder \(Watching → Candidate → Evidenced → Priced\)/] });
    setTh(F => { F.themes[0].stage = 'Priced'; F.themes[0].pricedNames = ['MP', 'AAA', 'BBB']; F.themes[0].entryWindow = true;
      F.themes[0].crowding = { level: 'crowded', effectiveTrusts: 3, effectiveFilings: 4, proposedFilings: 0, initiations: 0, trusts: [] }; });
    ctx.expect('(d) an entry window open while the theme is crowded is a contradiction the brief would print, so it is a FAIL', ctx.validateAll(), {
      exit: [1], problems: [/^themes\.json: FIXTURE-21 transition: entryWindow is true while crowding is crowded/] });
    setTh(F => { F.themes[1].crowding.effectiveTrusts = 2; });
    ctx.expect('crowded claimed on 2 effective trusts — three FILINGS from one trust must never reach crowded', ctx.validateAll(), {
      exit: [1], problems: [/^themes\.json: FIXTURE-21 first: crowded on 2 effective trust\(s\) — crowded needs 3 DISTINCT trusts/] });
    setTh(F => { F.themes[2].candidateOn = '2026-06-30'; F.themes[2].stage = 'Watching'; });
    ctx.expect('(a) candidateOn set while the stage fell back to Watching — the rung is the highest EVER attained', ctx.validateAll(), {
      exit: [1], problems: [/^themes\.json: FIXTURE-21 superseded: candidateOn 2026-06-30 but stage Watching/] });
    setTh(F => { F.themes[0].quarters[1].truncated = true; F.themes[0].quarters[2].truncated = true; });
    ctx.expect('(e) the newest quarter at the paging ceiling is a WARNING that names the term and the quarter', ctx.validateAll(), {
      warnings: [/^themes\.json: FIXTURE-21 transition: the newest quarter 2026 Q3 hit the paging ceiling \(truncated\)/], notProblems: [/^themes\.json/] });

    ctx.rm('themes.json');
    ctx.expect('themes.json absent is a WARNING — the radar is on GitHub Actions and a first Monday has to be allowed to arrive', ctx.validateAll(), {
      warnings: [/^themes\.json: absent — themes\.js has not run \(GitHub Actions, weekly, 06:20 SGT Monday\)$/], notProblems: [/^themes\.json/] });
    const rNone = ctx.run('alerts.js');
    ctx.check('and with no themes.json at all, alerts.js says nothing about themes and still exits 0 — absent → nothing, silently',
      rNone.exit === 0 && !/ {2}themes:/.test(rNone.stdout), (rNone.stdout.match(/ {2}themes:[^\n]*/) || ['(no themes line)'])[0]);
    ctx.write('themes.json', 'not json at all\n');
    ctx.expect('themes.json present but unparseable is a FAIL — the Monday block and both pages read it', ctx.validateAll(), {
      exit: [1], problems: [/^themes\.json: unparseable — the theme rows, the Monday brief block and every page that reads them are broken this run$/] });

    // ── (6) it has to reach the site, and be stamped once it does ─────────────────────────────
    ctx.write('themes.json', synth);
    const man = ctx.run('manifest.js');
    const M = ctx.read('manifest.json') || { files: {} };
    ctx.check('manifest.js stamps themes.json at a WEEKLY cadence with the run date and the term count — a quarterly clock must not read stale every Tuesday',
      man.exit === 0 && M.files['themes.json'] && M.files['themes.json'].cadence === 'weekly'
      && M.files['themes.json'].asOf === ctx.today && M.files['themes.json'].count === 3, js(M.files['themes.json']));
    const ALLOW = require(path.join(ctx.root, 'scripts', 'publish.js')).ALLOW;
    ctx.check('publish.js ALLOW carries data/themes.json — without it the pages 404 on Pages and render as a quiet week while the rows built from it ship',
      ALLOW.indexOf('data/themes.json') > -1, js(ALLOW.filter(f => /themes|hkex/.test(f))));

    // Not an assertion: whether the stored pages still describe the live file. They were frozen on
    // 20 Sep 2026 and the radar is weekly, so a drift here is the radar working, not a regression.
    const drifted = !live || js((live.filersNewest || []).map(f => [f.cik, f.name, f.ticker, f.filings])) !== js(page._expect.filers);
    ctx.note += drifted
      ? ' · the stored EFTS pages no longer match the live themes.json (the radar has rolled since 20 Sep 2026) — the parser assertions run against the frozen _expect and are unaffected'
      : ' · the stored EFTS pages still match the live themes.json exactly';
  },
};
