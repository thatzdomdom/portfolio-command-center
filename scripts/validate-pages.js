#!/usr/bin/env node
/*
 * validate-pages.js — the structure test for the three phase-5 pages (today.html, book.html,
 * inbox.html) and the pcc.css / common.js contract they are built on.
 *
 * Phase 5 of the 11 Sep 2026 redesign. Four rules on these pages fail SILENTLY — the page still
 * renders, so nobody finds out until the owner is reading it on a phone at 08:15:
 *
 *   zero external calls  A CDN font, an unpkg script or a stray off-origin fetch does not throw;
 *                        it just makes the reader's browser tell a third party which portfolio
 *                        page he opened, and it dies behind a captive portal. index.html's Yahoo
 *                        path is the thing the cutover exists to remove — the new pages must not
 *                        re-introduce it. Links OUT to sec.gov and the Pages origin are fine; a
 *                        fetch/script/style/font/image is not.
 *   email parity         today.html is the email's block order in HTML. When daily-brief.js grows
 *                        a section and today.html does not, the phone page quietly stops being the
 *                        same brief — the email is the contract, so the email is read, not guessed.
 *   404 on Pages         a page may only fetch data/* files publish.js actually publishes. A file
 *                        that exists on this Mac and not on origin renders as an empty block with
 *                        no error, which reads exactly like a quiet day.
 *   innerHTML with data  headlines come from EDGAR and from an LLM. Every figure and every string
 *                        reaches the DOM through PCC.el's `text` (textContent) or it does not go.
 *
 * The pages are written by other hands and in parallel: a file that is not there yet is a WARNING
 * ("not built yet"), never a crash and never a red pipeline.
 *
 *   node scripts/validate-pages.js              check the five phase-5 files
 *   node scripts/validate-pages.js <path…>      check exactly these files (the off-origin detector
 *                                               is testable against a fixture this way)
 * Exit 0 clean · 2 warnings only · 1 something is wrong enough to block. validate-all.js calls
 * validatePages() directly so the lines land in data/.validation.json with everything else.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

// ── the contracts ──────────────────────────────────────────────────────────
// Links OUT may point here and nowhere else (spec §hard constraint 2).
const ALLOW_HOSTS = new Set(['www.sec.gov', 'thatzdomdom.github.io']);
// XML namespaces are identifiers, not fetches: inline SVG cannot be written without this one.
const NAMESPACE_RE = /^https?:\/\/(www\.)?w3\.org\//i;

// today.html's block set and order (spec §C). blk-pipeline is exempt from the order test: when the
// pipeline is red the page moves that block to the TOP, so its position is a runtime decision.
const BLOCK_ORDER = ['blk-nav', 'blk-action', 'blk-risk', 'blk-changed', 'blk-movers', 'blk-news', 'blk-pipeline'];
const ORDER_EXEMPT = new Set(['blk-pipeline']);
// Blocks the email has no heading for. blk-movers is computed from closes.json, which the email
// does not carry; it is page-only by design, not a drifted section.
const PAGE_ONLY = new Set(['blk-movers']);
// EMAIL → BLOCK. The rule: match on the heading's LEADING WORDS, before any parenthetical or any
// ' + suffix' daily-brief.js appends at runtime. Every heading the email can push must appear here;
// an unmapped heading is a FAIL that says "add it", because the alternative is today.html silently
// dropping a section of the brief. One block may answer several headings (the email splits the
// action from the owner's replies; the page shows both inside blk-action).
const EMAIL_TO_BLOCK = [
  [/^THE ONE ACTION/, 'blk-action'],
  [/^YOUR REPLIES SINCE LAST BRIEF/, 'blk-action'],
  [/^VALUATION & LEVERAGE/, 'blk-nav'],
  [/^RISK STATE/, 'blk-risk'],
  [/^MACRO REGIME/, 'blk-risk'],
  [/^MACRO STANCES/, 'blk-risk'],
  [/^🔔 SIGNALS/, 'blk-changed'],
  [/^WHAT WAS UPDATED/, 'blk-changed'],
  [/^MODEL SIGNALS/, 'blk-changed'],
  [/^WATCHING/, 'blk-changed'],
  [/^LATEST INSIDER FILINGS ON YOUR NAMES/, 'blk-changed'],
  [/^NEWS THAT MATTERS TO YOUR BOOK/, 'blk-news'],
  [/^DATA-INTEGRITY CHECKS/, 'blk-pipeline'],
  [/^RESEARCH MISSING TODAY/, 'blk-pipeline'],
];
// PCC's three markup helpers: stampHTML is a date and a cadence word, spark/chart are SVG paths.
// None of them ever carries text from a file, so innerHTML is allowed for their whole return value.
const MARKUP_HELPER = /^\s*(?:PCC|P)\s*\.\s*(?:stampHTML|spark|chart)\s*\(/;
// Identifiers that mean "this came from a data file" for the innerHTML heuristic.
const DATA_IDENT = /\b(alerts?|headline|detail|holdings?|entries|entry|journal|oneaction|action|tldr|news|brief|valuation|book|movers?|closes|technicals|targets|manifest|signals?|watch|why|ask|items?|rows?|line|lines|name|ticker|text|msg|label|note|filing)\b/i;

const TARGETS = [
  { f: 'today.html', kind: 'html', today: true },
  { f: 'book.html', kind: 'html' },
  { f: 'inbox.html', kind: 'html' },
  { f: 'pcc.css', kind: 'css' },
  { f: 'common.js', kind: 'js' },
];

// ── helpers ────────────────────────────────────────────────────────────────
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const isAbs = u => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(String(u).trim());
function hostOf(u) { try { return new URL(String(u).trim(), 'https://same-origin.invalid').host.toLowerCase(); } catch (_) { return null; } }
const stripHtmlComments = t => t.replace(/<!--[\s\S]*?-->/g, '');
const stripScripts = t => t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const stripBlockComments = t => t.replace(/\/\*[\s\S]*?\*\//g, '');

// The seven constructs that MAKE a request, plus <a href> which merely links. Anything that makes
// a request is same-origin or it is a failure; a link may leave for the allow-listed hosts.
const CONSTRUCTS = [
  { kind: '<script src>', re: /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, linkOut: false },
  { kind: '<link href>', re: /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi, linkOut: false },
  { kind: '<img src>', re: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, linkOut: false },
  { kind: 'url()', re: /\burl\(\s*["']?([^"')\s]+)["']?\s*\)/gi, linkOut: false },
  { kind: 'fetch()', re: /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/g, linkOut: false },
  { kind: 'import()', re: /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g, linkOut: false },
  { kind: 'import from', re: /\bfrom\s*["'`]((?:[a-z][a-z0-9+.-]*:)?\/\/[^"'`]+)["'`]/gi, linkOut: false },
  { kind: '<a href>', re: /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi, linkOut: true },
];

/**
 * Every off-origin reference in one file's text.
 * Returns [{kind, url, host, line, severity:'fail'|'warn', why}] — empty when the file is clean.
 */
function scanOffOrigin(text) {
  const hits = [], seen = new Set();
  for (const c of CONSTRUCTS) {
    const re = new RegExp(c.re.source, c.re.flags);
    let m;
    while ((m = re.exec(text))) {
      const url = m[1];
      if (!isAbs(url)) continue;                                   // relative / data: / #ref — same document
      const host = hostOf(url);
      seen.add(m.index + m[0].indexOf(url));
      if (NAMESPACE_RE.test(url) && c.kind !== '<script src>') continue;   // xmlns, not a fetch
      if (c.linkOut && host && ALLOW_HOSTS.has(host)) continue;            // a link out, allowed
      hits.push({
        kind: c.kind, url: url.slice(0, 90), host, line: lineOf(text, m.index), severity: 'fail',
        why: c.linkOut ? `links to ${host} — only sec.gov and the Pages origin may be linked` : `${c.kind} points off-origin (${host}) — the browser makes ZERO external calls`,
      });
    }
  }
  // XHR has no literal to inspect: its URL is built at runtime, so no static scan can clear it.
  // Nothing on these pages needs it — common.js's loaders are fetch — so its presence is the finding.
  let x;
  const xre = /\bXMLHttpRequest\b/g;
  while ((x = xre.exec(text))) hits.push({ kind: 'XMLHttpRequest', url: 'XMLHttpRequest', host: null, line: lineOf(text, x.index), severity: 'fail', why: 'XMLHttpRequest builds its URL at runtime and cannot be cleared statically — load through PCC.load/PCC.priv (fetch, same-origin)' });
  // Catch-all: any other absolute URL left in the source. Prose in a header comment is the usual
  // reason ("no Yahoo, no CDN"), so this warns rather than failing.
  const ure = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<>]*/gi;
  let u;
  while ((u = ure.exec(text))) {
    if (seen.has(u.index)) continue;
    const host = hostOf(u[0]);
    if (!host || ALLOW_HOSTS.has(host) || NAMESPACE_RE.test(u[0])) continue;
    hits.push({ kind: 'absolute URL', url: u[0].slice(0, 90), host, line: lineOf(text, u.index), severity: 'warn', why: `absolute URL to ${host} in the source — fine in prose, a leak anywhere else` });
  }
  return hits;
}

/** The email's section headings, in the order daily-brief.js can emit them. Never edits the file. */
function emailSections(briefPath) {
  const src = fs.readFileSync(briefPath, 'utf8').split('\n');
  const out = [];
  let inLiteral = false;
  // Scan the WHOLE source, not line by line: daily-brief.js already writes multi-line
  // `sections.push([\n  'HEADING',` and a per-line regex cannot see those. Two lines can also each
  // carry a push, so these are global. Comments are stripped once, first.
  const whole = src.join('\n').replace(/^[ \t]*\/\/.*$/gm, '');
  const pushRe = /sections\s*\.\s*(?:push|unshift)\s*\(\s*\[\s*(['"`])([^'"`]{3,200})\1/g;
  const spliceRe = /sections\s*\.\s*splice\s*\([^)[\]]*?,\s*\[\s*(['"`])([^'"`]{3,200})\1/g;
  let mm;
  while ((mm = pushRe.exec(whole))) out.push(mm[2]);
  while ((mm = spliceRe.exec(whole))) out.push(mm[2]);
  for (const raw of src) {
    const ln = raw.trim();
    if (/^\/[/*]/.test(ln)) continue;                                  // a commented-out section is not a section
    if (/\bsections\s*=\s*\[/.test(ln)) inLiteral = true;
    const m = inLiteral ? /^\[\s*(['"`])([^'"`]{3,200})\1\s*,/.exec(ln) : null;
    if (m) out.push(m[2]);
    if (inLiteral && /^\]\s*;/.test(ln)) inLiteral = false;
  }
  // Normalise to the leading words: drop the runtime parenthetical and any trailing separator.
  const norm = h => h.replace(/\s*\(.*$/, '').replace(/\s*[·—-]\s*$/, '').trim();
  return [...new Set(out.map(norm))].filter(Boolean);
}

/** data/* files a page's source actually names (quoted strings only, comments stripped). */
function dataRefs(text) {
  const t = stripBlockComments(stripHtmlComments(text)), refs = new Set();
  let m;
  const direct = /["'`](data\/[A-Za-z0-9._\-]+)["'`]/g;
  while ((m = direct.exec(t))) refs.add(m[1]);
  const helper = /\b(?:PCC\s*\.\s*)?(load|priv)\s*\(\s*["'`]([A-Za-z0-9._\-]+)["'`]/g;
  while ((m = helper.exec(t))) refs.add('data/' + m[2] + (m[1] === 'priv' && !/\.enc$/.test(m[2]) ? '.enc' : ''));
  // loadAll(['brief.json','technicals.json', …]) — the form every page will actually use
  const bulk = /\b(?:PCC\s*\.\s*)?loadAll\s*\(\s*\[([^\]]*)\]/g;
  while ((m = bulk.exec(t))) { let q; const qre = /["'`]([A-Za-z0-9._\-]+)["'`]/g; while ((q = qre.exec(m[1]))) refs.add('data/' + q[1]); }
  return [...refs];
}

/** publish.js's ALLOW list, read without running it. Returns null if it cannot be read. */
function publishAllow(root) {
  root = root || ROOT;
  try { const p = require(path.join(root, 'scripts', 'publish.js')); if (Array.isArray(p.ALLOW)) return p.ALLOW; } catch (_) {}
  try {
    const src = fs.readFileSync(path.join(root, 'scripts', 'publish.js'), 'utf8');
    const m = /const\s+ALLOW\s*=\s*\[([\s\S]*?)\]\s*;/.exec(src);
    if (m) return m[1].split(',').map(s => (/['"]([^'"]+)['"]/.exec(s) || [])[1]).filter(Boolean);
  } catch (_) {}
  return null;
}

// ── the check ──────────────────────────────────────────────────────────────
/**
 * @param {{root?:string, files?:string[]}} opts  files = explicit paths (they must exist)
 * @returns {{problems:{file:string,msg:string}[], warnings:{file:string,msg:string}[], passed:string[]}}
 */
function validatePages(opts) {
  opts = opts || {};
  const root = opts.root || ROOT;
  const problems = [], warnings = [], passed = [];
  const fail = (file, msg) => problems.push({ file, msg });
  const warn = (file, msg) => warnings.push({ file, msg });
  const ok = msg => passed.push(msg);

  const targets = opts.files && opts.files.length
    ? opts.files.map(p => ({ f: p, abs: path.resolve(p), kind: /\.html?$/i.test(p) ? 'html' : /\.css$/i.test(p) ? 'css' : 'js', explicit: true, today: /today\.html$/i.test(p) }))
    : TARGETS.map(t => ({ ...t, abs: path.join(root, t.f) }));

  const ALLOW = publishAllow(root);
  if (!ALLOW) warn('publish.js', 'ALLOW list unreadable — the "will it 404 on Pages" check did not run');

  let emailHeads = null;
  try { emailHeads = emailSections(path.join(root, 'scripts', 'daily-brief.js')); }
  catch (e) { warn('daily-brief.js', `section headings unreadable (${String(e.message || e).slice(0, 60)}) — the email-parity check did not run`); }

  let checked = 0;
  for (const t of targets) {
    let text;
    try { text = fs.readFileSync(t.abs, 'utf8'); }
    catch (_) {
      if (t.explicit) fail(t.f, 'not found');
      else warn(t.f, 'not built yet — phase 5 has not created it; this page was not checked');
      continue;
    }
    checked++;
    const lines = text.split('\n').length;

    // 1. zero external calls
    const hits = scanOffOrigin(text);
    hits.filter(h => h.severity === 'fail').forEach(h => fail(t.f, `line ${h.line}: ${h.why} — ${h.url}`));
    hits.filter(h => h.severity === 'warn').forEach(h => warn(t.f, `line ${h.line}: ${h.why} — ${h.url}`));
    if (!hits.length) ok(`${t.f}: no off-origin fetch/script/style/font/image (${lines} lines)`);
    else if (!hits.some(h => h.severity === 'fail')) ok(`${t.f}: no off-origin REQUEST (${hits.length} absolute URL(s) in prose — see warnings)`);

    // 2. one id, one element (static markup only; runtime #pos-/#a- anchors cannot be counted here)
    if (t.kind === 'html') {
      const markup = stripScripts(stripHtmlComments(text));
      const seen = new Map();
      let m; const idre = /\bid\s*=\s*["']([^"']+)["']/g;
      while ((m = idre.exec(markup))) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
      const dups = [...seen].filter(([, n]) => n > 1);
      if (dups.length) dups.forEach(([id, n]) => fail(t.f, `duplicate id "${id}" appears ${n}× in the markup — deep links (#pos-…, #a-…) resolve to the first one only`));
      else if (seen.size) ok(`${t.f}: ${seen.size} element id(s), all unique`);

      if (lines > 900) warn(t.f, `${lines} lines — the house rule is one file under ~900; split or trim`);

      // 3. every big figure wears its as-of
      let b; const bigre = /class\s*[:=]\s*["'][^"']*\bbig\b[^"']*["']/g;
      let unstamped = 0;
      while ((b = bigre.exec(text))) {
        // `class:'big', text:'locked'` is a word, not a figure — only numbers need an as-of.
        const lit = /text\s*:\s*(['"`])([^'"`]*)\1/.exec(text.slice(b.index, b.index + 120));
        if (lit && !/\d/.test(lit[2])) continue;
        const win = text.slice(Math.max(0, b.index - 240), b.index + 600);
        if (!/stamp/i.test(win)) { unstamped++; warn(t.f, `line ${lineOf(text, b.index)}: class="big" figure with no stamp within ~600 chars — every number carries its as-of`); }
      }
      if (!unstamped && /\bbig\b/.test(text)) ok(`${t.f}: every class="big" figure has a stamp near it`);
    }

    // 4. data reaching the DOM through innerHTML
    let i; const ire = /(?:\.(?:inner|outer)HTML\s*\+?=\s*|\.insertAdjacentHTML\s*\([^,]*,\s*|document\.write(?:ln)?\s*\(|\bhtml\s*:\s*)/g;
    let risky = 0;
    while ((i = ire.exec(text))) {
      const at = i.index + i[0].length;
      // The right-hand side only, to the end of the statement (80 chars at most) — a trailing
      // comment is prose, not an assignment.
      const win = text.slice(at, at + 80).split(/[;\n]/)[0];
      // The three PCC helpers that return markup built from literals and an ISO date and contain no
      // text from a file (spec §B) are the sanctioned exception — but only when they are the WHOLE
      // right-hand side, so `P.spark(x) + a.headline` is still caught.
      if (MARKUP_HELPER.test(win) && !win.includes('+')) continue;
      if (DATA_IDENT.test(win)) { risky++; warn(t.f, `line ${lineOf(text, i.index)}: innerHTML assigned within 80 chars of a data identifier — data reaches the DOM through PCC.el's \`text\`, never innerHTML (headlines come from EDGAR and an LLM)`); }
    }
    if (!risky && /innerHTML/.test(text)) ok(`${t.f}: innerHTML used, none of it near a data identifier`);

    // 5. nothing it fetches can 404 on Pages
    if (ALLOW) {
      const refs = dataRefs(text);
      const bad = refs.filter(r => !/\.enc$/.test(r) && !ALLOW.includes(r));
      bad.forEach(r => fail(t.f, `fetches ${r}, which publish.js does not publish (ALLOW) — it will 404 on Pages and render as a quiet day`));
      if (refs.length && !bad.length) ok(`${t.f}: ${refs.length} data file(s) referenced, all published or .enc`);
      // The file itself has to reach origin too — a pcc.css that is never staged is a page with no
      // styles on Pages. inbox.html has always been committed by hand; say so rather than fail.
      if (!t.explicit && !ALLOW.includes(t.f)) warn(t.f, 'not in publish.js ALLOW — publish.js will not stage it, so edits reach Pages only by hand');
    }

    // 6. today.html is the email, in HTML
    if (t.today && emailHeads) {
      const markup = stripHtmlComments(text);
      const found = [];
      let s; const sre = /<section\b[^>]*\bid\s*=\s*["'](blk-[^"']+)["']/gi;
      while ((s = sre.exec(markup))) found.push(s[1]);
      if (!found.length) {
        if (markup.trim().length > 200) fail(t.f, 'no <section id="blk-…"> at all, in a file of ' + markup.trim().length + ' bytes — today.html is not the email any more');
        else warn(t.f, 'no <section id="blk-…"> found — the email-parity check has nothing to compare');
      }
      else {
        const unmapped = emailHeads.filter(h => !EMAIL_TO_BLOCK.some(([re]) => re.test(h)));
        unmapped.forEach(h => fail('validate-pages', `daily-brief.js emits a section "${h.slice(0, 60)}" that maps to no block — add it to EMAIL_TO_BLOCK in scripts/validate-pages.js and give today.html somewhere to put it`));
        const want = new Set();
        emailHeads.forEach(h => { const hit = EMAIL_TO_BLOCK.find(([re]) => re.test(h)); if (hit) want.add(hit[1]); });
        const have = new Set(found);
        [...want].filter(b => !have.has(b)).forEach(b => fail(t.f, `the email has a section that belongs in <section id="${b}"> and today.html has no such block — the phone page is no longer the same brief`));
        [...have].filter(b => !BLOCK_ORDER.includes(b)).forEach(b => fail(t.f, `unknown block id "${b}" — today.html's blocks are ${BLOCK_ORDER.join(', ')}`));
        const seq = found.filter(b => BLOCK_ORDER.includes(b) && !ORDER_EXEMPT.has(b));
        const wantSeq = BLOCK_ORDER.filter(b => seq.includes(b));
        if (seq.join('>') !== wantSeq.join('>')) fail(t.f, `block order is ${seq.join(' → ')} but the email's order is ${wantSeq.join(' → ')}`);
        else if (!problems.some(p => p.file === t.f)) ok(`today.html: ${found.length} blocks, matching the email's ${emailHeads.length} section heading(s) in order`);
        const extra = [...have].filter(b => !want.has(b) && BLOCK_ORDER.includes(b) && !PAGE_ONLY.has(b));
        if (extra.length) ok(`today.html: ${extra.join(', ')} present with no email section today (the email emits them conditionally)`);
      }
    }
  }
  if (!checked) warn('pages', 'none of the phase-5 files exist yet — nothing was checked');
  return { problems, warnings, passed };
}

module.exports = { validatePages, scanOffOrigin, emailSections, dataRefs, publishAllow, EMAIL_TO_BLOCK, BLOCK_ORDER, ALLOW_HOSTS };

if (require.main === module) {
  const files = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const r = validatePages({ root: ROOT, files });
  console.log(`validate-pages — ${today}\n`);
  r.passed.forEach(c => console.log('  ✓ ' + c));
  if (r.warnings.length) { console.log(''); r.warnings.forEach(w => console.log(`  ⚠ ${w.file}: ${w.msg}`)); }
  if (r.problems.length) { console.log(''); r.problems.forEach(p => console.log(`  ❌ ${p.file}: ${p.msg}`)); }
  console.log(`\n${r.passed.length} passed · ${r.warnings.length} warning(s) · ${r.problems.length} problem(s)`);
  process.exit(r.problems.length ? 1 : r.warnings.length ? 2 : 0);
}
