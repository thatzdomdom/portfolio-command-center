/*
 * 11 — decision 4 of the redesign: balances never leave the Mac in the clear. encrypt-publish.js
 * FAILS CLOSED (exit 78, nothing written) without PCC_PASSPHRASE, and publish.js treats that as red
 * before the manifest and git steps — the alternative, falling back to plaintext, is the one outcome
 * the file exists to make impossible.
 */
module.exports = {
  name: '11-encrypt-fail-closed', incident: 'phase 1 — no passphrase must mean no publish, never a plaintext fallback', needsGreen: true,
  run(ctx) {
    ctx.writeEnv('EMAIL_TO=to@example.invalid\nEMAIL_FROM=from@example.invalid\n');
    const before = { book: ctx.mtime('book.enc'), val: ctx.mtime('valuation.enc'), man: ctx.text('manifest.json') };
    const e = ctx.run('encrypt-publish.js');
    ctx.expect('encrypt-publish.js alone', e, { exit: [78], stderrMatch: /PCC_PASSPHRASE missing or under 12 chars .* NOTHING written \(fail closed\)/ });
    const p = ctx.publish();
    ctx.expect('publish --dry-run without PCC_PASSPHRASE', p, { exit: [1], stdoutMatch: [/RED at encrypt-publish — NOT pushing/, /PCC_PASSPHRASE is not set — book\/valuation would be published in the clear\. Refusing\./] });
    ctx.check("ledger: dry-run row, step 'red at encrypt-publish'", p.lastRow && p.lastRow.status === 'dry-run' && p.lastRow.step === 'red at encrypt-publish', JSON.stringify(p.lastRow));
    ctx.check('no .enc envelope rewritten, manifest.json untouched', ctx.mtime('book.enc') === before.book && ctx.mtime('valuation.enc') === before.val && ctx.text('manifest.json') === before.man);
    ctx.check('no plaintext .plain file appeared', !ctx.text('book.json.plain'));
  },
};
