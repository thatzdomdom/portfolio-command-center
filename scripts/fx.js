#!/usr/bin/env node
/*
 * fx.js — SGD exchange rates, deterministic, keyless, dated.
 *
 * Until phase 1 the dashboard's only FX source was Yahoo `=X` pairs fetched in the BROWSER at page
 * load. The proposal named the MAS API; it returned nothing at build time (11 Sep 2026). ECB's
 * daily reference rates are keyless XML, carry every currency on this book, and stamp their own
 * date — so ECB is PRIMARY and Yahoo pairs are the cross-check (and Yahoo had no bars at all for
 * CNY and MYR when tested).
 *
 * Convention matches index.html's FX[cur]: rates are SGD PER ONE UNIT of the currency, so a value
 * in currency X converts to SGD by multiplying. ECB quotes X per EUR; SGD per X = SGD/EUR ÷ X/EUR.
 */
const fs = require('fs'), path = require('path'), https = require('https');
const OUT = path.join(__dirname, '..', 'data', 'fx.json');
const NEED = ['USD', 'HKD', 'CNY', 'MYR'];

const get = url => new Promise(res => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(r.headers.location).then(res);
    let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
  }).on('error', e => res({ status: 0, body: e.message }));
});

async function ecb() {
  const r = await get('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
  if (r.status !== 200) throw new Error(`ECB HTTP ${r.status}`);
  const time = /time='(\d{4}-\d{2}-\d{2})'/.exec(r.body);
  const perEur = {};
  for (const m of r.body.matchAll(/currency='([A-Z]{3})'\s+rate='([\d.]+)'/g)) perEur[m[1]] = +m[2];
  if (!time || !perEur.SGD) throw new Error('ECB response missing date or SGD');
  const rates = { SGD: 1 };
  for (const c of NEED) { if (!perEur[c]) throw new Error(`ECB missing ${c}`); rates[c] = +(perEur.SGD / perEur[c]).toFixed(6); }
  return { asOf: time[1], rates };
}

async function yahooCheck() {
  // Cross-check only. Reuses the price spine's fetcher so the same incomplete-bar rule applies.
  const out = {};
  try {
    const { fetchOne } = require('./price-spine.js');
    for (const c of NEED) {
      const r = await fetchOne(`${c}SGD=X`, 'FUT', '5d');
      const b = (r.bars || []).filter(x => !x.partial).slice(-1)[0];
      out[c] = b ? { asOf: b.d, rate: +b.c.toFixed(6) } : { unavailable: r.error || 'no completed bars' };
    }
  } catch (e) { out.error = e.message; }
  return out;
}

(async () => {
  const prior = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { return null; } })();
  let primary;
  try { primary = await ecb(); }
  catch (e) {
    // Never clobber good data with nothing. Keep the prior file, flag it, exit 2.
    console.error(`fx: ECB fetch failed (${e.message})`);
    if (prior) { prior.staleSince = prior.staleSince || prior.generatedAt; prior.lastFetchFailed = { at: new Date().toISOString(), error: e.message };
      fs.writeFileSync(OUT, JSON.stringify(prior, null, 2) + '\n'); console.error('  kept prior fx.json, flagged stale'); }
    process.exit(2);
  }
  const check = await yahooCheck();
  const diffs = {};
  for (const c of NEED) if (check[c] && check[c].rate) diffs[c] = +(((check[c].rate / primary.rates[c]) - 1) * 100).toFixed(3);
  const worst = Math.max(0, ...Object.values(diffs).map(Math.abs));
  const out = {
    asOf: primary.asOf, generatedAt: new Date().toISOString(),
    source: 'ECB euro foreign exchange reference rates (14:15 CET), cross-rated to SGD',
    base: 'SGD', convention: 'SGD per 1 unit of currency — multiply a native amount by rates[cur]',
    rates: primary.rates,
    crossCheck: { source: 'Yahoo chart endpoint, last completed daily bar', yahoo: check, diffPct: diffs,
      note: worst > 1 ? `WARNING: ECB and Yahoo disagree by ${worst}% on at least one pair — inspect` : `agree within ${worst}%` },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  // FX history for the monthly-move line (>3% = FX cash review). Public data; committed.
  try { const HP = path.join(__dirname, '..', 'data', 'fx-history.ndjson'); const last = fs.existsSync(HP) ? fs.readFileSync(HP, 'utf8').trim().split('\n').pop() : '';
    if (!last || JSON.parse(last).date !== primary.asOf) fs.appendFileSync(HP, JSON.stringify({ date: primary.asOf, rates: primary.rates }) + '\n'); } catch (_) {}
  console.log(`fx.json: ECB ${primary.asOf} · ` + NEED.map(c => `${c} ${primary.rates[c]}`).join(' · ') + ` · vs Yahoo: ${out.crossCheck.note}`);
  if (worst > 1) process.exit(2);
})();
