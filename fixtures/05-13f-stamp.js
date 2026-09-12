/*
 * 05 — 18 Aug 2026. investors.json carried a fresh 17 Aug stamp over Q1 tables while Q2 13Fs had been
 * public since Friday the 14th (Berkshire's Alphabet position had more than doubled inside them).
 * Guard: the quarter check runs BOTH directions against the filing calendar (quarter end + 45 days)
 * and the stamp age is only a warning — bumping it is not a fix. No Date shim: the expected labels
 * are computed from the real clock, so this stays true after 14 Nov when Q3 becomes public.
 */
module.exports = {
  name: '05-13f-stamp', incident: '18 Aug 2026 — Q1 tables served as current with a fresh stamp while Q2 13Fs were public', needsGreen: true,
  run(ctx) {
    const t = Date.parse(ctx.today), due = (q, y) => Date.UTC(y, q * 3, 0) + 45 * 864e5;
    let q = 1, y = 2020, cur = null;
    while (due(q, y) <= t) { cur = [q, y]; q++; if (q > 4) { q = 1; y++; } }
    const next = [q, y], prev = cur[0] === 1 ? [4, cur[1] - 1] : [cur[0] - 1, cur[1]];
    const lbl = ([qq, yy]) => `${yy} Q${qq}`, iso = ms => new Date(ms).toISOString().slice(0, 10);
    ctx.note = `clock: ${lbl(cur)} public since ${iso(due(...cur))} · ${lbl(next)} due ${iso(due(...next))}`;
    ctx.edit('investors.json', i => { i.convictionPlays.current = lbl(prev); });
    ctx.expect(`current = ${lbl(prev)} (a quarter behind)`, ctx.validateAll(), { exit: [1], problems: [new RegExp(`^investors\\.json: shows ${lbl(prev)} but ${lbl(cur)} 13Fs are ALREADY PUBLIC \\(deadline passed\\)`)] });
    ctx.edit('investors.json', i => { i.convictionPlays.current = lbl(next); });
    ctx.expect(`current = ${lbl(next)} (not yet due)`, ctx.validateAll(), { exit: [1], problems: [new RegExp(`^investors\\.json: presents ${lbl(next)} as current, but those 13Fs are not due until ${iso(due(...next))}`)] });
    ctx.edit('investors.json', i => { i.convictionPlays.current = lbl(cur); i.updated = ctx.daysAgo(5) + 'T07:45:00+08:00'; });
    ctx.expect(`current = ${lbl(cur)}, stamped 5d ago`, ctx.validateAll(), { exit: [2], noProblems: true,
      warnings: [/^investors\.json: stamped 5 days ago — re-verify \(note: bumping this stamp is NOT a fix/],
      passed: [new RegExp(`^investors: ${lbl(cur)} is the newest quarter whose 13F deadline has passed`)] });
  },
};
