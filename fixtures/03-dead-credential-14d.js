/*
 * 03 — 8–21 Aug 2026. The CLI credential died and the 07:02 research ABORTed fourteen mornings
 * running; every brief carried one small red line and the fix sat undone for two weeks. Guard:
 * daily-brief.js counts the ABORT streak from the research log and leads with "day N" and the
 * remedy — the streak, not the file age, because Dom hand-refreshed some mornings (brief −2 here).
 * Sub-case: no log at all → the file age (−14) still says day 14.
 */
const LOG = today => {
  const ago = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);
  let s = '';
  for (let k = 14; k >= 1; k--) { const d = ago(k); s += `=== ${d} 07:02:00 research start ===\n${d} 07:02:05 ABORT — not authenticated and no long-lived token set.\n${d} 07:02:05 detail: token file present but empty\n=== ${d} 07:02:05 research end (exit 78 — auth) ===\n`; }
  return s;
};
module.exports = {
  name: '03-dead-credential-14d', incident: '8–21 Aug 2026 — fourteen ABORT mornings, each brief carrying one small red line', log: LOG,
  run(ctx) {
    ctx.edit('brief.json', b => { b.date = ctx.daysAgo(2) + String(b.date).slice(10); });
    ctx.expect('validate-all', ctx.validateAll(), { exit: [1], problems: [/^brief\.json: dated 2 day\(s\) ago/] });
    let db = ctx.dailyBrief('daily-brief (brief −2, 14 ABORT runs)');
    ctx.check('subject says day 14 — the run streak, not the 2-day file age', /^\[DEGRADED\] .*NO RESEARCH — day 14 — /.test(db.subject), db.subject);
    ctx.check('body names the credential, the streak and its first date', new RegExp(`has no credential — the 07:02 research has failed 14 mornings running, since ${ctx.daysAgo(14)}`).test(db.stdout));
    ctx.check('body carries the paste-able fix', /claude setup-token/.test(db.stdout));
    ctx.removeLog();
    ctx.edit('brief.json', b => { b.date = ctx.daysAgo(14) + String(b.date).slice(10); });
    db = ctx.dailyBrief('daily-brief (brief −14, no log)');
    ctx.check('subject says day 14 from the file age alone', /NO RESEARCH — day 14 — /.test(db.subject), db.subject);
    ctx.check('body falls back to the generic cause when the log is unreadable', /Cause: the 07:02 research run did not complete/.test(db.stdout));
  },
};
