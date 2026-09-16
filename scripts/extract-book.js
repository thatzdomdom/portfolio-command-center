#!/usr/bin/env node
/*
 * extract-book.js — pull the holdings array OUT of index.html into data/book.json.
 *
 * Phase 1 of the 11 Sep 2026 redesign. For two months the book lived as a JS array inside a
 * 2,800-line HTML file, with cash balances, property marks and the margin loan as bare numbers
 * with no date and no source. This makes book.json the machine-readable source of truth.
 *
 * DURING THE PARALLEL WEEK index.html keeps its own copy and keeps rendering from it; validate-all
 * fails if the two ever disagree, so they cannot silently drift. At phase 4 cutover the HTML copy
 * is deleted and every page reads book.json (encrypted at publish — see encrypt-publish.js).
 *
 * MANUAL MARKS get an as-of date from `git blame` on their own line — the last time that number
 * was actually changed — not from today. A property mark last touched in June is a June mark, and
 * the valuation layer will colour it amber at 90 days. Writing today's date would hide exactly the
 * staleness this file exists to expose.
 */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'data', 'book.json');
const src = fs.readFileSync(HTML, 'utf8');
const lines = src.split('\n');

// Every holding is a one-line object literal `{id:N, ...}` inside the H array.
const rows = [];
lines.forEach((ln, i) => {
  const m = /^\s*\{id:\s*(\d+)\s*,.*\}\s*,?\s*(\/\/.*)?$/.exec(ln);
  if (!m) return;
  const lit = ln.trim().replace(/,\s*(\/\/.*)?$/, '').replace(/\/\/.*$/, '');
  let obj;
  try { obj = new Function('return ' + lit)(); } catch (e) { throw new Error(`line ${i + 1}: cannot parse holding: ${e.message}`); }
  rows.push({ obj, line: i + 1 });
});
if (rows.length !== 59) throw new Error(`expected 59 holdings, parsed ${rows.length}`);

// git blame → author date of the last change to that line (the honest as-of for a manual mark)
function blameDate(lineNo) {
  try {
    const out = execSync(`git blame -L ${lineNo},${lineNo} --porcelain -- index.html`, { cwd: ROOT, encoding: 'utf8' });
    const t = /author-time (\d+)/.exec(out);
    return t ? new Date(+t[1] * 1000).toISOString().slice(0, 10) : null;
  } catch (_) { return null; }
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
// Phase 4 (12 Sep 2026): CARRY FORWARD what a re-extract must not reset. The previous book.json's
// ibkr block (maintenance/loan rate, their asOf and source — hand-confirmed values would otherwise
// snap back to ASSUMED-today), and any manual mark that edit-book.js / an email LOAN reply stamped
// (its asOf is the edit date, more honest than git blame on an uncommitted line).
const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { return null; } })();
const prevMark = id => { const p = prev && (prev.holdings || []).find(x => x.id === id); return p && p.mark ? p.mark : null; };
const holdings = rows.map(({ obj: h, line }) => {
  const base = { id: h.id, n: h.n, t: h.t, yf: h.yf ?? null, ac: h.ac, region: h.region, cur: h.cur };
  if (h.yf) return { ...base, qty: h.qty, book: h.book ?? null, valued: 'live' };
  const pm = prevMark(h.id);
  if (pm && pm.value === h.manualNative && /^(edit-book|email reply)/.test(String(pm.source || ''))) {
    return { ...base, manualNative: h.manualNative, valued: 'manual', mark: { value: pm.value, asOf: pm.asOf, source: pm.source } };
  }
  const asOf = blameDate(line) || today;
  return { ...base, manualNative: h.manualNative, valued: 'manual',
    mark: { value: h.manualNative, asOf, source: `index.html line ${line} (git blame ${asOf === today ? '— no history, stamped today' : 'author date'})` } };
});
const prevIbkr = prev && prev.ibkr && typeof prev.ibkr === 'object' ? prev.ibkr : null;
const rate = (key, fallback) => (prevIbkr && prevIbkr[key] && typeof prevIbkr[key].value === 'number' && prevIbkr[key].asOf)
  ? { value: prevIbkr[key].value, asOf: prevIbkr[key].asOf, source: prevIbkr[key].source } : fallback;

const book = {
  asOf: today,
  generatedAt: new Date().toISOString(),
  source: 'extracted mechanically from the index.html holdings array; index.html remains the rendering source until phase 4 cutover',
  base: 'SGD',
  counts: { total: holdings.length, live: holdings.filter(h => h.valued === 'live').length, manual: holdings.filter(h => h.valued === 'manual').length },
  holdings,
  // IBKR margin account parameters. NEITHER existed anywhere in the code — the page computed
  // leverage from silver value and the loan line but had no maintenance rate, so it could never
  // tell the owner the one number that matters: the price at which he gets called. Both are
  // ASSUMED until confirmed and carry a source that says so; valuate.js colours the maintenance
  // rate amber at 30 days because IBKR raises it, sharply and with days of notice, in exactly the
  // conditions where it matters.
  ibkr: {
    silverId: (prevIbkr && prevIbkr.silverId) || 57, loanId: (prevIbkr && prevIbkr.loanId) || 58,
    maintenanceRate: rate('maintenanceRate', { value: 0.30, asOf: today, source: 'ASSUMED — typical IBKR metals maintenance; confirm on the IBKR account page and update' }),
    loanRate: rate('loanRate', { value: 0.060, asOf: today, source: 'ASSUMED — IBKR SGD margin rate tier; confirm and update' }),
  },
};
fs.writeFileSync(OUT, JSON.stringify(book, null, 2) + '\n');
console.log(`book.json: ${book.counts.total} holdings (${book.counts.live} live, ${book.counts.manual} manual marks) · asOf ${today}`);
const oldest = holdings.filter(h => h.mark).sort((a, b) => a.mark.asOf.localeCompare(b.mark.asOf))[0];
if (oldest) console.log(`  oldest manual mark: ${oldest.n} · ${oldest.mark.asOf}`);
