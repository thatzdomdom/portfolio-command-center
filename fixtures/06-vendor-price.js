/*
 * 06 — Aug/Sep 2026. A spot/CFD quote was published as a Brent exchange settle; OCBC carried two
 * different Tuesday closes for days; on 11 Sep a contract roll moved Brent 108.95 → 107.63 after the
 * brief said "toward $108-109" and a 0.25% tolerance blocked the push over a rounded range. Guard:
 * every $/S$/HK$-anchored claim near a tracked name is reconciled against the spine (1% only when
 * the claim is explicitly approximate or a range); low-trust series are skipped and surfaced, never
 * "confirmed"; "$1,993/oz" and "$305m" are units, not quotes, and are not counted.
 */
module.exports = {
  name: '06-vendor-price', incident: 'Aug–Sep 2026 — vendor quotes published as closes; a rounded Brent range blocked a push',
  run(ctx) {
    const brent = trust => ctx.edit('.prices.json', p => { const b = p.instruments['BZ=F'], i = b.bars.length - 1; b.bars[i] = { ...b.bars[i], o: 101.8, h: 109.05, l: 100.19, c: 107.63 }; b.trust = trust; });
    const quiet = () => { ctx.edit('news.json', n => n.items.forEach(x => { x.summary = 'fixture — no price claims'; x.actionable = ''; })); ctx.edit('model.json', m => { if (m.macro) m.macro.narrative = ''; }); };
    const tldr = lines => ctx.edit('brief.json', b => { b.tldr = lines; b.signals = []; });
    const units = ["Barrick's cost of sales ran at $1,993/oz last quarter.", 'Pan American booked $305m of net earnings.'];
    quiet(); brent('ok');
    tldr(['DBS closed at S$63.00 after the CPI print.', 'Brent toward $108-109 on the Hormuz escalation.', ...units]);
    ctx.expect('DBS asserted at S$63 against a ~S$76 tape', ctx.validateAll(), { exit: [1],
      problems: [/^prices: brief\.tldr\[0\] asserts D05\.SI at 63, which matches no traded close\/high\/low \(recent closes: /], notProblems: [/BZ=F|GOLD|PAAS|1993|305/] });
    tldr(['Brent toward $108-109 on the Hormuz escalation.', ...units]);
    ctx.expect('Brent "toward $108-109" vs a 107.63 close (1% for a range); /oz and $m not counted', ctx.validateAll(), { passed: [/^prices: 1\/1 asserted prices reconcile against the spine/], notProblems: [/^prices:/] });
    brent('low');
    ctx.expect('BZ=F marked low-trust → skipped and surfaced, never confirmed', ctx.validateAll(), { warnings: [/^prices: skipped reconciliation for low-trust series \(BZ=F\) — the spine flags these as rolled\/thin/], passed: [/^prices: spine loaded; no ticker-anchored price claims to reconcile/] });
  },
};
