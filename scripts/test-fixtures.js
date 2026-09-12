#!/usr/bin/env node
/*
 * test-fixtures.js — every failure this pipeline has actually had, replayed against the real code
 * in a throwaway copy, on demand.
 *
 * Phase 4 of the 11 Sep 2026 redesign. Seven incidents — 6 Jul fabricated price, 5 Aug stale brief
 * re-sent, 8–21 Aug dead credential, 17 Aug Monday date drift, 18 Aug 13F stamp, Aug/Sep vendor
 * prices, 8–11 Sep dead feed — each got a guard written AFTER the owner had already read the bad
 * number, and nothing since has proved the guards still fire after the next edit. This file does:
 * each fixtures/NN-*.js mutates a fresh copy of the repo the way the incident did and asserts the
 * SPECIFIC problems[]/passed[]/warnings[] lines the guard must produce — never an exit code alone,
 * because a red run for the wrong reason is not a passing test. The phase-4 write path (one-action,
 * reply grammar, ledger, cutover clock, crash wraps, the send stamp) is covered the same way.
 *
 * Sandbox, per fixture — nothing here can reach the live repo, Mail, ntfy, Yahoo or origin:
 *   <tmp>/<fixture>/root   copy of scripts/ (journal.dev.js also copied as journal.js), common.js,
 *                          index.html, data/ (REAL data, copied never symlinked), .gitignore;
 *                          `git init -q -b main`, one commit honouring .gitignore, a bare origin.git
 *                          pushed to — so publish.js can run FULL against it (fixtures 10b, 14)
 *   <tmp>/<fixture>/home   HOME: a dummy ~/.claude/portfolio-brief.env (passphrase, addresses,
 *                          NO NTFY_TOPIC) and the fixture's Library/Logs/portfolio-research.log
 *   <tmp>/<fixture>/stub   FIRST on PATH for every step: `curl` (exit 22 → validate-intel fails OPEN
 *                          as UNCHECKED, or a canned body keyed by URL substring) and `gh` ('Logged
 *                          in'); every invocation is appended to <tmp>/<fixture>/stub.log
 *   env                    HOME, PATH, the GIT_AUTHOR_ and GIT_COMMITTER_ identity (this Mac has no
 *                          global git identity), GIT_CONFIG_GLOBAL=/dev/null, TZ and NODE_OPTIONS
 *                          unset. NO Date shim: fixtures compute expectations from the real clock.
 * Every copy is normalised first (brief.json dated today, manifest.sgtDate today — the real files are
 * yesterday's for ~23 h of every day) and 00-baseline runs validate-all on it; if that is red, the
 * fixtures that need a green baseline are SKIPPED, not failed, and BASELINE RED: <problems> is printed.
 *
 * Usage:  node scripts/test-fixtures.js [name…] [--keep] [--verbose] [--overlay <dir>]
 *   name        substring filter on fixture names (00-baseline always runs)
 *   --keep      leave <tmp> in place and print its path (inspect HOME/PATH/git/stub.log by hand)
 *   --verbose   print every check, not only the failed ones
 *   --overlay   copy <dir> over each sandbox root after the repo copy (try an unmerged script)
 * Exit 1 on any FAIL, a red baseline, or a curl call to ntfy.sh outside 15-alert-quoting.
 * KNOWN GAP rows document blind spots a fixture proves are still open (fixture 08); never a failure.
 *
 * Fixture module contract (fixtures/README.md has the full list):
 *   { name, incident, needsGreen?, requires?: [repo-relative files → SKIPPED (missing) if absent],
 *     log?: string | today => string, curlResponse?: { '<url substring>': body }, run(ctx) }
 */
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const REPO = path.join(__dirname, '..'), FIXTURES = path.join(REPO, 'fixtures');
const argv = process.argv.slice(2), KEEP = argv.includes('--keep'), VERBOSE = argv.includes('--verbose');
const OVERLAY = argv.includes('--overlay') ? path.resolve(argv[argv.indexOf('--overlay') + 1] || '') : null;
const filter = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--overlay');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const die = m => { console.error(`test-fixtures: ${m}`); process.exit(1); };
const US = '';   // field separator in stub.log (written by the stubs as printf '\037')
const tail = s => String(s || '').trim().split('\n').slice(-3).join(' / ').slice(0, 240);

const ENV_FILE = 'PCC_PASSPHRASE=fixture-passphrase-0123456789\nEMAIL_TO=to@example.invalid\nEMAIL_FROM=from@example.invalid\n';
const DEFAULT_LOG = d => `=== ${d} 07:02:00 research start ===\n${d} 07:02:03 auth: long-lived token present\n=== ${d} 07:45:00 research end (exit 0) ===\n`;

// ── sandbox ────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-fixtures-'));
fs.chmodSync(TMP, 0o700);
process.on('exit', () => { if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} } });

function copyRepo(root) {
  for (const f of ['scripts', 'common.js', 'index.html', 'data', '.gitignore']) fs.cpSync(path.join(REPO, f), path.join(root, f), { recursive: true });
  const dev = path.join(root, 'scripts', 'journal.dev.js');   // daily-brief's spawn target; never spawned under --dry-run
  if (fs.existsSync(dev)) fs.copyFileSync(dev, path.join(root, 'scripts', 'journal.js'));
  if (OVERLAY) fs.cpSync(OVERLAY, root, { recursive: true });
}
// The real brief.json and manifest.json are yesterday's until 07:25; a fixture must start green.
function normalise(root) {
  const J = f => JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8'));
  const W = (f, o) => fs.writeFileSync(path.join(root, 'data', f), JSON.stringify(o, null, 2) + '\n');
  try { const b = J('brief.json'); b.date = today + String(b.date || '').slice(10); W('brief.json', b); } catch (_) {}
  try { const m = J('manifest.json'); m.sgtDate = today; W('manifest.json', m); } catch (_) {}
}
function writeStubs(sb, fx) {
  const logLine = tool => `{ printf '%s' '${tool}'; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> "${sb.log}"`;
  const cases = Object.entries(fx.curlResponse || {}).map(([k, v], i) => {
    const f = path.join(sb.stub, `curl-${i}.body`); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
    return `  *"${k}"*) cat "${f}"; exit 0;;`;
  });
  fs.writeFileSync(path.join(sb.stub, 'curl'), `#!/bin/sh\n# fixture stub — never touches the network. exit 22 = curl's "HTTP error" (validate-intel fails OPEN: UNCHECKED)\n${logLine('curl')}\ncase "$*" in\n${cases.join('\n')}\nesac\nexit 22\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(sb.stub, 'gh'), `#!/bin/sh\n# fixture stub for credentials.js\n${logLine('gh')}\necho 'Logged in to github.com (fixture stub)'\n`, { mode: 0o755 });
}
function makeEnv(sb) {
  const env = { ...process.env };
  delete env.TZ; delete env.NODE_OPTIONS;
  env.HOME = sb.home;
  env.PATH = sb.stub + ':' + path.dirname(process.execPath) + ':' + (process.env.PATH || '');
  Object.assign(env, { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  return env;
}
function gitSetup(sb) {
  const g = (...a) => { const r = spawnSync('git', a, { cwd: sb.root, env: sb.env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`); return r.stdout; };
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-q', '-m', 'fixture baseline (copy of the real tree, .gitignore honoured)');
  g('init', '-q', '--bare', '-b', 'main', sb.origin); g('remote', 'add', 'origin', sb.origin); g('push', '-q', '-u', 'origin', 'main');
}
function makeSandbox(fx) {
  const dir = path.join(TMP, fx.name);
  const sb = { dir, root: path.join(dir, 'root'), home: path.join(dir, 'home'), stub: path.join(dir, 'stub'), origin: path.join(dir, 'origin.git'), log: path.join(dir, 'stub.log') };
  for (const d of [sb.root, path.join(sb.home, '.claude'), path.join(sb.home, 'Library', 'Logs'), sb.stub]) fs.mkdirSync(d, { recursive: true });
  copyRepo(sb.root); normalise(sb.root);
  fs.writeFileSync(path.join(sb.home, '.claude', 'portfolio-brief.env'), ENV_FILE, { mode: 0o600 });
  fs.writeFileSync(path.join(sb.home, 'Library', 'Logs', 'portfolio-research.log'), typeof fx.log === 'function' ? fx.log(today) : (fx.log || DEFAULT_LOG(today)));
  fs.writeFileSync(sb.log, '');
  writeStubs(sb, fx);
  sb.env = makeEnv(sb);
  gitSetup(sb);
  return sb;
}
function parseStubLog(file) {
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const recs = [];   // one record per line; an argument containing a newline continues the previous record
  txt.split('\n').forEach(l => { if (/^(curl|gh)(|$)/.test(l)) recs.push(l); else if (recs.length && l) recs[recs.length - 1] += '\n' + l; });
  return recs.map(l => { const a = l.split(US); return { tool: a[0], args: a.slice(1) }; });
}

// ── the ctx handed to run(ctx) ─────────────────────────────────────────────
function makeCtx(fx, sb) {
  const checks = [], gaps = [];
  const P = f => path.join(sb.root, 'data', f);
  const exec = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { cwd: sb.root, env: { ...sb.env, ...(opts.env || {}) }, encoding: 'utf8', timeout: opts.timeout || 180000, input: opts.input });
    return { exit: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stdout || '') + (r.stderr || '') };
  };
  const check = (label, ok, detail) => { checks.push({ label, ok: !!ok, detail: detail == null ? '' : String(detail).slice(0, 320) }); return !!ok; };
  // expect(label, result, spec): each key of spec is its own check, so the table says WHICH line went missing
  function expect(label, r, spec) {
    const rep = r.report || {}, L = { problems: rep.problems || [], warnings: rep.warnings || [], passed: rep.passed || [] };
    if (spec.exit) check(`${label}: exit ∈ {${spec.exit.join(',')}}`, spec.exit.includes(r.exit), `exit ${r.exit}${r.signal ? ' ' + r.signal : ''} · ${tail(r.out)}`);
    for (const [k, txt] of [['stdoutMatch', r.stdout], ['stderrMatch', r.stderr], ['outMatch', r.out]])
      [].concat(spec[k] || []).forEach(re => check(`${label}: ${k} ${re}`, re.test(txt), tail(txt)));
    for (const k of ['problems', 'warnings', 'passed']) {
      [].concat(spec[k] || []).forEach(re => check(`${label}: ${k}[] has ${re}`, L[k].some(l => re.test(l)), L[k].join(' ‖ ') || '(none)'));
      [].concat(spec['not' + k[0].toUpperCase() + k.slice(1)] || []).forEach(re => check(`${label}: ${k}[] lacks ${re}`, !L[k].some(l => re.test(l)), L[k].filter(l => re.test(l)).join(' ‖ ')));
    }
    if (spec.noProblems) check(`${label}: problems[] empty`, !L.problems.length, L.problems.join(' ‖ '));
    return r;
  }
  const ctx = {
    name: fx.name, root: sb.root, home: sb.home, stub: sb.stub, origin: sb.origin, env: sb.env, today, addDays, note: '',
    daysAgo: n => addDays(today, -n),
    read: f => { try { return JSON.parse(fs.readFileSync(P(f), 'utf8')); } catch (_) { return null; } },
    write: (f, o) => fs.writeFileSync(P(f), typeof o === 'string' ? o : JSON.stringify(o, null, 1) + '\n'),
    // fn mutates in place; a returned OBJECT replaces the file (a returned number/undefined — e.g. from arr.push — does not)
    edit: (f, fn) => { const o = ctx.read(f); if (!o) throw new Error(`edit: data/${f} missing or unparseable`); const r = fn(o); ctx.write(f, r && typeof r === 'object' ? r : o); },
    text: f => { try { return fs.readFileSync(P(f), 'utf8'); } catch (_) { return null; } },
    mtime: f => { try { return fs.statSync(P(f)).mtimeMs; } catch (_) { return null; } },
    rm: f => fs.rmSync(P(f), { force: true }),
    ndjson: (f, rows) => fs.writeFileSync(P(f), rows.map(r => JSON.stringify(r)).join('\n') + '\n'),
    readNdjson: f => (ctx.text(f) || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean),
    resetData: () => { fs.rmSync(path.join(sb.root, 'data'), { recursive: true, force: true }); fs.cpSync(path.join(REPO, 'data'), path.join(sb.root, 'data'), { recursive: true }); normalise(sb.root); },
    writeEnv: text => fs.writeFileSync(path.join(sb.home, '.claude', 'portfolio-brief.env'), text, { mode: 0o600 }),
    writeLog: text => fs.writeFileSync(path.join(sb.home, 'Library', 'Logs', 'portfolio-research.log'), text),
    removeLog: () => fs.rmSync(path.join(sb.home, 'Library', 'Logs', 'portfolio-research.log'), { force: true }),
    run: (script, args = [], opts) => exec(process.execPath, [path.join(sb.root, 'scripts', script), ...args], opts),
    sh: (cmd, opts) => exec('bash', ['-c', cmd], opts),
    git: (...a) => exec('git', a),
    originHead: () => (exec('git', ['--git-dir', sb.origin, 'rev-parse', 'main']).stdout || '').trim(),
    originFiles: () => (exec('git', ['--git-dir', sb.origin, 'ls-tree', '-r', '--name-only', 'main']).stdout || '').split('\n').filter(Boolean),
    stubLog: () => parseStubLog(sb.log),
    check, expect,
    gap: (id, text, observed) => gaps.push({ id, text, observed }),
    validateAll(label = 'validate-all') {
      const before = ctx.read('.validation.json'), r = ctx.run('validate-all.js');
      r.report = ctx.read('.validation.json');
      check(`${label}: .validation.json written this run, checkedOn ${today}`, r.report && r.report.checkedOn === today && (!before || r.report.at > before.at), r.report ? `checkedOn ${r.report.checkedOn} at ${r.report.at}` : 'no report');
      return r;
    },
    publish(o = {}) { const r = ctx.run('publish.js', o.full ? [] : ['--dry-run']); r.ledger = ctx.readNdjson('.publish-history.ndjson'); r.lastRow = r.ledger[r.ledger.length - 1] || null; return r; },
    dailyBrief(label = 'daily-brief --dry-run') {
      const r = ctx.run('daily-brief.js', ['--dry-run']), L = r.stdout.split('\n');
      check(`${label}: stdout line 1 is SUBJECT:, line 2 the EMAIL banner`, /^SUBJECT: /.test(L[0] || '') && L[1] === '===== EMAIL =====', L.slice(0, 2).join(' / ') || tail(r.stderr));
      r.subject = (L[0] || '').replace(/^SUBJECT: /, ''); return r;
    },
    oneAction(label = 'one-action --dry-run') { const r = ctx.run('one-action.js', ['--dry-run']); try { r.json = JSON.parse(r.stdout); } catch (_) { r.json = null; } check(`${label}: exit 0 and prints the JSON`, r.exit === 0 && !!r.json, tail(r.out)); return r; },
    cutover(args = []) { const r = ctx.run('cutover-check.js', args); r.json = ctx.read('.cutover.json'); return r; },
  };
  return { ctx, checks, gaps };
}

// ── runner ─────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(FIXTURES)) die('fixtures/ directory missing');
  const fixtures = fs.readdirSync(FIXTURES).filter(f => /^\d\d-.*\.js$/.test(f)).sort().map(f => {
    const m = require(path.join(FIXTURES, f));
    if (!m.name || typeof m.run !== 'function') die(`fixtures/${f}: module needs { name, run(ctx) }`);
    if (m.name !== f.replace(/\.js$/, '')) die(`fixtures/${f}: name "${m.name}" must equal the file name`);
    return m;
  });
  const selected = fixtures.filter(x => x.name === '00-baseline' || !filter.length || filter.some(s => x.name.includes(s)));
  if (selected.length < 2 && filter.length) die(`no fixture matches "${filter.join(' ')}"`);
  console.log(`test-fixtures — ${today} · ${selected.length} fixture(s) · sandbox ${TMP}${KEEP ? ' (kept)' : ''}\n`);
  let baselineGreen = null; const results = [];
  for (const fx of selected) {
    const t0 = Date.now(), res = { name: fx.name, status: 'PASS', checks: [], gaps: [], note: '', ms: 0, net: [] };
    if (fx.needsGreen && baselineGreen === false) { res.status = 'SKIPPED'; res.note = 'needs a green baseline'; results.push(res); continue; }
    let sb;
    try { sb = makeSandbox(fx); } catch (e) { res.status = 'FAIL'; res.note = `sandbox: ${e.message}`; results.push(res); continue; }
    const missing = (fx.requires || []).filter(f => !fs.existsSync(path.join(sb.root, f)));
    if (missing.length) { res.status = 'SKIPPED'; res.note = `missing ${missing.join(', ')}`; results.push(res); continue; }
    const { ctx, checks, gaps } = makeCtx(fx, sb);
    try { await fx.run(ctx); } catch (e) { checks.push({ label: 'run() threw', ok: false, detail: String(e && e.stack || e).split('\n').slice(0, 3).join(' | ').slice(0, 320) }); }
    Object.assign(res, { checks, gaps, note: ctx.note, ms: Date.now() - t0, net: ctx.stubLog() });
    res.status = checks.some(c => !c.ok) ? 'FAIL' : 'PASS';
    if (fx.name === '00-baseline') { baselineGreen = res.status === 'PASS'; res.status = baselineGreen ? 'GREEN' : 'RED'; }
    results.push(res);
    process.stdout.write(`  ${res.status.padEnd(7)} ${fx.name}${res.note ? ' — ' + res.note : ''}\n`);
  }

  // ── report ───────────────────────────────────────────────────────────────
  const w = Math.max(...results.map(r => r.name.length)) + 2;
  console.log(`\n${'fixture'.padEnd(w)}${'status'.padEnd(9)}${'checks'.padEnd(8)}${'ms'.padStart(6)}  note`);
  for (const r of results) {
    const n = r.checks.length, ok = r.checks.filter(c => c.ok).length;
    console.log(`${r.name.padEnd(w)}${r.status.padEnd(9)}${(n ? `${ok}/${n}` : '-').padEnd(8)}${String(r.ms || '-').padStart(6)}  ${r.note}`);
  }
  for (const r of results) for (const g of r.gaps) console.log(`KNOWN GAP  ${r.name} · ${g.id}: ${g.text} — ${g.observed}`);
  const shown = results.filter(r => VERBOSE ? r.checks.length : r.checks.some(c => !c.ok));
  for (const r of shown) {
    console.log(`\n${r.name}`);
    r.checks.filter(c => VERBOSE || !c.ok).forEach(c => console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail && (!c.ok || VERBOSE) ? `\n      ${c.detail.replace(/\n/g, '\n      ')}` : ''}`));
  }
  // network: every curl/gh call went to the stub; ntfy.sh is legitimate only where the fixture tests the alarm path
  const curl = results.flatMap(r => r.net.filter(c => c.tool === 'curl').map(c => ({ fx: r.name, args: c.args })));
  const gh = results.reduce((n, r) => n + r.net.filter(c => c.tool === 'gh').length, 0);
  const ntfy = curl.filter(c => c.args.some(a => /ntfy\.sh/.test(a)));
  const badNtfy = ntfy.filter(c => c.fx !== '15-alert-quoting');
  console.log(`\nnetwork: ${curl.length} curl call(s) and ${gh} gh call(s), every one answered by the stub · ${ntfy.length} to ntfy.sh (${ntfy.map(c => c.fx).join(', ') || 'none'})${badNtfy.length ? ' · UNEXPECTED ntfy call — see above' : ''}`);
  badNtfy.forEach(c => console.log(`  UNEXPECTED ntfy call in ${c.fx}: ${c.args.join(' ').slice(0, 200)}`));
  const failed = results.filter(r => r.status === 'FAIL' || r.status === 'RED');
  console.log(`${results.length} fixture(s) · ${results.filter(r => r.status === 'PASS' || r.status === 'GREEN').length} passed · ${failed.length} failed · ${results.filter(r => r.status === 'SKIPPED').length} skipped${KEEP ? `\nkept: ${TMP}` : ''}`);
  process.exit(failed.length || badNtfy.length ? 1 : 0);
}
main().catch(e => die(e.stack || e));
