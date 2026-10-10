/*
 * 04 — 17 Aug 2026 (a Monday). A flat "news newer than 2 days" test failed a correct Monday-morning
 * catch-up: written before 09:00 SGT, the newest close that can exist is Friday's, three days old.
 * The rule now asks the spine which non-crypto session last COMPLETED. Three spine variants must
 * all pass with news 3 days old (a crypto bar today, a partial US bar today, both — neither is a
 * completed equity session), a completed US bar yesterday must fail (the sweep IS behind), and a
 * missing spine falls back to the conservative default (2 days) and fails.
 */
module.exports = {
  name: '04-date-drift-monday', incident: '17 Aug 2026 — Monday catch-up failed by a calendar-day rule; the spine knows which session completed',
  run(ctx) {
    const d3 = ctx.daysAgo(3), d4 = ctx.daysAgo(4);
    const news = () => ctx.edit('news.json', n => { n.items = [3, 4, 5].map(k => ({ date: ctx.daysAgo(k), headline: `fixture item ${k}d old`, summary: 'no price claims here', category: 'macro', impact: 'MIXED', tickers: [], actionable: '', sources: [`https://example.invalid/article/${k}`] })); });
    // no ticker-anchored price claims anywhere, so the reconciliation gate has nothing to say about rewritten bars
    const quiet = () => { ctx.edit('brief.json', b => { b.tldr = ['fixture']; b.signals = []; }); ctx.edit('model.json', m => { if (m.macro) m.macro.narrative = ''; }); };
    const spine = variant => ctx.edit('.prices.json', p => {
      for (const i of Object.values(p.instruments)) {
        const last = i.bars[i.bars.length - 1], prev = i.bars[i.bars.length - 2] || last;
        const bar = (b, d, extra) => { const o = { ...b, d, ...(extra || {}) }; if (!extra) { delete o.partial; delete o.label; } return o; };
        i.bars = [bar(prev, d4), bar(last, d3)];
        if (i.exchange === 'CRYPTO' && (variant === 'crypto' || variant === 'both')) i.bars.push(bar(last, ctx.today));
        if (i.exchange === 'US' && (variant === 'us-partial' || variant === 'both')) i.bars.push(bar(last, ctx.today, { partial: true, label: 'partial session' }));
        if (i.exchange === 'US' && variant === 'us-complete-1d') i.bars.push(bar(last, ctx.daysAgo(1)));
      }
    });
    for (const [label, variant] of [['crypto bar today', 'crypto'], ['partial US bar today', 'us-partial'], ['both'], ['completed US bar yesterday', 'us-complete-1d']]) {
      ctx.resetData(); news(); quiet(); spine(variant || label);
      const r = ctx.validateAll(`validate-all (${label})`);
      if (variant === 'us-complete-1d') ctx.expect(label, r, { exit: [1], problems: [new RegExp(`^news\\.json: newest item is 3 days old but a session has closed since \\(latest completed session ${ctx.daysAgo(1)}\\) — the sweep is behind`)] });
      else ctx.expect(label, r, { passed: [new RegExp(`^news: 3 items, newest 3d old \\(latest completed session ${d3}\\)`)], notProblems: [/^news\.json: newest item/] });
    }
    ctx.resetData(); news(); quiet(); ctx.rm('.prices.json');
    ctx.expect('spine absent', ctx.validateAll('validate-all (spine absent)'), { exit: [1], problems: [/^news\.json: newest item is 3 days old but a session has closed since \(default\) — the sweep is behind/], warnings: [/^prices: data\/\.prices\.json missing — run `node scripts\/price-spine\.js`/] });
  },
};
