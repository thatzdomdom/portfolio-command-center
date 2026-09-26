/*
 * 07 — 8–11 Sep 2026 (Dell). The EDGAR daily index answered 403/503 for days and the brief read
 * "quiet"; on 12 Sep a 503 AFTER a good scan must not look dead either. Guard: freshness is judged
 * from the last scan that actually read an index; a weekday index with zero Form 4 lines is a fetch
 * problem, not a quiet day.
 */
module.exports = {
  name: '07-feed-dead', incident: '8–11 Sep 2026 — a dead Form 4 feed read as a quiet market',
  run(ctx) {
    const scans = s => ctx.edit('signals.json', g => { g.scans = s; });
    const at = d => `${d}T08:30:00.000Z`;
    scans([{ date: ctx.daysAgo(5), at: at(ctx.daysAgo(5)), form4Lines: 900, kept: 200 }]);
    ctx.expect('last good scan 5 days ago', ctx.validateAll(), { exit: [1], problems: [/^signals\.json: last EDGAR scan is 5 days old — the market-wide insider feed is DEAD, not quiet/] });
    scans([{ date: ctx.daysAgo(1), at: at(ctx.daysAgo(1)), form4Lines: 0, kept: 0 }]);
    ctx.expect('zero Form 4 lines on the last scan', ctx.validateAll(), { warnings: [new RegExp(`^signals\\.json: scan ${ctx.daysAgo(1)} saw ZERO Form 4 lines — a weekday index with no filings is a fetch problem, not a quiet day`)], notProblems: [/^signals\.json/] });
    scans([{ date: ctx.daysAgo(1), at: at(ctx.daysAgo(1)), form4Lines: 1076, kept: 234 }, { date: ctx.today, at: at(ctx.today), error: 'index HTTP 503' }]);
    ctx.expect('503 after a good scan (12 Sep regression)', ctx.validateAll(), { passed: [new RegExp(`^signals: last scan ${ctx.daysAgo(1)} · 1076 Form 4 lines · \\d+ facts retained`)], notProblems: [/^signals\.json/], notWarnings: [/^signals\.json/] });
  },
};
