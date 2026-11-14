/*
 * 16 — the seven-clean-day clock. A synthetic local ledger over the last 10 days (a weekend, one red
 * weekday, a dry-run row after a green one, one day whose report lacks the parity line) is fed to
 * cutover-check.js one day at a time (its per-day parity verdict comes from the live .validation.json
 * of that day and is carried forward in .cutover.json.days). The expected cleanDays / streak /
 * earliestReady are computed here from the documented rule on the REAL clock — no Date shim — so the
 * numbers are exact whichever day the harness runs (rows before 12 Sep and today with no row count
 * for nothing; on the first Saturday every expectation is 0/7 and Tue 22 Sep). Then the page-parity
 * precondition: not confirmed → confirmed via --page-nav within 0.5% → NOT within tolerance at 2%.
 */
module.exports = {
  name: '16-cutover-clock', incident: 'phase 4 — the clock that decides when index.html may lose its Yahoo path',
  run(ctx) {
    const SINCE = '2026-09-12', NEEDED = 7, T = ctx.today, ad = ctx.addDays;
    const wd = d => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w >= 1 && w <= 5; };
    const nextWd = d => { while (!wd(d)) d = ad(d, 1); return d; }, nthWd = (from, n) => { let d = nextWd(from); for (let c = 1; c < n; c++) d = nextWd(ad(d, 1)); return d; };
    const days = []; for (let k = 9; k >= 0; k--) days.push(ad(T, -k));
    const weekdays = days.filter(wd), redDay = weekdays[weekdays.length - 5], noParityDay = weekdays[weekdays.length - 3], dryDay = weekdays[weekdays.length - 2];
    const rows = [];
    for (const d of days) {
      rows.push({ date: d, at: `${d}T00:25:00.000Z`, status: 'green', step: 'pushed', validateAllExit: 2, staged: 3 });
      if (d === redDay) rows.push({ date: d, at: `${d}T00:30:00.000Z`, status: 'red', step: 'validate-all', validateAllExit: 1, staged: null });
      if (d === dryDay) rows.push({ date: d, at: `${d}T01:10:00.000Z`, status: 'dry-run', step: 'red at validate-all', validateAllExit: 1, staged: null });
    }
    ctx.ndjson('.publish-history.ndjson', rows); ctx.rm('.cutover.json');
    const parity = {};
    for (const d of days) {   // one run per day: the live report is that day's, earlier verdicts are carried forward
      parity[d] = d !== noParityDay;
      ctx.write('.validation.json', { checkedOn: d, at: `${d}T00:26:00.000Z`, problems: [], warnings: [], passed: parity[d] ? ['book: 59 holdings match index.html exactly', 'git: no sensitive plaintext tracked'] : ['git: no sensitive plaintext tracked'] });
      const r = ctx.cutover(); if (r.exit !== 0) { ctx.check(`cutover-check failed on ${d}`, false, r.out.slice(-200)); return; }
    }
    // reference: the documented rule on the real clock
    const byDate = {}; [...rows].sort((a, b) => a.at.localeCompare(b.at)).filter(r => r.status !== 'dry-run').forEach(r => { byDate[r.date] = r; });
    const streak = []; let pending = false;
    for (let d = SINCE; d <= T; d = ad(d, 1)) { if (!wd(d)) continue; const r = byDate[d]; if (!r) { if (d === T) pending = true; else streak.length = 0; continue; } if (r.status === 'green' && parity[d] === true) streak.push(d); else streak.length = 0; }
    const cleanDays = streak.length, startsAt = cleanDays ? streak[0] : pending ? T : nextWd(ad(T, 1)), earliestReady = nthWd(startsAt, NEEDED);
    const c = ctx.cutover(), j = c.json || {};
    ctx.check(`cleanDays ${cleanDays}, streak [${streak.join(', ')}] (weekdays since 12 Sep; red or missing parity resets; weekends skipped; dry-run ignored)`, j.cleanDays === cleanDays && JSON.stringify(j.streak) === JSON.stringify(streak), `got ${j.cleanDays} [${(j.streak || []).join(', ')}]`);
    ctx.check(`earliestReady ${earliestReady}`, j.earliestReady === earliestReady, `got ${j.earliestReady}`);
    ctx.check(`stdout says ${cleanDays}/7 clean parallel days`, new RegExp(`^cutover-check — ${T}: ${cleanDays}/7 clean parallel days \\(since Sat, 12 Sept 2026\\)`).test(c.stdout), c.stdout.split('\n')[0]);
    ctx.check(`the dry-run row on ${dryDay} did not override that day's green`, j.days && j.days[dryDay] && j.days[dryDay].status === 'green', JSON.stringify(j.days && j.days[dryDay]));
    ctx.check(`the red weekday ${redDay} is recorded red at validate-all (last non-dry row wins)`, j.days && j.days[redDay] && j.days[redDay].status === 'red' && j.days[redDay].step === 'validate-all', JSON.stringify(j.days && j.days[redDay]));
    ctx.check(`${noParityDay} carries parityOk false, the others true`, j.days && j.days[noParityDay] && j.days[noParityDay].parityOk === false && days.filter(d => d !== noParityDay).every(d => j.days[d] && j.days[d].parityOk === true), JSON.stringify(Object.fromEntries(days.map(d => [d, j.days && j.days[d] && j.days[d].parityOk]))));
    ctx.check('weekend rows are recorded but never in the streak', days.filter(d => !wd(d)).every(d => j.days && j.days[d] && !(j.streak || []).includes(d)));
    ctx.check(`lastDay is ${T} (the newest ledger date)`, j.lastDay && j.lastDay.date === T && j.lastDay.status === 'green', JSON.stringify(j.lastDay));
    ctx.check('ready false, page parity not yet confirmed', j.ready === false && j.pageParity === null && /page parity: not yet confirmed/.test(c.stdout));
    const nav = (ctx.read('valuation.json') || {}).navSGD;
    const p1 = ctx.cutover(['--page-nav', String(Math.round(nav * 1.001))]), pp = (p1.json || {}).pageParity;
    ctx.check('--page-nav +0.1% → parity confirmed and recorded', pp && pp.checkedOn === T && Math.abs(pp.diffPct - 0.1) < 0.02 && /page parity: confirmed/.test(p1.stdout), JSON.stringify(pp));
    ctx.check(`ready = (cleanDays ≥ 7) AND parity → ${cleanDays >= NEEDED}`, (p1.json || {}).ready === (cleanDays >= NEEDED));
    const p2 = ctx.cutover(['--page-nav', String(Math.round(nav * 1.02))]);
    ctx.check('--page-nav +2% → NOT within tolerance, ready false', /page parity: NOT within tolerance/.test(p2.stdout) && (p2.json || {}).ready === false);
    const before = ctx.text('.cutover.json'), dry = ctx.cutover(['--dry-run']);
    ctx.check('--dry-run prints and writes nothing', dry.exit === 0 && /dry-run — nothing written/.test(dry.stdout) && ctx.text('.cutover.json') === before);
    const bad = ctx.cutover(['--page-nav', 'abc']);
    ctx.check('--page-nav without a number → exit 1, one clear line', bad.exit === 1 && /--page-nav needs the NAV in SGD/.test(bad.stderr));
    ctx.note = `${T}: ${cleanDays}/7 · earliest ${earliestReady}`;
  },
};
