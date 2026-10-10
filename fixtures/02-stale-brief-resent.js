/*
 * 02 — 5 Aug 2026. Research died instantly ("Not logged in"), brief.json stayed yesterday's, and the
 * 36-hour freshness window happily emailed yesterday's analysis under today's subject. Guards:
 * validate-all names the age, publish.js goes red at validate-all (a dry run records 'dry-run',
 * never a day status), and daily-brief.js sends [DEGRADED] with the stale date in the subject.
 */
module.exports = {
  name: '02-stale-brief-resent', incident: "5 Aug 2026 — yesterday's brief.json re-sent under today's date",
  run(ctx) {
    ctx.edit('brief.json', b => { b.date = ctx.daysAgo(1) + String(b.date).slice(10); });
    ctx.expect('validate-all', ctx.validateAll(), { exit: [1], problems: [/^brief\.json: dated 1 day\(s\) ago — the morning email would send stale content under today's date/] });
    const p = ctx.publish();
    ctx.expect('publish --dry-run', p, { exit: [1], stdoutMatch: /RED at validate-all — NOT pushing/ });
    ctx.check("ledger: the dry run recorded {status:'dry-run', step:'red at validate-all', validateAllExit:1}", p.lastRow && p.lastRow.status === 'dry-run' && p.lastRow.step === 'red at validate-all' && p.lastRow.validateAllExit === 1 && p.lastRow.date === ctx.today, JSON.stringify(p.lastRow));
    const db = ctx.dailyBrief();
    ctx.check('subject leads with [DEGRADED] … day 1', /^\[DEGRADED\] .*NO RESEARCH — day 1 — brief is /.test(db.subject), db.subject);
    ctx.check('subject names the stale data date', db.subject.includes(`brief is ${ctx.daysAgo(1)} data, not `), db.subject);
    ctx.check('body banner: NO RESEARCH TODAY — DAY 1 OF THIS OUTAGE', /NO RESEARCH TODAY — DAY 1 OF THIS OUTAGE/.test(db.stdout));
    ctx.check("body names the missing sections instead of re-sending yesterday's TLDR", /━━ RESEARCH MISSING TODAY ━━/.test(db.stdout));
  },
};
