/*
 * 01 — 6 Jul 2026. The research agent published an M44U insider buy "at ~S$1.91/unit" on a day the
 * unit traded S$1.21–1.23 and had never printed above S$1.80 in three years; Dom caught it, not the
 * pipeline. Guard: validate-intel.js prices every asserted figure against the tape (curl → Yahoo
 * chart — stubbed here with a 1.15–1.30 tape keyed by the symbol) and quarantines on --fix. The same
 * item cited only a homepage, so validate-all's "cite no source" line is asserted too (on news.json,
 * where that rule lives).
 */
const bars = (() => { const out = []; for (let t = Date.parse('2026-06-22T00:00:00Z'), i = 0; i < 21; i++, t += 864e5) { const w = new Date(t).getUTCDay(); if (w === 0 || w === 6) continue; out.push({ ts: Math.floor(t / 1000), lo: +(1.15 + (i % 5) * 0.01).toFixed(2), hi: +(1.25 + (i % 5) * 0.01).toFixed(2) }); } return out; })();
const chart = { chart: { result: [{ meta: { currency: 'SGD', symbol: 'M44U.SI' }, timestamp: bars.map(b => b.ts),
  indicators: { quote: [{ low: bars.map(b => b.lo), high: bars.map(b => b.hi), open: bars.map(b => +(b.lo + 0.03).toFixed(2)), close: bars.map(b => +(b.hi - 0.03).toFixed(2)), volume: bars.map(() => 1e6) }] } }], error: null } };
module.exports = {
  name: '01-fabricated-price', incident: '6 Jul 2026 — M44U insider buy asserted at ~S$1.91 on a S$1.21–1.23 tape',
  curlResponse: { '/chart/M44U.SI?': chart },
  run(ctx) {
    ctx.edit('intel.json', d => {
      d.insiders = [{ ticker: 'M44U', insider: 'Ng Kiat', role: 'Chief Executive Officer', type: 'Buy', shares: '~100,000 units', value: '~S$191K at ~S$1.91/unit', date: '2026-07-06',
        rationale: 'fixture — the 6 Jul incident replayed', sources: ['https://links.sgx.com/FileOpen/fixture.ashx?App=Announcement&FileID=1'] }];
      d.congress = []; d.dataQuality = { note: 'fixture', removed: [] };
    });
    const r1 = ctx.run('validate-intel.js');
    ctx.expect('validate-intel (report)', r1, { exit: [1], stdoutMatch: [/never printed|IMPOSSIBLE/, /M44U/] });
    ctx.check('validate-intel (report): intel.json untouched without --fix', ctx.read('intel.json').insiders.length === 1);
    const r2 = ctx.run('validate-intel.js', ['--fix']);
    ctx.expect('validate-intel --fix', r2, { exit: [0], stdoutMatch: /quarantined 1 entry into intel\.json/ });
    const q = ctx.read('intel.json'), rm = (q.dataQuality.removed || [])[0] || {};
    ctx.check('--fix: dataQuality.removed[0].assertedPrice === 1.91 (stated)', rm.assertedPrice === 1.91 && rm.assertedVia === 'stated' && rm.ticker === 'M44U', JSON.stringify(rm));
    ctx.check('--fix: actualRange comes from the stubbed 1.15–1.30 tape', /^1\.1\d0–1\.\d\d0$/.test(String(rm.actualRange)) && rm.onDay, `${rm.actualRange} · on day ${rm.onDay}`);
    ctx.check('--fix: the entry is gone from intel.insiders', q.insiders.length === 0);
    const calls = ctx.stubLog().filter(c => c.tool === 'curl');
    ctx.check('curl went to the stub, asked for M44U.SI, never for ntfy', calls.length >= 1 && calls.every(c => c.args.some(a => /\/chart\/M44U\.SI\?/.test(a))) && !calls.some(c => c.args.some(a => /ntfy\.sh/.test(a))), `${calls.length} curl call(s)`);
    ctx.edit('news.json', n => { n.items[0].sources = []; });
    ctx.expect('validate-all (item without a source)', ctx.validateAll(), { exit: [1], problems: [/^news\.json: 1 item\(s\) cite no source at all/] });
  },
};
