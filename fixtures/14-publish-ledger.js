/*
 * 14 — the publish ledger the cutover clock reads. A FULL publish against the bare temp origin must
 * append a green row and push only the allow-list (no plaintext private file in the pushed tree);
 * a red run (brief −1) must append a red row, leave origin untouched and NOT rewrite manifest.json
 * (publish.js exits at validate-all, before step 5); a later --dry-run records 'dry-run', never a
 * day status. Rows carry the whitelisted fields only — never detail or output.
 */
module.exports = {
  name: '14-publish-ledger', incident: 'phase 4 — no green/red record existed, so the seven-clean-day clock had nothing to read', needsGreen: true,
  run(ctx) {
    const LEAK = /data\/(book|valuation|journal|oneaction)\.json$|data\/journal\.ndjson$|data\/\.(oneaction-history|state-history|publish-history)\.ndjson$|data\/\.(tickers|cutover|credentials)\.json$|data\/\.last-brief-(at|date)$|\.prices-2y/;
    const encs = ['book.json', 'valuation.json', 'oneaction.json', 'journal.json'].filter(f => ctx.text(f) !== null).map(f => 'data/' + f.replace(/\.json$/, '.enc'));
    const head0 = ctx.originHead(), n0 = ctx.readNdjson('.publish-history.ndjson').length;
    const g = ctx.publish({ full: true });
    ctx.expect('publish (full, green)', g, { exit: [0], stdoutMatch: [/validate-all: (clean|warnings only)/, /encrypt-publish: ok/, /manifest: ok/, /pushed \d+ file\(s\) · ## main\.\.\.origin\/main$/m] });
    const head1 = ctx.originHead(), files = ctx.originFiles();
    ctx.check('origin main advanced by the publish commit', head1 && head1 !== head0, `${head0.slice(0, 8)} → ${head1.slice(0, 8)}`);
    const msg = ctx.git('--git-dir', ctx.origin, 'log', '-1', '--format=%s', 'main').stdout.trim();
    ctx.check(`commit subject is "Publish ${ctx.today}"`, msg === `Publish ${ctx.today}`, msg);
    ctx.check('pushed tree carries no plaintext private file', files.length > 0 && !files.some(f => LEAK.test(f)), files.filter(f => LEAK.test(f)).join(', ') || `${files.length} files`);
    ctx.check(`pushed tree carries the envelopes (${encs.join(', ')})`, encs.every(f => files.includes(f)), files.filter(f => /\.enc$/.test(f)).join(', '));
    const row = g.lastRow;
    ctx.check("ledger: green row {status:'green', step:'pushed', validateAllExit 0|2, staged ≥ 1, date today}", row && row.status === 'green' && row.step === 'pushed' && [0, 2].includes(row.validateAllExit) && row.staged >= 1 && row.date === ctx.today && g.ledger.length === n0 + 1, JSON.stringify(row));
    ctx.check('ledger: row carries only the whitelisted fields', row && Object.keys(row).sort().join(',') === 'at,date,staged,status,step,validateAllExit', row && Object.keys(row).join(','));
    const man = ctx.text('manifest.json'), manAt = ctx.mtime('manifest.json');
    ctx.edit('brief.json', b => { b.date = ctx.daysAgo(1) + String(b.date).slice(10); });
    const r = ctx.publish({ full: true });
    ctx.expect('publish (full, brief −1)', r, { exit: [1], stdoutMatch: /RED at validate-all — NOT pushing/ });
    ctx.check("ledger: red row appended {status:'red', step:'validate-all', validateAllExit:1}", r.lastRow && r.lastRow.status === 'red' && r.lastRow.step === 'validate-all' && r.lastRow.validateAllExit === 1 && r.ledger.length === n0 + 2, JSON.stringify(r.lastRow));
    ctx.check('origin unchanged after the red run', ctx.originHead() === head1);
    ctx.check('manifest.json not rewritten by the red run', ctx.text('manifest.json') === man && ctx.mtime('manifest.json') === manAt);
    ctx.check('no ntfy call from the sandbox', !ctx.stubLog().some(x => x.args.some(a => /ntfy\.sh/.test(a))));
    const d = ctx.publish();
    ctx.check("a later --dry-run records status 'dry-run' (never a day status)", d.lastRow && d.lastRow.status === 'dry-run' && d.ledger.length === n0 + 3, JSON.stringify(d.lastRow));
    ctx.check('cutover-check reads the day as red (last non-dry row wins)', (() => { const c = ctx.cutover(['--dry-run']); return c.exit === 0 && new RegExp(`last publish: ${ctx.today} red at validate-all`).test(c.stdout); })());
  },
};
