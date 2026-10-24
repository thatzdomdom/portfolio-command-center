/*
 * 23-fixture-ledger — the watchdog's own watchdog.
 *
 * INCIDENT, 3 Oct 2026: nothing ran scripts/test-fixtures.js. Not validate-all.js, not publish.js,
 * not research-headless.sh, not a workflow, not a launchd job — it ran only when a human typed it.
 * Fixtures 20 and 21 were red for twelve days and the only reason anyone found out was a manual run.
 * The regression net had a hole in it, and the net was the thing meant to report holes.
 *
 * The fix: test-fixtures.js now writes data/.fixtures.json, research-headless.sh runs the suite every
 * morning AFTER publish, and validate-all.js reads the ledger so a red suite appears in the morning
 * integrity section. That check is now the single thing standing between a broken codebase and
 * silence — so it is the last thing that should be untested. This file tests it.
 *
 * THE INVARIANT THAT MATTERS MOST is the last one: every one of these states must be a WARNING and
 * never a PROBLEM. validate-all's problems[] turn the publish red and send the 08:15 brief as
 * [DEGRADED]. A code-regression test going red is not a reason to stop publishing today's prices, and
 * wiring it as a FAIL would mean a stale assertion about a fixture could take the owner's morning
 * email down. If someone later "tightens" these to fail(), this fixture is what says no.
 *
 * Synthetic throughout: it writes its own ledgers into the sandbox and never reads the real suite
 * result, so it cannot go red because of an unrelated fixture. No network.
 */
const path = require('path'), fs = require('fs');
const REPO = path.join(__dirname, '..');
const js = v => JSON.stringify(v);

// A ledger that passes everything, as the shape test-fixtures.js actually writes it.
const green = today => ({
  at: `${today}T01:00:00.000Z`, today,
  total: 23, passed: 23, failed: 0, skipped: 0,
  failedNames: [], failedChecks: [], knownGaps: 2, unexpectedNtfy: 0,
  selected: 23, discovered: 23, full: true, durationMs: 26000,
  note: 'synthetic ledger written by fixture 23',
});
const daysBefore = (today, n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

module.exports = {
  name: '23-fixture-ledger',
  incident: 'the regression suite was wired to nothing and sat red for 12 days; this tests the check that now reports it, and pins it as a WARN so a red suite can never degrade the 08:15 brief',
  requires: ['scripts/validate-all.js', 'scripts/test-fixtures.js'],
  run(ctx) {
    const T = ctx.today;
    const set = o => ctx.write('.fixtures.json', o);
    const mut = f => { const o = green(T); f(o); return o; };

    // ── (1) green, full, today ────────────────────────────────────────────────────────────────
    set(green(T));
    const g = ctx.expect('ledger green', ctx.validateAll('validate-all (suite green)'), {
      passed: [/^fixtures: all 23 fixture\(s\) green \(ran \d{4}-\d{2}-\d{2}, today, \d+s\)/],
      notWarnings: [/^\.fixtures\.json/], notProblems: [/^\.fixtures\.json/] });
    ctx.check('the green line reports the KNOWN GAPs rather than hiding them behind a pass',
      ((g.report || {}).passed || []).some(l => /2 KNOWN GAP\(s\) still open/.test(l)),
      ((g.report || {}).passed || []).filter(l => /^fixtures:/.test(l)).join(' ‖ '));

    // ── (2) RED — the twelve-day case ─────────────────────────────────────────────────────────
    set(mut(o => { o.failed = 2; o.passed = 21; o.failedNames = ['20-hkex', '21-themes'];
      o.failedChecks = ['20-hkex: one alert per notice: 48 filings → 48 hk: rows']; }));
    ctx.expect('ledger RED', ctx.validateAll('validate-all (suite red)'), {
      warnings: [/^\.fixtures\.json: the regression suite is RED: 2 of 23 fixture\(s\) failing/,
        /20-hkex, 21-themes/, /first failure: 20-hkex: one alert per notice/],
      notPassed: [/^fixtures: all/], notProblems: [/^\.fixtures\.json/] });

    // ── (3) STALE — the step is wired but silently not running ────────────────────────────────
    set(mut(o => { o.today = daysBefore(T, 4); }));
    ctx.expect('ledger stale', ctx.validateAll('validate-all (suite 4 days stale)'), {
      warnings: [/^\.fixtures\.json: the regression suite last ran 4 days ago/, /stale here means unguarded/],
      notPassed: [/^fixtures: all/], notProblems: [/^\.fixtures\.json/] });
    // 2 days is the boundary and must still pass, or a weekend turns the check into wallpaper
    set(mut(o => { o.today = daysBefore(T, 2); }));
    ctx.expect('ledger exactly 2 days old still passes', ctx.validateAll('validate-all (2d old)'), {
      passed: [/^fixtures: all 23 fixture\(s\) green \(ran \d{4}-\d{2}-\d{2}, 2d ago/],
      notWarnings: [/^\.fixtures\.json/] });

    // ── (4) PARTIAL — a --only run must not clear the check ───────────────────────────────────
    set(mut(o => { o.full = false; o.selected = 2; }));
    ctx.expect('ledger partial', ctx.validateAll('validate-all (--only run)'), {
      warnings: [/^\.fixtures\.json: the last suite run was PARTIAL \(2 of 23 fixture\(s\)/, /a --only run does not clear this check/],
      notPassed: [/^fixtures: all/], notProblems: [/^\.fixtures\.json/] });

    // ── (5) a pass that leaked to the real alarm channel is not a pass ────────────────────────
    set(mut(o => { o.unexpectedNtfy = 1; }));
    ctx.expect('ledger with an unexpected ntfy call', ctx.validateAll('validate-all (leaked ntfy)'), {
      warnings: [/^\.fixtures\.json: the suite passed but made 1 unexpected ntfy call\(s\)/],
      notPassed: [/^fixtures: all/], notProblems: [/^\.fixtures\.json/] });

    // ── (6) ABSENT — the state the repo was actually in until today ───────────────────────────
    ctx.rm('.fixtures.json');
    ctx.expect('ledger absent', ctx.validateAll('validate-all (no ledger)'), {
      warnings: [/^\.fixtures\.json: absent — the regression suite has never written a ledger/, /node scripts\/test-fixtures\.js/],
      notPassed: [/^fixtures: all/], notProblems: [/^\.fixtures\.json/] });

    // ── (7) unparseable — a truncated write must not read as "no ledger, never mind" ──────────
    ctx.write('.fixtures.json', '{"today":');
    const bad = ctx.validateAll('validate-all (truncated ledger)');
    ctx.check('a truncated ledger is reported, not silently treated as absent-and-fine, and still never a problem',
      (((bad.report || {}).warnings) || []).some(l => /^\.fixtures\.json/.test(l))
      && !(((bad.report || {}).problems) || []).some(l => /^\.fixtures\.json/.test(l)),
      js({ warnings: ((bad.report || {}).warnings || []).filter(l => /fixtures/.test(l)),
        problems: ((bad.report || {}).problems || []).filter(l => /fixtures/.test(l)) }));

    // ── (8) THE INVARIANT. Every state above is a WARNING, never a PROBLEM ────────────────────
    // validate-all's problems[] turn the publish red and send the brief as [DEGRADED]. A red
    // code-regression suite must never do that: by the time it runs, publish has already happened,
    // and a stale assertion about a fixture is not a reason to take the owner's morning email down.
    const states = [
      ['red', mut(o => { o.failed = 3; o.failedNames = ['x']; })],
      ['stale', mut(o => { o.today = daysBefore(T, 30); })],
      ['partial', mut(o => { o.full = false; })],
      ['ntfy', mut(o => { o.unexpectedNtfy = 4; })],
    ];
    // MEASURE THE LEDGER'S OWN CONTRIBUTION, not validate-all's overall exit code. The first version
    // of this asserted `r.exit !== 1`, which coupled the invariant to the whole of the sandbox's copy
    // of live data: on 9 Oct 2026 news.json carried a fabricated O39.SI price, validate-all exited 1
    // for that reason alone, and this check went red while the thing it tests was working perfectly.
    // The guarantee that actually matters is DIFFERENTIAL — whatever else is wrong, a red ledger must
    // not make it worse — so the baseline is a green ledger and every other state is compared to it.
    set(green(T));
    ctx.run('validate-all.js');
    const baseRep = ctx.read('.validation.json') || {};
    const baseProblems = (baseRep.problems || []).length;
    const leaked = [];
    for (const [name, led] of states) {
      set(led);
      ctx.run('validate-all.js');
      const rep = ctx.read('.validation.json') || {};
      const probs = rep.problems || [];
      if (probs.some(l => /fixtures/.test(l))) leaked.push(`${name} put a fixtures line in problems[]`);
      if (probs.length !== baseProblems) leaked.push(`${name} changed the problem count ${baseProblems} → ${probs.length}`);
    }
    ctx.check('EVERY ledger state is a WARNING: none adds a problems[] entry and none changes the problem count against a green ledger — so a red regression suite can never block the publish or degrade the 08:15 brief, whatever else is wrong that morning',
      leaked.length === 0, leaked.join('; ') || `no state altered problems[] (baseline ${baseProblems})`);

    // ── (9) the ledger is harness state and must never reach the public repo ──────────────────
    // Read the sandbox's own .gitignore: ctx.run only launches node scripts, and git in the sandbox
    // would hit the Xcode licence gate anyway (exit 69) — which is exactly the fail-open this repo
    // just closed, so it is not something to depend on inside a fixture.
    const gi = (() => { try { return fs.readFileSync(path.join(ctx.root, '.gitignore'), 'utf8'); } catch (_) { return null; } })();
    ctx.check('data/.fixtures.json is gitignored — harness state, not portfolio data; the public repo has no business carrying the owner\'s test results',
      gi != null && /^data\/\.fixtures\.json$/m.test(gi), gi == null ? 'no .gitignore in the sandbox' : 'present in .gitignore');

    set(green(T));
    ctx.note = 'all 8 ledger states reported; every one a WARN, none exits 1 — a red suite cannot degrade the brief';
  },
};
