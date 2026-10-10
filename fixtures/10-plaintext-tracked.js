/*
 * 10 — book.json carries 13 cash balances, 3 property marks, a PE stake and the margin loan. Tracked
 * in the clear it is a public feed of the owner's finances at a stable URL. Two guards, tested
 * separately: (a) validate-all's PLAINTEXT line → publish --dry-run red at validate-all; (b) with
 * validate-all neutralised (exit 2), publish.js's OWN git guard must still refuse to push (full run
 * against the bare temp origin, which must stay unchanged).
 */
const fs = require('fs'), path = require('path');
module.exports = {
  name: '10-plaintext-tracked', incident: 'phase 1 — a plaintext balance file committed by mistake',
  run(ctx) {
    ctx.git('add', '-f', 'data/book.json'); const c = ctx.git('commit', '-q', '-m', 'oops: plaintext book');
    ctx.check('precondition: data/book.json committed in the sandbox repo', c.exit === 0 && ctx.git('ls-files', '--', 'data/book.json').stdout.trim() === 'data/book.json', c.out);
    ctx.expect('validate-all', ctx.validateAll(), { exit: [1], problems: [/^git: sensitive PLAINTEXT is tracked: data\/book\.json — must be gitignored; only \.enc envelopes may be committed/] });
    const p = ctx.publish();
    ctx.expect('publish --dry-run', p, { exit: [1], stdoutMatch: /RED at validate-all — NOT pushing/ });
    ctx.check("ledger: dry-run row, step 'red at validate-all'", p.lastRow && p.lastRow.status === 'dry-run' && p.lastRow.step === 'red at validate-all', JSON.stringify(p.lastRow));
    fs.writeFileSync(path.join(ctx.root, 'scripts', 'validate-all.js'), '// fixture 10b: validator neutralised — publish.js must refuse on its own\nprocess.exit(2);\n');
    const head = ctx.originHead(), f = ctx.publish({ full: true });
    ctx.expect('publish (full, validate-all neutralised)', f, { exit: [1], stdoutMatch: [/RED at git guard — NOT pushing/, /plaintext sensitive file\(s\) are TRACKED: data\/book\.json/] });
    ctx.check('origin main unchanged', ctx.originHead() === head, `${head.slice(0, 8)} → ${ctx.originHead().slice(0, 8)}`);
    ctx.check("ledger: red row {step:'git guard', validateAllExit:2}", f.lastRow && f.lastRow.status === 'red' && f.lastRow.step === 'git guard' && f.lastRow.validateAllExit === 2, JSON.stringify(f.lastRow));
    ctx.check('no ntfy call from the sandbox (no NTFY_TOPIC in its env)', !ctx.stubLog().some(x => x.args.some(a => /ntfy\.sh/.test(a))));
  },
};
