/*
 * 15 — 5 Aug 2026. The one time validation caught a real problem, the alarm about it could not be
 * sent: an inline `node -e` inside "$( )" had its nested double quotes mangled by the shell
 * (`tryconst r=require` + "curl: blank argument"). research-headless.sh now reads the problems
 * through a FILE. This runs that exact block, extracted from the script's text (never a copy that
 * could drift), against a report whose problem strings carry double quotes and a backtick, with
 * NTFY_TOPIC set in the sandbox env so the alarm reaches the curl STUB — the only fixture in which a
 * call to ntfy.sh is expected.
 */
const fs = require('fs'), path = require('path');
module.exports = {
  name: '15-alert-quoting', incident: '5 Aug 2026 — the validation alarm was lost to shell quoting the one time it mattered',
  run(ctx) {
    const sh = fs.readFileSync(path.join(ctx.root, 'scripts', 'research-headless.sh'), 'utf8');
    const m = /if \[ "\$VC" = "1" \]; then\n([\s\S]*?)\nelse\n/.exec(sh);
    if (!ctx.check('found the `if [ "$VC" = "1" ]` alarm block in research-headless.sh', !!m)) return;
    ctx.check('the block reads the report through a file, not an inline string', /node -e '[\s\S]*require\(process\.argv\[1\]\)[\s\S]*' "\$PWD\/data\/\.validation\.json"/.test(m[1]));
    const problems = ['brief.json: regime label "a hot `PPI` print" differs from model.json\'s "cool"', 'news.json: 2 item(s) cite no source at all',
      'prices: brief.tldr[0] asserts D05.SI at 63, which matches no traded close/high/low (recent closes: 76.79, 77)', "track.json: PAST snapshot(s) altered: 2026-09-01 — the model's hit rate is computed off these", 'a fifth problem that must NOT be sent'];
    ctx.write('.validation.json', { checkedOn: ctx.today, at: new Date().toISOString(), problems, warnings: [], passed: [] });
    ctx.writeEnv('PCC_PASSPHRASE=fixture-passphrase-0123456789\nEMAIL_TO=to@example.invalid\nEMAIL_FROM=from@example.invalid\nNTFY_TOPIC=fixture-topic-15\n');
    const r = ctx.sh(`VC=1\n${m[1]}\nprintf 'PROB=%s\\n' "$PROB"\n`);
    const expected = problems.slice(0, 4).join(' | '), got = (/^PROB=(.*)$/m.exec(r.stdout) || [])[1];
    ctx.check('block ran (exit 0)', r.exit === 0, r.out.slice(-200));
    ctx.check('PROB = the first four problems joined by " | ", double quotes and the backtick intact', got === expected, `got: ${got}`);
    const calls = ctx.stubLog().filter(c => c.tool === 'curl'), hit = calls.find(c => c.args.includes('https://ntfy.sh/fixture-topic-15'));
    ctx.check('exactly one curl call, to the topic from the sandbox env', calls.length === 1 && !!hit, `${calls.length} curl call(s): ${calls.map(c => c.args.slice(-1)[0]).join(', ')}`);
    ctx.check('the alarm body reached curl as ONE -d argument, verbatim', hit && hit.args[hit.args.indexOf('-d') + 1] === expected, hit ? JSON.stringify(hit.args) : 'no call');
    ctx.check('Title/Priority/Tags headers present', hit && hit.args.includes('Title: Portfolio: data validation failed') && hit.args.includes('Priority: high') && hit.args.includes('Tags: warning'));
  },
};
