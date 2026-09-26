/*
 * 20 — phase 7, 19 Sep 2026. The book is 3.0% HKEX and had no insider coverage at all: EDGAR cannot
 * see a Hong Kong filing, so the pages said "HKEX/SGX insider coverage: not built". hkex-di.js now
 * parses di.hkex.com.hk's own notices table. Its traps are replayed on the REAL public pages stored
 * in fixtures/data/hkex/ — the exact bytes Agent 1 fetched on 19 Sep 2026, sha256 in that folder's
 * README section — and this fixture NEVER touches the network.
 *
 * What it holds down, all of it a way this feed could have lied to the owner:
 *  (a) THE REASON IS A CODE, NOT PROSE. Xiaomi's 1205 row moves 726,000 shares and is a pledge
 *      RELEASE, not a sale; SMIC's 1213 row carries 9,000,000 shares at HKD 79.70 and is still not a
 *      sale, because HKEX's own code says "any other event" (SMIC issued 547m consideration shares
 *      that day). Both must come out 'other' with their numbers intact — inventing the sale and
 *      losing the HKD 717m are both failures.
 *  (b) NULL IS NOT ZERO. A crossing with no bought/sold figure parses to null, never 0, or a page
 *      that averages or sums would report trades that never happened.
 *  (c) TWO DATES. The serial encodes the FILING date, the table's own column the relevant event;
 *      they differ by up to three business days and the Inbox row must be dated by the filing.
 *  (d) (L)/(S)/(P) ARE SEPARATE INTERESTS. BlackRock's long and short legs sit in the same cells;
 *      picking the first number would mix them.
 *  (e) pctAfter IS PER SHARE CLASS. Lei Jun filed 90.06% and 9.69% on the SAME DAY — Class A and
 *      Class B of a dual-class company. Neither is "his stake in Xiaomi".
 *  (f) QUIET IS NOT DEAD. Tencent lodged ONE notice in ninety days. validate-all must judge this
 *      feed on the SCAN, never on filings.length, or it declares a healthy feed dead most weeks.
 *  (g) THE TIER KEYS OFF direction + role. A director buy is the only HKEX row policy escalates.
 *
 * The spec asked for "a named director row with its average price". There is no such row: every one
 * of the nine director notices in the window is a class conversion with NO price, so the fixture
 * asserts the null and the class pair instead of an invented number.
 */
const fs = require('fs'), path = require('path');
const FILE = f => fs.readFileSync(path.join(__dirname, 'data', 'hkex', f), 'utf8');
const js = v => JSON.stringify(v);

module.exports = {
  name: '20-hkex', incident: 'phase 7 — no HK insider coverage at all; HKEX disclosure notices parsed by code',
  requires: ['scripts/hkex-di.js', 'data/hkex.json', 'data/policy.json', 'data/alerts.json'],
  run(ctx) {
    const S = require(path.join(ctx.root, 'scripts', 'hkex-di.js'));
    const parse = (file, code, yf) => {
      const p = S.parseNoticesPage(FILE(file), code);
      return { page: p, rows: p.rows.map(r => S.parseRow(r, { code, yf, bookName: null }, p.name)).filter(Boolean) };
    };

    // ── (a)-(e) the parser, on the stored pages ────────────────────────────────────────────────
    const X = parse('notices-1810-90d.html', '1810', '1810.HK');
    ctx.check('Xiaomi page: "Xiaomi Corporation - W", the page says 44 records and 44 rows parse',
      X.page.name === 'Xiaomi Corporation - W' && X.page.total === 44 && X.page.hasTable && X.rows.length === 44,
      `${js(X.page.name)} total ${X.page.total} rows ${X.rows.length}`);
    const dirs = X.rows.reduce((o, r) => (o[r.direction] = (o[r.direction] || 0) + 1, o), {});
    ctx.check('(a) 44 Xiaomi notices are 1 buy, 1 sell, 42 other — the busiest HK name in 90 days holds two trades',
      dirs.buy === 1 && dirs.sell === 1 && dirs.other === 42, js(dirs));
    const by = (rows, s) => rows.find(r => r.serial === s);

    const buy = by(X.rows, 'CS20260903E00040');
    ctx.check('the only buy: CS20260903E00040, BlackRock, code 1001 "you purchased the shares", 8,338,458 sh at HKD 27.6247, Form 2',
      !!buy && buy.direction === 'buy' && buy.reason === '1001' && buy.filer === 'BlackRock, Inc.' && buy.form === '2'
      && buy.role === 'substantial-shareholder' && buy.sharesInvolved === 8338458 && buy.avgPrice === 27.6247 && buy.currency === 'HKD', js(buy));
    const sell = by(X.rows, 'CS20260829E00026');
    ctx.check('the only sell: CS20260829E00026, code 1201 "you completed a sale", 2,378,944 sh at HKD 28.0233',
      !!sell && sell.direction === 'sell' && sell.reason === '1201' && sell.sharesInvolved === 2378944 && sell.avgPrice === 28.0233, js(sell));

    const sL = buy && buy.interests.find(i => i.position === 'L'), sS = buy && buy.interests.find(i => i.position === 'S');
    ctx.check('(d) (L)/(S): the row is L — 1,069,346,988 sh / 5.01% — and the 29,862,600 sh (0.14%) SHORT leg is kept apart, not summed into it',
      !!sL && !!sS && buy.position === 'L' && buy.sharesAfter === 1069346988 && buy.pctAfter === 5.01
      && sL.shares === 1069346988 && sS.shares === 29862600 && sS.pct === 0.14, js(buy && buy.interests));

    ctx.check('(c) the serial is the FILING date: CS20260625E00375 → 2026-06-25, DA20260811E00498 → 2026-08-11',
      S.ymdOfSerial('CS20260625E00375') === '2026-06-25' && S.ymdOfSerial('DA20260811E00498') === '2026-08-11',
      `${S.ymdOfSerial('CS20260625E00375')} / ${S.ymdOfSerial('DA20260811E00498')}`);
    ctx.check('(c) the two dates differ by design: the buy was dealt 2026-08-31 and filed 2026-09-03, lag 3 days',
      !!buy && buy.date === '2026-08-31' && buy.filed === '2026-09-03' && buy.filedLagDays === 3,
      buy ? `${buy.date} → ${buy.filed} (${buy.filedLagDays}d)` : 'no buy row');

    const cross = by(X.rows, 'CS20260723E00550');
    ctx.check('(b) a crossing with no bought/sold figure: CS20260723E00550 → sharesInvolved null (NOT 0), no price, direction other',
      !!cross && cross.sharesInvolved === null && cross.avgPrice === null && cross.direction === 'other' && cross.reason === '1213', js(cross));

    const pledge = by(X.rows, 'CS20260908E00043');
    ctx.check('(a) the pledge trap: 1205 "you ceased to have a security interest" moves 726,000 sh and is NOT a sale',
      !!pledge && pledge.reason === '1205' && pledge.sharesInvolved === 726000 && pledge.direction === 'other'
      && !S.SELL.has('1205') && !S.BUY.has('1004'), js(pledge));
    ctx.check('(a) the allow-list is codes, not words: BUY has 1001/1010/1011, SELL has 1201/1209, and 1004/1205/1213/1313/1314 are in neither',
      S.BUY.has('1001') && S.BUY.has('1010') && S.BUY.has('1011') && S.SELL.has('1201') && S.SELL.has('1209')
      && !['1004', '1205', '1213', '1313', '1314'].some(c => S.BUY.has(c) || S.SELL.has(c)),
      `BUY ${js([...S.BUY])} SELL ${js([...S.SELL])}`);

    const lei = X.rows.filter(r => r.filer === 'Lei Jun' && r.filed === '2026-08-11');
    const classA = lei.find(r => r.pctAfter === 90.06), classB = lei.find(r => r.pctAfter === 9.69);
    ctx.check('(e) Lei Jun filed TWO notices on 11 Aug — 90.06% and 9.69% — two share classes of a dual-class company, neither one "his stake in Xiaomi"',
      lei.length === 2 && !!classA && !!classB && classA.serial !== classB.serial, js(lei.map(r => [r.serial, r.pctAfter])));
    ctx.check('the director rows are Form 3A, role director-or-ceo, 12,950,321 sh and NO price — a class conversion, not a trade, so avgPrice is null not 0',
      lei.every(r => r.form === '3A' && r.role === 'director-or-ceo' && r.direction === 'other' && r.avgPrice === null && r.sharesInvolved === 12950321),
      js(lei.map(r => [r.form, r.role, r.direction, r.avgPrice, r.sharesInvolved])));
    ctx.check('zero director BUYS in the whole 90-day window — the feed is reported as it is, not as the tier would like it',
      X.rows.filter(r => r.role === 'director-or-ceo' && r.direction === 'buy').length === 0,
      `${X.rows.filter(r => r.role === 'director-or-ceo').length} director notice(s), none a buy`);

    // ── (f) the quiet name, and the priced non-trade ───────────────────────────────────────────
    const T = parse('notices-0700-90d.html', '0700', '0700.HK');
    ctx.check('(f) Tencent: ONE notice in ninety days on a valid table — 1,682 sh by a holder of 0.00%, code 1316, direction other',
      T.page.total === 1 && T.page.hasTable && T.rows.length === 1 && T.rows[0].reason === '1316'
      && T.rows[0].direction === 'other' && T.rows[0].sharesInvolved === 1682 && T.rows[0].pctAfter === 0 && T.rows[0].avgPrice === null,
      js(T.rows[0]));
    const M = parse('notices-0981-90d.html', '0981', '0981.HK');
    const bigFund = by(M.rows, 'CS20260625E00375'), cict = by(M.rows, 'CS20260626E00481');
    ctx.check('(a) SMIC: BOTH notices are code 1213 "any other event" and BOTH are other — 2 rows, 0 buys, 0 sells',
      M.rows.length === 2 && M.rows.every(r => r.reason === '1213' && r.direction === 'other'), js(M.rows.map(r => [r.serial, r.reason, r.direction])));
    ctx.check('(a) the priced non-trade: 9,000,000 sh at HKD 79.70 are KEPT as facts while direction stays other — calling it a sale invents one, dropping it loses HKD 717m',
      !!bigFund && bigFund.sharesInvolved === 9000000 && bigFund.avgPrice === 79.7 && bigFund.currency === 'HKD'
      && bigFund.direction === 'other' && bigFund.pctAfter === 6.8, js(bigFund));
    ctx.check('(b) the other SMIC notice moved nobody: no shares, no price, 13.50% after — the percentage moved because the company issued shares',
      !!cict && cict.sharesInvolved === null && cict.avgPrice === null && cict.pctAfter === 13.5 && cict.direction === 'other', js(cict));

    // ── (g) policy.hkex through alerts.js, on the sandbox copy ─────────────────────────────────
    // The sandbox's data/hkex.json is REBUILT from the stored pages, so these assertions do not move
    // when the live file rolls. One synthetic row is appended — a director buy, which the real window
    // does not contain — because policy.hkex.directorBuy is the only HKEX tier that can reach Notable
    // and an untested escalation path is the one that breaks. It is named FIXTURE-20 so it can never
    // be mistaken for a filing.
    const all = X.rows.concat(T.rows, M.rows);
    const dirBuy = { ...buy, id: '1810:DA20260918E09999', serial: 'DA20260918E09999', form: '3A', role: 'director-or-ceo',
      filer: 'FIXTURE-20 DIRECTOR (not a real filing)', reason: '1001', reasonText: 'you purchased the shares',
      reasons: [{ code: '1001', position: 'L', text: 'you purchased the shares' }], direction: 'buy',
      sharesInvolved: 1000000, avgPrice: 30, date: ctx.daysAgo(2), filed: ctx.daysAgo(1), filedLagDays: 1 };
    const hkex = {
      generatedAt: new Date().toISOString(), source: 'fixture 20 — stored HKEX notices pages', bookSource: 'book.json',
      scan: { checkedAt: new Date().toISOString(), ok: true, errors: [], requests: 3 },
      universe: [{ code: '0700', yf: '0700.HK', name: 'Tencent Holdings Ltd.', sid: '6893' },
        { code: '0981', yf: '0981.HK', name: 'Semiconductor Manufacturing International Corporation', sid: '6552' },
        { code: '1810', yf: '1810.HK', name: 'Xiaomi Corporation - W', sid: '208656' }],
      filings: [dirBuy].concat(all).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      scans: [{ date: ctx.today, at: new Date().toISOString(), codes: 3, rows: all.length + 1, kept: all.length + 1 }],
    };
    ctx.write('hkex.json', hkex);
    const before = (ctx.read('alerts.json').alerts || []).length;
    const r1 = ctx.run('alerts.js');
    const A1 = ctx.read('alerts.json') || { alerts: [] };
    const hk1 = A1.alerts.filter(a => /^hk:/.test(a.id));
    ctx.check('alerts.js: exit 0 and one HKEX line on stdout',
      r1.exit === 0 && /^ {2}HKEX: \+\d+ notice\(s\) \(\d+ Notable\)/m.test(r1.stdout), String(r1.stdout).trim().split('\n').slice(-2).join(' / '));
    ctx.check(`(g) one alert per notice: ${hkex.filings.length} filings → ${hkex.filings.length} hk: rows, ids 'hk:<code>:<serial>', nothing dropped and nothing doubled`,
      hk1.length === hkex.filings.length && hk1.every(a => /^hk:\d{4}:[A-Z]{2}\d{8}[A-Z]\d+$/.test(a.id))
      && new Set(hk1.map(a => a.id)).size === hk1.length && A1.alerts.length >= before + hk1.length,
      `${hk1.length} rows · alerts ${before} → ${A1.alerts.length} (the rest are this sandbox's Form 4 backlog)`);
    const nb = hk1.find(a => a.id === 'hk:1810:DA20260918E09999');
    ctx.check('(g) the director buy is the ONLY Notable HKEX row, tagged [in-book, HKEX, director-or-ceo], family insider, url kept',
      !!nb && nb.severity === 'Notable' && hk1.filter(a => a.severity === 'Notable').length === 1
      && js(nb.tags) === js(['in-book', 'HKEX', 'director-or-ceo']) && nb.family === 'insider' && nb.ticker === '1810'
      && /^https:\/\/di\.hkex\.com\.hk\//.test(nb.url || ''), js(nb && { sev: nb.severity, tags: nb.tags, id: nb.id, usd: nb.usd }));
    const bkBuy = hk1.find(a => a.id === 'hk:1810:CS20260903E00040');
    ctx.check("(g) BlackRock's purchase is a substantial-shareholder row and stays at Log — index and custodian mechanics do not get escalated",
      !!bkBuy && bkBuy.severity === 'Log' && js(bkBuy.tags) === js(['in-book', 'HKEX', 'substantial-shareholder']), js(bkBuy && { sev: bkBuy.severity, tags: bkBuy.tags }));
    ctx.check('(g) the HK codes are tagged in-book, never market-wide: tagOf() drops .HK symbols and would have called a 3.0% sleeve market-wide',
      hk1.every(a => (a.tags || [])[0] === 'in-book'), js([...new Set(hk1.map(a => (a.tags || [])[0]))]));
    ctx.check('(g) every row carries policy.json’s own reason for its severity, labelled as such',
      !!bkBuy && /why Log: a 5% holder crossing is usually index or custodian mechanics/.test(bkBuy.detail || '')
      && !!nb && /why Notable: a director or chief executive buying their own listed company/.test(nb.detail || ''), js(nb && nb.detail));
    ctx.check('(c) the Inbox row is dated by the FILING date, not the relevant event: the buy reads 2026-09-03 and says "dealt 31 Aug, filed 3 Sep"',
      !!bkBuy && bkBuy.date === '2026-09-03' && /dealt 31 Aug, filed 3 Sep \(3d\)/.test(bkBuy.detail || ''), js(bkBuy && { date: bkBuy.date, detail: bkBuy.detail }));
    ctx.check('money is quoted in HKD with the SGD equivalent, and usd is present only as a sort key',
      !!bkBuy && /HKD 230\.3M/.test(bkBuy.headline || '') && /at HKD 27\.6247/.test(bkBuy.detail || '') && /≈ S\$37\.5M/.test(bkBuy.detail || '') && typeof bkBuy.usd === 'number',
      js(bkBuy && { headline: bkBuy.headline, usd: bkBuy.usd }));
    const others = hk1.filter(a => !/^hk:1810:(CS20260903E00040|CS20260829E00026|DA20260918E09999)$/.test(a.id));
    ctx.check(`(a) all ${others.length} non-trade rows say NOT A TRADE and none claims a verb — no "bought"/"sold" anywhere in their headlines`,
      others.length === hkex.filings.length - 3 && others.every(a => / · NOT A TRADE · HKEX code /.test(a.headline || ''))
      && !others.some(a => /\b(bought|sold)\b/.test(a.headline || '')), js(others.slice(0, 2).map(a => a.headline)));
    const smic = hk1.find(a => a.id === 'hk:0981:CS20260625E00375');
    ctx.check('(a) SMIC HKD 717m disposal: the row keeps 9,000,000 sh at HKD 79.7 and HKEX’s own wording, and still claims no trade',
      !!smic && /NOT A TRADE/.test(smic.headline || '') && /9,000,000 sh at HKD 79\.7/.test(smic.detail || '') && /any other event/.test(smic.detail || ''), js(smic && smic.detail));
    const noShares = hk1.find(a => a.id === 'hk:0981:CS20260626E00481');
    ctx.check('(b) the no-figure crossing prints "no share figure on the notice" — never 0, never a made-up size',
      !!noShares && /no share figure on the notice/.test(noShares.detail || '') && !/\b0 sh\b/.test(noShares.detail || ''), js(noShares && noShares.detail));
    const r2 = ctx.run('alerts.js');
    const hk2 = (ctx.read('alerts.json') || { alerts: [] }).alerts.filter(a => /^hk:/.test(a.id));
    ctx.check('a second run adds NOTHING: append-only and deduped by id', r2.exit === 0 && / {2}HKEX: \+0 notice\(s\)/.test(r2.stdout) && hk2.length === hk1.length,
      `${hk1.length} → ${hk2.length} · ${String(r2.stdout).trim().split('\n').slice(-1)[0]}`);
    ctx.note = `${hk1.length} HKEX rows, 1 Notable (the synthetic director buy); 2 real trades in 90 days`;

    // ── (f) validate-all PHASE 7 on the sandbox's data/hkex.json ───────────────────────────────
    const setHk = mutate => { const F = JSON.parse(JSON.stringify(hkex)); mutate(F); ctx.write('hkex.json', F); };
    const at = d => `${d}T08:30:00.000Z`;

    setHk(() => {});
    ctx.expect('hkex.json scanned today', ctx.validateAll('validate-all (hkex as scanned)'), {
      passed: [/^hkex: last scan \d{4}-\d{2}-\d{2} \(today\) · 3 code\(s\) · \d+ notice\(s\) retained/, /^hkex: all 3 HK book line\(s\) covered \(0700, 0981, 1810\)$/],
      notProblems: [/^hkex\.json/], notWarnings: [/^hkex\.json/] });

    setHk(F => { F.filings = []; });
    ctx.expect('(f) ZERO filings but a scan today — the normal week, and it must stay green', ctx.validateAll(), {
      passed: [/^hkex: last scan \d{4}-\d{2}-\d{2} \(today\) · 3 code\(s\) · 0 notice\(s\) retained · newest filed none in the window$/],
      notProblems: [/^hkex\.json/], notWarnings: [/^hkex\.json/] });

    setHk(F => { F.scans = [{ date: ctx.daysAgo(5), at: at(ctx.daysAgo(5)), codes: 3, rows: 0, kept: 0 }]; F.scan.checkedAt = at(ctx.daysAgo(5)); });
    ctx.expect('last successful scan 5 days ago', ctx.validateAll(), {
      exit: [1], problems: [/^hkex\.json: last successful scan is 5 days old \(\d{4}-\d{2}-\d{2}\) — the HKEX disclosure feed is DEAD, not quiet$/] });

    setHk(F => { F.scans = [{ date: ctx.daysAgo(5), at: at(ctx.daysAgo(5)), codes: 3, rows: 1, kept: 1 },
      { date: ctx.today, at: at(ctx.today), codes: 3, rows: 0, kept: 0, error: 'notices for 1810 page 1: HTTP 503' }]; });
    ctx.expect('a 503 today after a good scan 5 days ago is still DEAD — freshness comes from the last SUCCESSFUL scan', ctx.validateAll(), {
      exit: [1], problems: [/^hkex\.json: last successful scan is 5 days old/] });

    setHk(F => { F.universe = F.universe.filter(u => u.code !== '0981'); F.scans[0].codes = 2; F.scans.length = 1; F.scans[0].at = new Date().toISOString(); F.scans[0].date = ctx.today; });
    ctx.expect('(f) a scan covering fewer codes than the book holds names the missing one', ctx.validateAll(), {
      warnings: [/^hkex\.json: the last scan covered 2 code\(s\) but the book holds 3 HK line\(s\) — 0981 never scanned$/], notProblems: [/^hkex\.json/] });

    setHk(F => { F.bookSource = 'none'; });
    ctx.expect("bookSource 'none'", ctx.validateAll(), {
      warnings: [/^hkex\.json: bookSource 'none' — the scan found neither book\.json nor index\.html holdings/], notProblems: [/^hkex\.json/] });

    setHk(F => { F.scan.errors = [{ code: '0981', stage: 'paging', message: '0981: the page says 4 record(s) and 2 parsed — rows may be missing' }]; });
    ctx.expect('a scan error is reported without stopping the publish', ctx.validateAll(), {
      warnings: [/^hkex\.json: last scan recorded 1 error\(s\) — 0981 paging: 0981: the page says 4 record\(s\)/], notProblems: [/^hkex\.json/] });

    ctx.rm('hkex.json');
    ctx.expect('hkex.json absent', ctx.validateAll(), {
      warnings: [/^hkex\.json: absent — hkex-di\.js has not run \(GitHub Actions\)$/], notProblems: [/^hkex\.json/] });

    ctx.write('hkex.json', 'not json at all\n');
    ctx.expect('hkex.json present but unparseable', ctx.validateAll(), {
      exit: [1], problems: [/^hkex\.json: unparseable — the HK insider rows, and every page that reads them, are broken this run$/] });

    // ── the manifest entry, and why its asOf is the scan ───────────────────────────────────────
    setHk(F => { F.filings = F.filings.slice(0, 3); });
    const m = ctx.run('manifest.js'), man = ctx.read('manifest.json') || { files: {} };
    const e = man.files['hkex.json'] || {};
    ctx.check('manifest: hkex.json is stamped with the LAST SCAN and counts notices — a quiet feed must not read STALE on a daily cadence',
      m.exit === 0 && e.asOf === ctx.today && e.cadence === 'daily' && e.count === 3 && /last successful scan/.test(e.source || ''), js(e));
  },
};
