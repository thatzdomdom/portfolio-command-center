#!/usr/bin/env node
/*
 * validate-intel.js — mechanical price cross-check for data/intel.json
 *
 * WHY THIS EXISTS (31 Jul 2026): the research agent published an insider buy of
 * Mapletree Logistics Trust (M44U) at "~S$1.91/unit" on 2026-07-06. The unit
 * actually traded S$1.20-1.25 that entire fortnight — the price was invented.
 * A sweep found a second one the same day (Singtel/Z74 "~S$4.67" vs an actual
 * 4.35-4.49 range), while two other entries (DBS S$60.12, Newmont US$92.38)
 * were precisely right. So the agent is not uniformly unreliable — which is
 * exactly why prose instructions are not enough. Every stated price now gets
 * checked against the tape before it can reach the dashboard.
 *
 * Checks each insider/congress entry that states or implies a per-share price:
 *   - explicit  "~S$1.91/share" / "@ 4.67 per unit"
 *   - derived   value ÷ shares  (e.g. "~S$191K" over "~100,000" units)
 * against actual daily OHLC in a ±14-day window around the stated date.
 *
 *   --report (default)  print a table, exit 1 if any entry is impossible
 *   --fix               quarantine impossible entries into intel.json's
 *                       dataQuality block and remove them from the published
 *                       arrays, so nothing unverifiable is ever served
 *
 * Fails OPEN on network problems: an entry we cannot price is left alone and
 * reported as UNCHECKED. We remove things only on positive evidence of error.
 */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const FILE = path.join(__dirname, '..', 'data', 'intel.json');
const FIX = process.argv.includes('--fix');
const TOL = 0.02;   // 2% grace for intraday prints outside the daily bar / rounding

// SGX short codes used in the book → Yahoo symbols
const SGX = { D05:'D05.SI', DBS:'D05.SI', Z74:'Z74.SI', F99:'F99.SI', C09:'C09.SI', U14:'U14.SI', W05:'W05.SI',
  Z25:'Z25.SI', '5E2':'5E2.SI', AU8U:'AU8U.SI', BS6:'BS6.SI', K71U:'K71U.SI', N2IU:'N2IU.SI', M44U:'M44U.SI',
  WJP:'WJP.SI', S20:'S20.SI', H13:'H13.SI', B73:'B73.SI', M01:'M01.SI', T24:'T24.SI', S08:'S08.SI', G92:'G92.SI' };

function yahooSymbol(raw) {
  let t = String(raw || '').trim().replace(/\s+/g, '');
  if (!t) return null;
  if (/\.(SI|HK|AX|TO|L)$/i.test(t)) return SGX[t.replace(/\..*$/, '')] || t;
  if (SGX[t]) return SGX[t];
  if (/^\d{4}$/.test(t)) return t + '.HK';               // bare HK code
  if (/^[A-Z.\-]{1,6}$/.test(t)) return t;                // US ticker
  return null;
}
const num = s => { const m = String(s).replace(/,/g, '').match(/([0-9]*\.?[0-9]+)\s*([KMB])?/i); if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1; return parseFloat(m[1]) * mult; };

// Extract the price an entry asserts, explicitly or by arithmetic.
// The derived branch is deliberately strict: on 31 Jul a loose version read
// "accumulation reported (~S$580K at ~S$5.80...)" as a SHARE COUNT of 580,000
// and "derived" a price of exactly 1.00, flagging a legitimate entry. Only
// derive when `shares` is a clean bare number and `value` is a clean amount.
function assertedPrice(x) {
  const blob = JSON.stringify(x);
  const explicit = blob.match(/(?:S\$|HK\$|US\$|A\$|\$)\s?([0-9]+(?:\.[0-9]+)?)\s*\/?\s*(?:per\s+)?(?:share|unit)/i)
    || blob.match(/(?:at|@|avg\.?|average(?:\s+of)?)\s*~?\s*(?:S\$|HK\$|US\$|A\$|\$)\s?([0-9]+(?:\.[0-9]+)?)\b/i);
  if (explicit) return { price: parseFloat(explicit[1]), how: 'stated' };
  const shRaw = String(x.shares || '').trim(), valRaw = String(x.value || '').trim();
  const cleanShares = /^~?\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*[KMB]?\s*(?:shares?|units?)?$/i.test(shRaw);
  const cleanValue  = /^~?\s*(?:S\$|HK\$|US\$|A\$|\$)\s?[0-9][0-9,]*(?:\.[0-9]+)?\s*[KMB]?$/i.test(valRaw);
  if (!cleanShares || !cleanValue) return null;
  const sh = num(shRaw), val = num(valRaw);
  if (sh > 0 && val > 0) {
    const p = val / sh;
    if (p > 0.01 && p < 100000) return { price: p, how: 'value÷shares' };
  }
  return null;
}

// A substantial-shareholder notice, a "crossed 5%" filing or an explicit average
// reports a price averaged over an accumulation that can span many months, so a
// ±14-day window is the wrong yardstick for it (Singtel's genuine ~S$4.67 avg
// was flagged by exactly that mistake). Such entries are judged on a 1y range.
const isAveraged = x => /substantial|crossed|accumulat|average|avg/i.test(JSON.stringify(x));

function ohlcWindow(sym, dateStr, days) {
  const t = Date.parse(dateStr + 'T00:00:00Z');
  if (!t) return null;
  const w = (days || 14) * 86400;
  const p1 = Math.floor(t / 1000) - w, p2 = Math.floor(t / 1000) + Math.min(w, 14 * 86400);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1d`;
  let j;
  try {
    j = JSON.parse(execSync(`curl -s --max-time 25 -H "User-Agent: Mozilla/5.0" -H "Origin: https://finance.yahoo.com" ${JSON.stringify(url)}`, { encoding: 'utf8', timeout: 30000 }));
  } catch (e) { return null; }
  const res = j?.chart?.result?.[0], q = res?.indicators?.quote?.[0];
  if (!res?.timestamp || !q?.low) return null;
  let lo = Infinity, hi = -Infinity, onDay = null, bars = 0;
  res.timestamp.forEach((s, i) => {
    if (q.low[i] == null || q.high[i] == null) return;
    bars++; lo = Math.min(lo, q.low[i]); hi = Math.max(hi, q.high[i]);
    if (new Date(s * 1000).toISOString().slice(0, 10) === dateStr) onDay = { l: q.low[i], h: q.high[i] };
  });
  return bars ? { lo, hi, onDay, bars, currency: res.meta?.currency } : null;
}

// CITATION QUALITY. The retracted M44U item cited only "https://links.sgx.com/"
// — a homepage with no document path. That is the tell: it means no filing was
// ever located, and in that case the item turned out to be a 2020 article
// re-dated to 2026. A domain-root-only citation is therefore flagged (not
// deleted — the underlying event may be real) so the dashboard can badge it
// as unverified instead of presenting it as established fact.
const isBareDomain = u => { try { const p = new URL(String(u)).pathname; return p === '' || p === '/'; } catch (_) { return false; } };
function citationFlag(x) {
  const s = (x.sources || []).filter(Boolean);
  if (!s.length) return 'no source cited';
  if (s.every(isBareDomain)) return 'only homepage-level sources — no specific filing/article was located';
  return null;
}

const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const sections = [['insiders', d.insiders], ['congress', d.congress]].filter(([, a]) => Array.isArray(a));
const results = [];
for (const [name, arr] of sections) {
  for (const x of arr) {
    const ap = assertedPrice(x);
    if (!ap || !x.date) continue;
    const sym = yahooSymbol(x.ticker);
    if (!sym) { results.push({ name, x, ...ap, status: 'UNCHECKED', why: 'ticker not resolvable' }); continue; }
    // Two yardsticks. WIDE (1 year) is the deletion test — a price the stock
    // never touched in a year cannot be right under any reading. TIGHT (±14d)
    // only downgrades a dated single trade to SUSPECT for review; we never
    // auto-delete on it, because averages and mis-stated dates live there.
    const wide = ohlcWindow(sym, x.date, 365);
    if (!wide) { results.push({ name, x, ...ap, sym, status: 'UNCHECKED', why: 'no price data' }); continue; }
    const inWide = ap.price >= wide.lo * (1 - TOL) && ap.price <= wide.hi * (1 + TOL);
    if (!inWide) { results.push({ name, x, ...ap, sym, w: wide, wide, status: 'IMPOSSIBLE' }); continue; }
    if (isAveraged(x)) { results.push({ name, x, ...ap, sym, w: wide, wide, status: 'OK', why: 'averaged/accumulation — judged on 1y range' }); continue; }
    const tight = ohlcWindow(sym, x.date, 14);
    const inTight = tight && ap.price >= tight.lo * (1 - TOL) && ap.price <= tight.hi * (1 + TOL);
    results.push({ name, x, ...ap, sym, w: tight || wide, wide, status: inTight ? 'OK' : 'SUSPECT',
      why: inTight ? '' : 'price traded within the year but not near the stated date' });
  }
}

// Citation sweep runs over EVERY entry, priced or not.
const cites = [];
for (const [name, arr] of sections) for (const x of arr) {
  const f = citationFlag(x);
  if (f) cites.push({ name, x, why: f }); else if (x.citationFlag) delete x.citationFlag;
}
if (cites.length) {
  console.log(`citation check — ${cites.length} entr${cites.length === 1 ? 'y' : 'ies'} without a document-level source:`);
  cites.forEach(c => console.log(`  ⚑ ${String(c.x.ticker).padEnd(9)} ${String(c.x.date || '').padEnd(11)} ${String(c.x.insider || c.x.representative || '').slice(0, 30).padEnd(31)} ${c.why}`));
  console.log('');
}

const bad = results.filter(r => r.status === 'IMPOSSIBLE');
const suspect = results.filter(r => r.status === 'SUSPECT');
const f2 = n => n == null ? '—' : (+n).toFixed(n < 10 ? 3 : 2);
console.log(`price cross-check — ${results.length} priced entr${results.length === 1 ? 'y' : 'ies'}\n`);
results.forEach(r => {
  const icon = { OK: '✓', IMPOSSIBLE: '❌', SUSPECT: '⚠', UNCHECKED: '…' }[r.status];
  const rng = r.w ? `${f2(r.w.lo)}–${f2(r.w.hi)}` : '';
  const yr = r.wide ? ` · 1y ${f2(r.wide.lo)}–${f2(r.wide.hi)}` : '';
  console.log(`${icon} ${String(r.x.ticker).padEnd(9)} ${String(r.x.date).padEnd(11)} ${r.how.padEnd(12)} ${f2(r.price).padEnd(9)} vs ${rng.padEnd(15)}${yr.padEnd(22)} ${String(r.x.insider || r.x.representative || '').slice(0, 26)}${r.why ? '  [' + r.why + ']' : ''}`);
});
if (suspect.length) console.log(`\n${suspect.length} SUSPECT (kept, flagged for review — price is real but not near the stated date)`);

// Persist the citation flags even when there is nothing to quarantine, so the
// dashboard can badge unverified items on every run.
if (FIX) {
  cites.forEach(c => { c.x.citationFlag = c.why; });
  d.dataQuality = d.dataQuality || { note: '', removed: [] };
  d.dataQuality.flaggedCitations = cites.length;
  d.dataQuality.checkedOn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n');
}

if (!bad.length) { console.log(`no impossible prices${suspect.length ? ' (suspects above need a human look)' : ''}`); process.exit(suspect.length ? 2 : 0); }

console.log(`\n${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} assert a price the tape never printed`);
if (!FIX) process.exit(1);

const stamp = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
d.dataQuality = d.dataQuality || { note: 'Entries removed by the automated price cross-check (scripts/validate-intel.js): the stated price was outside the actual traded range, so the figures could not be trusted.', removed: [] };
for (const r of bad) {
  const arr = r.name === 'insiders' ? d.insiders : d.congress;
  const i = arr.indexOf(r.x);
  if (i >= 0) arr.splice(i, 1);
  d.dataQuality.removed.unshift({
    removedOn: stamp, section: r.name, ticker: r.x.ticker, date: r.x.date,
    who: r.x.insider || r.x.representative || '',
    assertedPrice: +r.price.toFixed(4), assertedVia: r.how,
    actualRange: `${f2(r.w.lo)}–${f2(r.w.hi)}`,
    onDay: r.w.onDay ? `${f2(r.w.onDay.l)}–${f2(r.w.onDay.h)}` : null,
    reason: 'stated price outside the traded range for the ±14 days around the stated date',
  });
}
d.dataQuality.removed = d.dataQuality.removed.slice(0, 40);
fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n');
console.log(`quarantined ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} into intel.json → dataQuality.removed`);
