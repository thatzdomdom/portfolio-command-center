/*
 * 08 — track.json is APPEND-ONLY: rewriting a past snapshot would silently flatter the model's own
 * hit rate. Guard: a fingerprint of every past snapshot (call count + the length of t‖p3 joined).
 * Dropping a call or deleting a snapshot must fail. KNOWN GAP, deliberately documented rather than
 * hidden: the fingerprint is length-only, so a p1/p12/e3/e12/c edit — or a p3 edit of equal length —
 * passes as "history intact". The harness prints that as KNOWN GAP, not as a failure; the row flips
 * to "no longer reproducible" the day the fingerprint hashes content.
 */
module.exports = {
  name: '08-track-append-only', incident: "rewriting past track.json snapshots would flatter the model's hit rate",
  run(ctx) {
    const pick = () => { const t = ctx.read('track.json'); const i = t.snapshots.findIndex(s => s.date < ctx.today && (s.calls || []).length > 1); return { i, d: t.snapshots[i].date }; };
    let { i, d } = pick();
    ctx.edit('track.json', t => { t.snapshots[i].calls.pop(); });
    ctx.expect(`drop one call from ${d}`, ctx.validateAll(), { exit: [1], problems: [new RegExp(`^track\\.json: PAST snapshot\\(s\\) altered: ${d} — the model's hit rate is computed off these`)] });
    ctx.resetData(); ({ i, d } = pick());
    ctx.edit('track.json', t => { t.snapshots.splice(i, 1); });
    ctx.expect(`delete ${d}`, ctx.validateAll(), { exit: [1], problems: [new RegExp(`^track\\.json: PAST snapshot\\(s\\) deleted: ${d}`)] });
    const gapText = 'fingerprint covers t and p3 length only; p1/p12/e3/e12/c edits are undetected';
    for (const [field, mut] of [['p1', c => { c.p1 = c.p1 === 0.51 ? 0.52 : 0.51; }], ['p3 (equal length)', c => { c.p3 = c.p3 === 0.54 ? 0.45 : 0.54; }]]) {
      ctx.resetData(); ({ i, d } = pick());
      ctx.edit('track.json', t => mut(t.snapshots[i].calls[0]));
      const r = ctx.validateAll(`validate-all (${field} edit on ${d})`);
      const intact = ((r.report || {}).passed || []).some(l => /^track: \d+ snapshots, history intact/.test(l));
      ctx.gap(`track-fingerprint/${field.split(' ')[0]}`, gapText, intact ? `confirmed ${ctx.today}: a ${field} edit on ${d} passed as "history intact"` : `no longer reproducible ${ctx.today} — validate-all said: ${((r.report || {}).problems || []).join(' | ') || 'exit ' + r.exit}`);
    }
  },
};
