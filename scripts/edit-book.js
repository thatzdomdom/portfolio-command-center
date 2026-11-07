#!/usr/bin/env node
/*
 * edit-book.js — change ONE holding's number in BOTH places it lives, atomically and with a date.
 *
 * Phase 4 of the 11 Sep 2026 redesign. During the parallel week the holdings exist twice: the
 * `{id:N, …}` literals inside index.html (what the page renders) and data/book.json (what
 * valuate.js / one-action.js compute from). validate-all fails the morning on the first byte of
 * drift, so a hand edit to one copy silently reds the publish and the owner's LOAN reply would
 * never reach the page. This is the only supported way to change a quantity or a manual mark:
 * it rewrites the number in the html line (nothing else on the line moves — the line stays
 * byte-compatible with the regex extract-book.js / validate-all.js parse and with publish.js's
 * index guard, which accepts only `{id:N,…}` lines) and the same number in book.json, stamping
 * mark {value, asOf: today SGT, source} so the figure wears the date it was actually changed.
 * extract-book.js carries a mark forward on re-extract only when its source starts with
 * 'edit-book' or 'email reply' — keep that prefix (the default does) or a re-extract will reset
 * asOf to git blame. book.asOf / generatedAt are bumped too: a book edited today is as-of today.
 *
 * REFUSES (throws 'drift …') when book.json and index.html already disagree on that id — editing
 * one number on top of an unrelated divergence would hide which copy was right. Both files are
 * written temp+rename, index.html first; the ibkr block and every other holding pass through
 * untouched. A no-op (same value) writes nothing and reports unchanged, so journal.js can replay
 * a LOAN reply idempotently.
 *
 * CLI:    node scripts/edit-book.js --id N --value V [--source S] [--dry-run]
 * Module: const { editBook } = require('./edit-book.js');
 *         editBook({ id, value, source?, dryRun? }) → { ok, changed, id, field, before, after,
 *         markAsOf, source, line }; throws Error('drift …' | 'id … not in …' | 'value …').
 * Exit 0 on success or no-op; exit 1 with one line on any refusal. --dry-run prints, writes nothing.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html'), BOOK = path.join(ROOT, 'data', 'book.json');
const PARITY = ['t', 'yf', 'qty', 'book', 'manualNative'];   // the fields validate-all.js compares
const todaySGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
// Same literal shape extract-book.js parses: one `{id:N, …},` per line, optional trailing comment.
const parseLit = ln => new Function('return ' + ln.trim().replace(/,\s*(\/\/.*)?$/, '').replace(/\/\/.*$/, ''))();
const writeAtomic = (file, text) => { const t = file + '.edit-book.tmp'; fs.writeFileSync(t, text); fs.renameSync(t, file); };

function editBook({ id, value, source, dryRun = false } = {}) {
  id = Number(id);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`id must be a positive integer (got ${JSON.stringify(id)})`);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`value must be a finite number (got ${JSON.stringify(value)})`);
  const num = String(value);
  if (/e/i.test(num)) throw new Error(`value ${num} is not representable as a plain literal`);
  const today = todaySGT();
  source = String(source || `edit-book ${today}`);

  const book = JSON.parse(fs.readFileSync(BOOK, 'utf8'));
  const h = (book.holdings || []).find(x => x.id === id);
  if (!h) throw new Error(`id ${id} not in data/book.json`);
  const html = fs.readFileSync(HTML, 'utf8');
  const rowRe = new RegExp(`^(\\s*\\{id:\\s*${id}\\s*,.*\\}\\s*,?\\s*(?:\\/\\/.*)?)$`, 'gm');
  const hits = [...html.matchAll(rowRe)];
  if (hits.length !== 1) throw new Error(`id ${id} matches ${hits.length} holdings lines in index.html (need exactly 1)`);
  const [hit] = hits, line = hit[1], lineNo = html.slice(0, hit.index).split('\n').length;
  let o; try { o = parseLit(line); } catch (e) { throw new Error(`index.html line ${lineNo}: cannot parse holding: ${e.message}`); }

  // Drift gate — identical comparison to validate-all.js, on this id only.
  const diffs = PARITY.filter(k => JSON.stringify(h[k] ?? null) !== JSON.stringify(o[k] ?? null))
    .map(k => `${k} book.json=${h[k] ?? null} html=${o[k] ?? null}`);
  if (diffs.length) throw new Error(`drift: id ${id} ${h.t} — ${diffs.join('; ')} — run scripts/extract-book.js or fix by hand first`);
  const field = h.valued === 'live' ? 'qty' : 'manualNative';
  if (!(field in o) || !(field in h)) throw new Error(`drift: id ${id} ${h.t} — valued '${h.valued}' but ${field} is missing`);
  const before = h[field];
  const base = { ok: true, id, field, before, line: lineNo };
  if (before === value) return { ...base, changed: false, after: before, markAsOf: h.mark ? h.mark.asOf : null, source: h.mark ? h.mark.source : null };

  // The html line: replace ONLY the digits after the field key; every other byte stays.
  const fieldRe = new RegExp(`(\\b${field}:\\s*)(-?\\d+(?:\\.\\d+)?)`, 'g');
  const fm = [...line.matchAll(fieldRe)];
  if (fm.length !== 1) throw new Error(`index.html line ${lineNo}: ${field} literal not found exactly once`);
  const newLine = line.replace(fieldRe, `$1${num}`);
  if (parseLit(newLine)[field] !== value) throw new Error(`index.html line ${lineNo}: rewritten literal does not round-trip`);
  const newHtml = html.slice(0, hit.index) + newLine + html.slice(hit.index + line.length);

  h[field] = value;
  h.mark = { value, asOf: today, source };
  book.asOf = today; book.generatedAt = new Date().toISOString();
  const out = { ...base, changed: true, after: value, markAsOf: today, source };
  if (dryRun) return out;
  writeAtomic(HTML, newHtml);
  writeAtomic(BOOK, JSON.stringify(book, null, 2) + '\n');
  return out;
}

if (require.main === module) {
  const a = process.argv.slice(2), DRY = a.includes('--dry-run');
  const opt = k => { const i = a.indexOf(k); if (i >= 0 && a[i + 1] != null) return a[i + 1]; const e = a.find(x => x.startsWith(k + '=')); return e ? e.slice(k.length + 1) : undefined; };
  const idS = opt('--id'), valS = opt('--value');
  if (idS == null || valS == null) { console.error('usage: edit-book.js --id N --value V [--source S] [--dry-run]'); process.exit(1); }
  const value = Number(String(valS).replace(/[,_\s]/g, ''));
  if (!Number.isFinite(value)) { console.error(`edit-book: --value "${valS}" is not a number`); process.exit(1); }
  try {
    const r = editBook({ id: Number(idS), value, source: opt('--source'), dryRun: DRY });
    const name = (JSON.parse(fs.readFileSync(BOOK, 'utf8')).holdings.find(x => x.id === r.id) || {}).n || '';
    if (!r.changed) console.log(`edit-book: id ${r.id} ${name} · ${r.field} already ${r.before} — unchanged, nothing written`);
    else console.log(`edit-book: id ${r.id} ${name} · ${r.field} ${r.before} → ${r.after} · mark asOf ${r.markAsOf} · source "${r.source}"\n  ${DRY ? 'dry-run — nothing written' : `written: index.html line ${r.line} + data/book.json`}`);
  } catch (e) { console.error(`edit-book: ${e.message}`); process.exit(1); }
}

module.exports = { editBook };
