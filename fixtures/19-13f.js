/*
 * 19 — phase 6, 13 Sep 2026. The 13F tables came from the research agent under a rule that bumped their
 * stamp every morning (18 Aug: a fresh stamp over Q1 while Q2 had been public four days); 13f-scan.js now
 * parses EDGAR. Its three traps are replayed on REAL public filings stored in fixtures/data/13f/, copied
 * from what 13f-scan.js fetched on its first run — this fixture never touches the network: Berkshire's
 * 89 rows that are 29 positions, Baupost's values in thousands, Pershing Square's 13F-NT naming the CIK
 * that actually reported. Golden: Berkshire Q2 Alphabet, both classes, $37.76bn — the figure the owner
 * was given on 18 Aug. Then validate-all's PHASE 6 lines on the sandbox's data/13f.json: a quarter on
 * EDGAR we did not ingest FAILs, a fund merely late WARNs only, a table that does not add up to its cover
 * FAILs, a scan 5 days old is DEAD. Then investors-compat.js rewrites only its keys and refuses a stale
 * feed. No Date shim: the late quarter is derived from the real clock through the rolled deadline.
 */
const fs = require('fs'), path = require('path');
const FILE = f => fs.readFileSync(path.join(__dirname, 'data', '13f', f), 'utf8');
const js = v => JSON.stringify(v);
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tail = r => String((r && r.out) || '').trim().split('\n').slice(-2).join(' / ').slice(0, 240);
const OWNED = ['updated', 'convictionPlays', 'notableTrades', 'superInvestors'];

module.exports = {
  name: '19-13f', incident: 'phase 6 — 13F tables written by the agent under a daily re-stamp; EDGAR parsed by code instead',
  requires: ['scripts/13f-scan.js', 'scripts/investors-compat.js', 'data/13f.json', 'data/investors.json'],
  run(ctx) {
    const S = require(path.join(ctx.root, 'scripts', '13f-scan.js'));

    // ── (b)(h) Berkshire Q2: reconcile the raw rows FIRST, then units, then aggregate ──────────
    const brkCoverXml = FILE('berkshire-2026q2-cover.xml');
    const brkRows = S.parseInfotable(FILE('berkshire-2026q2-infotable.xml')), brkCover = S.parseCover(brkCoverXml);
    const brkRec = S.reconcile(brkRows, brkCover);
    ctx.check('(b) Berkshire Q2: 89 raw rows reconcile to the cover (tableEntryTotal 89, Σvalue = tableValueTotal 299,253,556,246)',
      brkRec.reconciled && brkRows.length === 89 && brkCover.entries === 89 && brkCover.valueRaw === 299253556246 && brkRec.sumRaw === 299253556246, js(brkRec));
    const brkU = S.detectUnits(brkRows);
    ctx.check('Berkshire reports dollars (median value/share 101.26)', brkU.units === 'dollars' && brkU.factor === 1 && Math.abs(brkU.medianPrice - 101.26) < 0.005, js(brkU));
    const brk = S.aggregate(brkRows, brkU.factor);
    ctx.check('(b) rows repeated once per otherManager aggregate by (cusip, putCall): 89 rows → 29 positions', brk.length === 29, `${brk.length} positions`);
    const clsA = brk.find(h => h.cusip === '02079K305' && !h.putCall), clsC = brk.find(h => h.cusip === '02079K107' && !h.putCall);
    ctx.check('(b) Alphabet Class A 02079K305: 78,791,167 shares summed across 4 rows', !!clsA && clsA.shares === 78791167 && clsA.rows === 4, js(clsA));
    ctx.check('(h) Alphabet Class C 02079K107: 27,188,433 shares, $9,606,489,032', !!clsC && clsC.shares === 27188433 && clsC.valueUSD === 9606489032, js(clsC));
    const goog = clsA && clsC ? (clsA.valueUSD + clsC.valueUSD) / 1e9 : NaN;
    ctx.check('(h) GOLDEN: Berkshire 2026 Q2 Alphabet, both classes = $37.76bn ± $0.01bn', Math.abs(goog - 37.76) <= 0.01, `$${goog.toFixed(4)}bn`);
    ctx.note = `golden Alphabet $${goog.toFixed(3)}bn`;

    // ── (a) Baupost Q2: every tag ns1:-prefixed, values in THOUSANDS ────────────────────────────
    const bpRows = S.parseInfotable(FILE('baupost-2026q2-infotable.xml')), bpCover = S.parseCover(FILE('baupost-2026q2-cover.xml'));
    const bpRec = S.reconcile(bpRows, bpCover), bpU = S.detectUnits(bpRows), bp = S.aggregate(bpRows, bpU.factor);
    ctx.check('(a) Baupost parses and reconciles in its OWN units: 23 rows, Σ 5,415,853 = tableValueTotal', bpRows.length === 23 && bpRec.reconciled && bpRec.sumRaw === 5415853, js(bpRec));
    ctx.check('(a) Baupost detected as THOUSANDS: median value/share < 1, factor 1000', bpU.units === 'thousands' && bpU.factor === 1000 && bpU.medianPrice < 1, js(bpU));
    const amzn = bp.find(h => h.cusip === '023135106' && !h.putCall);
    ctx.check('(a) ×1000 applied: Amazon $892,310,000 for 3,743,854 shares = $238.34/share, not $0.238', !!amzn && amzn.valueUSD === 892310000 && Math.abs(amzn.valueUSD / amzn.shares - 238.34) < 0.01, amzn ? `${amzn.valueUSD} / ${amzn.shares}` : 'no Amazon row');
    const side = (fund, holdings) => ({ fund, period: '2026-06-30', holdings: holdings.map(h => ({ ...h, ticker: null })) });
    const wrong = S.unitsCrossCheck([side('berkshire', brk), side('baupost', S.aggregate(bpRows, 1))]), right = S.unitsCrossCheck([side('berkshire', brk), side('baupost', bp)]);
    ctx.check('(a) units cross-check: Baupost left in raw thousands disagrees with Berkshire on 02079K107 by ×~1000; normalised, nothing disagrees',
      wrong.some(x => x.cusip === '02079K107' && x.ratio > 900) && right.length === 0, `un-multiplied: ${js(wrong.map(x => [x.cusip, x.ratio]))} · normalised: ${right.length}`);

    // ── (c) amendments on the real table ────────────────────────────────────────────────────────
    const extra = { name: 'FIXTURE ISSUER', cls: 'COM', cusip: '000000AA0', figi: null, value: 1000000, shares: 10000, type: 'SH', putCall: null };
    const restated = brkRows.filter(r => r.cusip === '02079K107');
    const nh = S.applyAmendments({ rows: brkRows }, [{ amendmentType: 'NEW HOLDINGS', filed: '2026-08-20', accession: 'nh-1', rows: [extra] }]);
    ctx.check('(c) NEW HOLDINGS merges: 89 + 1 rows → 30 positions, the original rows kept', nh.rows.length === 90 && S.aggregate(nh.rows).length === 30 && nh.applied.length === 1 && nh.applied[0].type === 'NEW HOLDINGS', `${nh.rows.length} rows · ${js(nh.applied)}`);
    const rs = S.applyAmendments({ rows: brkRows }, [{ amendmentType: 'RESTATEMENT', filed: '2026-08-20', accession: 'rs-1', rows: restated }]);
    ctx.check('(c) RESTATEMENT replaces the whole table', rs.rows.length === restated.length && restated.length > 0 && rs.rows.every(r => r.cusip === '02079K107') && rs.applied[0].type === 'RESTATEMENT', `${rs.rows.length} rows · ${js(rs.applied)}`);
    const both = S.applyAmendments({ rows: brkRows }, [
      { amendmentType: 'NEW HOLDINGS', filed: '2026-09-02', accession: 'nh-2', rows: [extra] },
      { cover: { amendmentType: 'RESTATEMENT' }, filed: '2026-08-20', accession: 'rs-2', rows: restated }]);
    ctx.check('(c) applied in FILING order whatever the input order: the 20 Aug restatement, then the 2 Sep new holdings', both.rows.length === restated.length + 1 && both.applied.map(a => a.type).join() === 'RESTATEMENT,NEW HOLDINGS', js(both.applied));

    // ── (d) the 13F-NT that points at the manager which actually reported ──────────────────────
    const ntXml = FILE('pershing-1336528-2026q2-13f-nt.xml'), nt = S.parseCover(ntXml), fn = S.followNotice(ntXml);
    ctx.check('(d) Pershing Square CIK 1336528, 2026 Q2: a 13F-NT / 13F NOTICE with no table of its own', nt.submissionType === '13F-NT' && nt.reportType === '13F NOTICE' && nt.period === '2026-06-30' && nt.cik === 1336528 && nt.entries == null, js(nt));
    ctx.check('(d) followNotice reads <cik>0002026053</cik> → 2026053 (a Number), PERSHING SQUARE INC., 028-25746', !!fn && fn.cik === 2026053 && fn.name === 'PERSHING SQUARE INC.' && fn.fileNumber === '028-25746', js(fn));
    ctx.check('(d) followNotice reads a parsed cover too; a holdings report (Berkshire lists otherManagers2Info) names no one', js(S.followNotice(nt)) === js(fn) && S.followNotice(brkCoverXml) === null, js(S.followNotice(brkCoverXml)));

    // ── (e) a table that does not add up to its own cover ───────────────────────────────────────
    const short = S.reconcile(brkRows.slice(1), brkCover);
    ctx.check('(e) one row missing → reconciled:false, "88 rows vs tableEntryTotal 89"', short.reconciled === false && short.why.includes('88 rows vs tableEntryTotal 89'), short.why.join('; '));
    const off = S.reconcile(brkRows.map((r, k) => (k ? r : { ...r, value: r.value + 2e9 })), brkCover);
    ctx.check('(e) Σvalue 0.67% away from tableValueTotal → reconciled:false (tolerance 0.5%)', off.reconciled === false && off.why.some(w => /^Σvalue \d+ vs tableValueTotal \d+ \(0\.67% apart\)$/.test(w)), off.why.join('; '));

    // ── (g) the filing calendar ─────────────────────────────────────────────────────────────────
    ctx.check("(g) deadlineFor('2026-09-30') === '2026-11-16' (day 45 is Sat 14 Nov)", S.deadlineFor('2026-09-30') === '2026-11-16', S.deadlineFor('2026-09-30'));
    ctx.check("(g) deadlineFor('2026-06-30') === '2026-08-14' and quarterLabel('2026-06-30') === '2026 Q2'", S.deadlineFor('2026-06-30') === '2026-08-14' && S.quarterLabel('2026-06-30') === '2026 Q2', `${S.deadlineFor('2026-06-30')} ${S.quarterLabel('2026-06-30')}`);

    // ── (e)(f) validate-all PHASE 6 on the sandbox's data/13f.json ─────────────────────────────
    let passed = '2024-03-31';                                  // the newest quarter whose ROLLED deadline has passed
    while (S.deadlineFor(S.nextQuarterEnd(passed)) <= ctx.today) passed = S.nextQuarterEnd(passed);
    const base = ctx.read('13f.json'), declared = {};
    ((ctx.read('funds.json') || {}).funds || []).forEach(x => { declared[x.id] = x; });
    const activeIds = Object.keys(base.funds).filter(id => (declared[id] ? declared[id].status : base.funds[id].status) === 'active' && base.funds[id].inferredStatus !== 'stopped' && base.funds[id].latest);
    const id = activeIds.includes('paulson') ? 'paulson' : activeIds[0], id2 = activeIds.find(x => x !== id);
    if (!id || !id2) { ctx.check('two active tracked funds with a table in data/13f.json', false, activeIds.join(', ')); return; }
    const name = base.funds[id].name, name2 = base.funds[id2].name;
    const set13f = mutate => { const F = JSON.parse(JSON.stringify(base)); F.scan.checkedAt = new Date().toISOString(); mutate(F); ctx.write('13f.json', F); };
    ctx.note += ` · newest rolled deadline passed: ${S.quarterLabel(passed)} · test funds ${id}, ${id2}`;

    set13f(() => {});
    ctx.expect('13f.json as scanned, checked now', ctx.validateAll('validate-all (13f as scanned)'), {
      passed: [/^13f: last EDGAR check \d{4}-\d{2}-\d{2} \(today\)$/, /^13f: all \d+ stored tables reconcile to their cover pages$/], notProblems: [/^13f\.json/] });

    const ahead = S.nextQuarterEnd(base.funds[id].latest.period);
    set13f(F => { F.funds[id].edgarLatestPeriod = ahead; });
    ctx.expect(`(f) ${name}: EDGAR shows ${S.quarterLabel(ahead)}, the stored table is ${base.funds[id].latest.quarter}`, ctx.validateAll(), {
      exit: [1], problems: [new RegExp(`^13f\\.json: ${esc(name)} filed ${S.quarterLabel(ahead)} on EDGAR but it is not ingested$`)] });

    const late = S.prevQuarterEnd(passed);
    set13f(F => { const f = F.funds[id]; f.latest.period = late; f.latest.quarter = S.quarterLabel(late); f.edgarLatestPeriod = late; f.inferredStatus = null; f.missedDeadlines = 1; });
    ctx.expect(`(f) ${name} merely late: stored and EDGAR both ${S.quarterLabel(late)} after the ${S.quarterLabel(passed)} deadline`, ctx.validateAll(), {
      warnings: [new RegExp(`^13f\\.json: ${esc(name)} has not filed ${S.quarterLabel(passed)} — their lateness, not ours$`)], notProblems: [/^13f\.json/] });

    const oldest = base.funds[id].history[base.funds[id].history.length - 1];
    set13f(F => { F.funds[id].history[F.funds[id].history.length - 1].reconciled = false; });
    ctx.expect(`(e) ${name} ${oldest.quarter}: a stored history row reconciled:false`, ctx.validateAll(), {
      exit: [1], problems: [new RegExp(`^13f\\.json: ${esc(name)} ${oldest.quarter} does not reconcile to its own cover page — its figures cannot be trusted$`)] });
    set13f(F => { F.funds[id].latest.reconciled = false; F.funds[id].latest.filings = [{ inTable: true, why: ['88 rows vs tableEntryTotal 89'] }]; });
    ctx.expect(`(e) ${name} latest table reconciled:false`, ctx.validateAll(), {
      exit: [1], problems: [new RegExp(`^13f\\.json: ${esc(name)} ${esc(base.funds[id].latest.quarter)} \\(88 rows vs tableEntryTotal 89\\) does not reconcile to its own cover page`)] });

    set13f(F => { F.scan.checkedAt = new Date(Date.now() - 5 * 864e5).toISOString(); });
    ctx.expect('scan.checkedAt 5 days old', ctx.validateAll(), {
      exit: [1], problems: [/^13f\.json: last EDGAR check is 5 days old \(\d{4}-\d{2}-\d{2}\) — the 13F feed is DEAD, not quiet$/] });

    set13f(F => {
      F.funds[id].proposedCik = { cik: 2026053, name: 'PERSHING SQUARE INC.', period: passed };
      F.integrity = [{ period: passed, quarter: S.quarterLabel(passed), cusip: '02079K107', ticker: 'GOOG', name: 'ALPHABET INC', ratio: 1000.2,
        funds: [{ fund: 'berkshire', pricePerShare: 353.33 }, { fund: 'baupost', pricePerShare: 0.3533 }], why: 'fixture' }];
      F.funds[id2].inferredStatus = 'stopped'; F.funds[id2].missedDeadlines = 2;
    });
    ctx.expect('a proposed CIK, a units disagreement, an inferred stop on an active fund', ctx.validateAll(), {
      warnings: [new RegExp(`^13f\\.json: ${esc(name)}: add CIK 2026053 \\(PERSHING SQUARE INC\\.\\) to funds\\.json`), /^13f\.json: units cross-check .*GOOG: price per share differs ×1000\.2/,
        new RegExp(`^13f\\.json: ${esc(name2)}: nothing on EDGAR after .* — the scan infers STOPPED but funds\\.json says active; the owner decides$`)],
      notWarnings: [new RegExp(`^13f\\.json: ${esc(name2)} has not filed`)], notProblems: [/^13f\.json/] });

    ctx.rm('13f.json');
    ctx.expect('13f.json absent', ctx.validateAll(), { warnings: [/^13f\.json: absent — 13f-scan\.js has not run/], notProblems: [/^13f\.json/] });

    // ── investors-compat.js: only its keys, byte-for-byte for the rest; refuses a stale feed ─────
    set13f(() => {});
    const F = ctx.read('13f.json'), C = F.consensus, before = ctx.text('investors.json'), B = JSON.parse(before);
    const dry = ctx.run('investors-compat.js', ['--dry-run']);
    ctx.check('compat --dry-run: exit 0, lists what would change, writes nothing', dry.exit === 0 && /^investors-compat --dry-run: /.test(dry.stdout) && /untouched byte-for-byte: /.test(dry.stdout) && ctx.text('investors.json') === before, tail(dry));
    const r1 = ctx.run('investors-compat.js'), after = ctx.text('investors.json'), A = JSON.parse(after);
    ctx.check('compat: exit 0', r1.exit === 0 && /^investors-compat: /.test(r1.stdout), tail(r1));
    const unit = (/^\{\r?\n([ \t]+)"/.exec(before) || [])[1] || '';
    const block = k => JSON.stringify(k) + (unit ? ': ' + JSON.stringify(B[k], null, unit).replace(/\n/g, '\n' + unit) : ':' + JSON.stringify(B[k]));
    Object.keys(B).filter(k => !OWNED.includes(k)).forEach(k =>
      ctx.check(`compat: "${k}" unchanged byte-for-byte`, before.includes(block(k)) ? after.includes(block(k)) : js(A[k]) === js(B[k]), `${block(k).length} bytes`));
    Object.keys((B.convictionPlays || {}).byQuarter || {}).filter(q => q !== C.quarter).forEach(q =>
      ctx.check(`compat: convictionPlays.byQuarter["${q}"] untouched`, js(A.convictionPlays.byQuarter[q]) === js(B.convictionPlays.byQuarter[q]), q));
    const Q = A.convictionPlays.byQuarter[C.quarter] || {}, sgt = new Date(F.scan.checkedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
    ctx.check(`compat: current = ${C.quarter}, in quarters, top-5 plays per action in the SKILL shape, no invented price`,
      A.convictionPlays.current === C.quarter && A.convictionPlays.quarters.includes(C.quarter) &&
      ['New', 'Added', 'Reduced', 'Exited'].every(a => Array.isArray(Q[a]) && Q[a].length === Math.min(5, C[a].length) && Q[a].every(p => p.action === a &&
        new RegExp(`^${p.count} of ${C.funds} tracked funds `).test(p.summary) && p.investors.length === p.count && p.investors.every(v => v.buyPrice === 'n/a — 13F carries no trade price' && v.quarter === C.quarter))),
      js(['New', 'Added', 'Reduced', 'Exited'].map(a => (Q[a] || []).map(p => `${p.ticker}×${p.count}`))));
    ctx.check('compat: notableTrades = 12 largest |Δ reported value|, each sourced to its sec.gov filing index',
      A.notableTrades.length === 12 && A.notableTrades.every(t => /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[\d-]+-index\.htm$/.test(t.source)), js(A.notableTrades.slice(0, 3)));
    ctx.check(`compat: superInvestors keeps all ${B.superInvestors.roster.length} names, count = roster length; updated = ${sgt} (the SGT date of scan.checkedAt)`,
      B.superInvestors.roster.every(r => A.superInvestors.roster.some(x => x.name === r.name)) && A.superInvestors.count === A.superInvestors.roster.length && A.updated === sgt, `${A.superInvestors.count} · ${A.updated}`);
    ctx.expect('validate-all after compat', ctx.validateAll('validate-all (after compat)'), {
      passed: [new RegExp(`^investors: ${C.quarter} is the newest quarter whose 13F deadline has passed`)], notProblems: [/^investors\.json/, /^13f\.json/] });
    const r2 = ctx.run('investors-compat.js');
    ctx.check('compat: a second run changes nothing', r2.exit === 0 && /no change/.test(r2.stdout) && ctx.text('investors.json') === after, tail(r2));

    ctx.write('13f.json', { ...base, scan: { ...base.scan, checkedAt: new Date(Date.now() - 8 * 864e5).toISOString() } });
    const r3 = ctx.run('investors-compat.js');
    ctx.check('compat: 13f.json last checked 8 days ago → REFUSED, exit 1, investors.json untouched', r3.exit === 1 && /REFUSED — data\/13f\.json last checked EDGAR on \d{4}-\d{2}-\d{2}, 8 days ago/.test(r3.stderr) && ctx.text('investors.json') === after, r3.stderr.trim());
    ctx.write('13f.json', { ...base, scan: { ...base.scan, checkedAt: new Date().toISOString() }, consensus: null });
    const r4 = ctx.run('investors-compat.js');
    ctx.check('compat: no consensus → REFUSED, exit 1, investors.json untouched', r4.exit === 1 && /REFUSED — data\/13f\.json has no consensus/.test(r4.stderr) && ctx.text('investors.json') === after, r4.stderr.trim());
    ctx.rm('13f.json');
    const r5 = ctx.run('investors-compat.js');
    ctx.check('compat: 13f.json absent → REFUSED, exit 1, investors.json untouched', r5.exit === 1 && /REFUSED — data\/13f\.json is absent/.test(r5.stderr) && ctx.text('investors.json') === after, r5.stderr.trim());
  },
};
