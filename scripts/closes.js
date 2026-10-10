#!/usr/bin/env node
/*
 * closes.js — two years of daily closes, published, so a page can draw a line.
 *
 * WHY THIS EXISTS (13 Sep 2026, phase 5). The browser makes ZERO external calls — that rule is
 * what killed the old page's Yahoo-at-page-load FX and quote fetches, and it is not negotiable.
 * So whatever history a page can show must already be sitting in data/ as a file it may read.
 * The only history this pipeline keeps is data/.prices-2y.json, and that file is gitignored and
 * local: price-spine.js writes the full two years there and ships only the last TWELVE bars in
 * .prices.json, because twelve is all the revision detector needs to diff. Twelve bars cannot
 * draw a 200-day average, a 1-year return, a drawdown, or a sparkline — so every chart, every
 * period return and the NAV curve die at the browser door even though the data exists on disk.
 *
 * The exposure question was asked and answered: the 66 SYMBOLS are already public in
 * .prices.json, and a close is public market data that anyone can look up. What is private is
 * the book — quantities, marks, balances — and none of that is here. This file carries names,
 * dates and closes and nothing else, so it ships in the clear like technicals.json does.
 *
 * SHAPE: exchange-indexed, not instrument-indexed. Thirty-four SGX names share one calendar of
 * 508 session dates; repeating that date string under every instrument roughly triples the file
 * for no information. Each exchange carries its dates once, each instrument carries a c[] array
 * positionally aligned to its exchange's dates, and `null` means "no print that session" — not
 * zero, not a carried-forward price. SLV lagging the rest of the US tape by a session (Yahoo
 * consolidates late) shows up as a trailing null, which is the truth; carrying Wednesday's close
 * into Thursday is the weekend-tick error price-spine.js was built to prevent.
 *
 * COMPLETED BARS ONLY (`!b.partial`), for the same reason: a live mid-session level or the
 * crypto bar that never closes is not a close and must never reach a chart as one.
 *
 * Consumers: today.html (movers + sparklines), book.html (the 2-year chart, SMA200 overlay, the
 * 1W/1M/YTD/1Y column), via PCC.closesFor()/retPct()/spark()/chart() in common.js.
 * Runs right after price-spine.js in research-headless.sh. --dry-run prints the size and writes
 * nothing. Exit 1 if the spine has not run.
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const D = f => path.join(__dirname, '..', 'data', f);
const DRY = process.argv.includes('--dry-run');
const SRC = D('.prices-2y.json'), OUT = D('closes.json');

if (!fs.existsSync(SRC)) {
  console.error('closes.js: data/.prices-2y.json is missing — run scripts/price-spine.js first; no closes published.');
  process.exit(1);
}
let P;
try { P = JSON.parse(fs.readFileSync(SRC, 'utf8')); }
catch (e) { console.error(`closes.js: data/.prices-2y.json is unreadable (${e.message}) — run scripts/price-spine.js again; no closes published.`); process.exit(1); }

const src = P.instruments || {};
const r4 = x => +Number(x).toFixed(4);

// Pass 1 — per instrument, the completed bars as a date→close map, and the exchange calendars as
// the UNION of every date any instrument on that exchange printed. A name that listed late, or a
// feed that is a session behind, therefore widens nobody else's calendar and loses no dates of
// its own; it just carries nulls where it had no print.
const byEx = {};                                   // exchange → Set of dates
const rows = [];                                   // { sym, ex, name, trust, proxy, map }
for (const [sym, inst] of Object.entries(src)) {
  const ex = inst.exchange || 'US';
  const map = new Map();
  for (const b of inst.bars || []) {
    if (b.partial) continue;                       // live level / incomplete session — not a close
    if (b.c == null || !Number.isFinite(b.c)) continue;
    map.set(b.d, r4(b.c));
  }
  (byEx[ex] = byEx[ex] || new Set());
  for (const d of map.keys()) byEx[ex].add(d);
  rows.push({ sym, ex, name: inst.name || sym, trust: inst.trust || 'ok', proxy: inst.proxy || null, map });
}

const exchanges = {};
for (const ex of Object.keys(byEx).sort()) exchanges[ex] = [...byEx[ex]].sort();

// Pass 2 — align. Instruments with fewer than 20 closes are STILL emitted: whether twelve bars is
// enough to say anything is the page's judgement, not this file's, and silently dropping a
// holding would leave a row in book.html with no series and no explanation.
const instruments = {}; const thin = [];
for (const r of rows.sort((a, b) => a.sym.localeCompare(b.sym))) {
  const dates = exchanges[r.ex] || [];
  const c = dates.map(d => (r.map.has(d) ? r.map.get(d) : null));
  if (r.map.size < 20) thin.push(`${r.sym} (${r.map.size})`);
  instruments[r.sym] = { ex: r.ex, name: r.name, trust: r.trust, proxy: r.proxy, c };
}

// asOf = the newest COMPLETED session on any real exchange. Crypto is excluded from the stamp for
// the same reason manifest.js excludes it from .prices.json's: it prints on Saturdays, so letting
// it set the as-of would make the whole file look a day fresher than the equity tape every
// weekend. Its dates and closes are published in full — only the stamp ignores it.
const stampDates = Object.entries(exchanges).filter(([ex]) => ex !== 'CRYPTO').map(([, d]) => d[d.length - 1]).filter(Boolean).sort();
const asOf = stampDates.pop() || null;

const out = {
  asOf,
  generatedAt: new Date().toISOString(),
  source: 'price-spine .prices-2y.json (completed bars only)',
  exchanges,
  instruments,
};
const body = JSON.stringify(out) + '\n';
const kb = n => (n / 1024).toFixed(0) + ' KB';
const raw = Buffer.byteLength(body), gz = zlib.gzipSync(Buffer.from(body)).length;

// A spine that parses but yields nothing must NEVER overwrite the good file: the pages would lose
// every chart and every period return in silence, and research-headless.sh only reacts to a
// non-zero exit. Refuse, keep what is published, and name the step to re-run.
if (!out.asOf || !Object.keys(out.instruments || {}).length) {
  console.error('closes.js: the spine yielded 0 usable instruments — keeping the existing data/closes.json. Re-run scripts/price-spine.js.');
  process.exit(1);
}
if (!DRY) fs.writeFileSync(OUT, body);
const nEx = Object.keys(exchanges).length, nIn = Object.keys(instruments).length;
console.log(`closes.json: ${nIn} instruments · ${nEx} exchanges · as of ${asOf} · ${kb(raw)} raw / ${kb(gz)} gzip` +
  (DRY ? ' · dry-run — nothing written' : ` → data/closes.json`));
console.log('  sessions per exchange: ' + Object.entries(exchanges).map(([k, v]) => `${k} ${v.length} (to ${v[v.length - 1]})`).join(' · '));
if (thin.length) console.log(`  ~~ fewer than 20 closes (emitted anyway; the page decides): ${thin.join(', ')}`);
const lag = Object.entries(instruments).filter(([, i]) => i.c.length && i.c[i.c.length - 1] == null).map(([s]) => s);
if (lag.length) console.log(`  ~ no print in the latest session on their exchange (trailing null, not carried forward): ${lag.join(', ')}`);
