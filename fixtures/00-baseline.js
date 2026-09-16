/*
 * 00-baseline — the copy every other fixture starts from must validate green (exit 0 or 2).
 * The harness has already normalised brief.json.date and manifest.sgtDate to today (the real files
 * are yesterday's for ~23 h of every day). If validate-all is still red here, the incidents cannot
 * be replayed meaningfully: BASELINE RED is printed and the fixtures that need green are SKIPPED.
 */
module.exports = {
  name: '00-baseline', incident: 'normalised real data must validate green before the incidents are replayed',
  run(ctx) {
    const r = ctx.validateAll('baseline');
    const rep = r.report || { problems: [], warnings: [], passed: [] };
    const green = [0, 2].includes(r.exit);
    ctx.check('baseline: validate-all exit ∈ {0,2}', green, green ? '' : `BASELINE RED: ${(rep.problems || []).join(' | ') || r.out.slice(-300)}`);
    ctx.expect('baseline', r, { passed: [/^brief: written today/, /^book: \d+ holdings match index\.html exactly/, /^git: no sensitive plaintext tracked/, /^manifest: \d+ files, sgtDate today/] });
    ctx.note = `exit ${r.exit} · ${(rep.passed || []).length} passed · ${(rep.warnings || []).length} warning(s) · ${(rep.problems || []).length} problem(s)`;
    if (!green) console.log(`BASELINE RED: ${(rep.problems || []).join(' | ') || '(no report written)'}`);
  },
};
