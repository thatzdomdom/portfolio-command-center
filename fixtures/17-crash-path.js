/*
 * 17 — validate-all used to CRASH (exit 1, no report written) on a technicals.json without
 * `summary`, a targets.json without `clusters`, or an unparseable .prices.json — and
 * research-headless.sh's alarm then quoted YESTERDAY's report for today's failure. Each is now a FAIL
 * line with the report still written; anything else that throws lands in the catch-all as
 * "validate-all: crashed: …" — also with the report written.
 */
module.exports = {
  name: '17-crash-path', incident: 'phase 4 — a validator crash must be a red line in a fresh report, never a missing report',
  run(ctx) {
    const cases = [
      ['technicals.json without summary', () => ctx.edit('technicals.json', T => { delete T.summary; }), /^technicals\.json: malformed — no `summary` block \(technicals\.js did not finish\); the trend gate cannot be trusted this run/],
      ['targets.json without clusters', () => ctx.edit('targets.json', G => { delete G.clusters; }), /^targets\.json: malformed — no `clusters` array \(targets\.js did not finish\)/],
      ['.prices.json unparseable', () => ctx.write('.prices.json', '{"generated": "2026-09-12T00:00:00Z", "instruments": {'), /^prices: data\/\.prices\.json is unparseable \(.*\) — re-run price-spine\.js; no price claim was reconciled/],
      ['market.json breadth.metrics is a string (uncaught TypeError → catch-all)', () => ctx.edit('market.json', M => { M.breadth = { metrics: 'oops' }; }), /^validate-all: crashed: /],
    ];
    for (const [label, mutate, re] of cases) {
      ctx.resetData(); ctx.rm('.validation.json'); mutate();
      const r = ctx.validateAll(`validate-all (${label})`), passed = (r.report || {}).passed || [];
      ctx.expect(label, r, { exit: [1], problems: [re] });
      if (/catch-all/.test(label)) ctx.check(`${label}: the report holds what ran before the crash (news, model) and nothing after (book parity) — the catch-all path, not a wrap`, passed.some(l => /^model: /.test(l)) && !passed.some(l => /^book: /.test(l)), passed.join(' ‖ '));
      else ctx.check(`${label}: the run completed — the report carries the checks after the wrapped one`, passed.some(l => /^book: |^git: /.test(l)) && passed.length >= 5, `${passed.length} passed`);
    }
  },
};
