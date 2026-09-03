#!/usr/bin/env node
/*
 * calendar-spine.js — the deterministic ECONOMIC CALENDAR layer.
 *
 * WHY (18 Aug 2026). The price spine removed price research from agents. This removes the other
 * category of structured data they were bad at: scheduled economic releases and their consensus.
 *
 * The concrete failure that motivated it: for Friday 14 Aug's University of Michigan print, two
 * finder agents returned two different consensus figures — 54.5 and 55.0 — and neither could be
 * resolved, so the brief had to publish the disagreement. Consensus is a published number; it
 * should not be a research question. Worse failures of the same shape: a CPI release date asserted
 * from memory, an auction described as "tomorrow" when it had already happened, and Jackson Hole
 * dates that were never verified at all.
 *
 * SOURCE: ForexFactory's public weekly calendar JSON. Keyless — same reasoning as the price spine:
 * every credentialed dependency in this pipeline has eventually expired and broken it silently.
 * Fields: title, country, date (ISO with offset), impact, forecast, previous.
 * There is NO `actual` field — verified empirically, 0 of 96 events carried one. So this layer
 * makes the SCHEDULE and the CONSENSUS free and exact; fetching what a print actually came in at
 * remains an agent's job.
 *
 * (TradingView's calendar was the alternative, and it is good — but there is no TradingView MCP,
 * no public retail API, and driving the Mac app means reading numbers off screenshots. OCR is
 * exactly the failure mode this whole layer exists to eliminate.)
 *
 * WHAT IT DOES NOT DO: it will not tell you WHY a number moved a market, whether a release is
 * genuinely new or recycled copy, or what a filing says. That is what agents are for.
 */
const fs = require('fs'), path = require('path'), https = require('https');

// Only 'thisweek' exists — 'lastweek' returns 404 consistently, so it is not requested.
const FEEDS = [['thisweek', 'https://nfs.faireconomy.media/ff_calendar_thisweek.json']];

// The endpoint rate-limits (429) on rapid repeat calls, which is easy to trip while iterating.
// Back off and retry rather than treating the first 429 as a failure.
async function getWithRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await get(url);
    if (r.status === 200) return r;
    if (r.status !== 429 && r.status !== 0) return r;      // a real error; do not hammer it
    await new Promise(res => setTimeout(res, 1500 * (i + 1)));
  }
  return await get(url);
}

// Currencies that actually move this book. Everything else is dropped unless High impact.
const CORE = new Set(['USD', 'CNY', 'SGD', 'HKD', 'JPY', 'KRW']);

// Releases this portfolio is specifically exposed to. Country-scoped: the first version tagged
// UK CPI as "drives the levered silver leg" and US Industrial Production as "China activity",
// because it matched on title alone. What matters is the pairing of release AND economy.
const BOOK_RELEVANT = [
  [/\bCPI\b|Consumer Price|\bPCE\b/i, ['USD'], 'US inflation — drives the levered silver leg and the Fed path'],
  [/\bPPI\b|Producer Price/i, ['USD'], 'US inflation'],
  [/Non-?Farm|Unemployment Claims|Jobless Claims|Unemployment Rate|Average Hourly/i, ['USD'], 'US labour — the other half of the Fed path'],
  [/Retail Sales/i, ['USD'], 'US consumer — cyclical read for the banks, developers and oil'],
  [/FOMC|Fed Chair|Federal Funds|Fed Member|Jackson Hole/i, ['USD'], 'Fed — direct on the margin cost of the 1.6x levered silver'],
  [/Crude Oil Inventories|Natural Gas Storage/i, ['USD'], 'energy sleeve (USO/XLE)'],
  [/Bond Auction|Note Auction|\b(10|30|20)-y\b/i, ['USD'], 'long end — the S-REIT and developer discount rate'],
  [/Consumer Sentiment|Consumer Confidence/i, ['USD'], 'US sentiment'],
  // China — the HK tech sleeve trades on these even though the vendor rates them "Low"
  [/Industrial Production|Retail Sales|Fixed Asset|New Loans|M2|Loan Prime Rate|GDP|Trade Balance|Exports/i, ['CNY'],
   'China activity/credit — Tencent, Xiaomi, SMIC and the SGX China-exposed names'],
  // Singapore
  [/NODX|Non-?Oil|Trade|GDP|CPI/i, ['SGD'], 'Singapore — the SGX bank/REIT/developer sleeve'],
  // Japan and Korea move the regional risk tone the HK sleeve trades with
  [/CPI|GDP|Trade Balance|BOJ|Interest Rate/i, ['JPY', 'KRW'], 'North Asia risk tone — read-across to the HK sleeve'],
];

const get = url => new Promise(res => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(r.headers.location).then(res);
    let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
  }).on('error', e => res({ status: 0, body: e.message }));
});

const sgt = iso => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso)).replace(',', '');

function relevance(title, country) {
  for (const [re, countries, why] of BOOK_RELEVANT) {
    if (countries.includes(country) && re.test(title)) return why;
  }
  return null;
}

async function main() {
  const nowMs = Date.now();

  // FRESHNESS CACHE. The endpoint rate-limits aggressively — six calls inside a few minutes while
  // iterating on this file earned a sustained 429. A calendar of scheduled releases changes at
  // most a few times a day, so refetching more often is both rude and pointless. Skip entirely if
  // the file on disk is recent and non-empty; pass --force to override.
  const OUTP = path.join(__dirname, '..', 'data', '.calendar.json');
  const MAX_AGE_H = 6;
  if (!process.argv.includes('--force') && fs.existsSync(OUTP)) {
    try {
      const prior = JSON.parse(fs.readFileSync(OUTP, 'utf8'));
      const ageH = (nowMs - Date.parse(prior.generated)) / 3.6e6;
      const n = (prior.released || []).length + (prior.upcoming || []).length;
      if (n > 0 && ageH < MAX_AGE_H) {
        console.log(`calendar spine: cache is ${ageH.toFixed(1)}h old with ${n} events — reusing (--force to refetch)`);
        return;
      }
    } catch (_) { /* unreadable cache — fall through and fetch */ }
  }
  const out = {
    generated: new Date().toISOString(),
    source: 'ForexFactory public weekly calendar JSON (keyless)',
    note: 'Times converted to Asia/Singapore. `released` is computed from the event TIMESTAMP, so nothing is ever described as upcoming once its moment has passed. WHAT THIS GIVES: the schedule, the CONSENSUS (`forecast`) and the PREVIOUS, exactly — take consensus figures from here rather than asking an agent to hunt one, which is how two finders once returned 54.5 and 55.0 for the same UMich print. WHAT IT DOES NOT GIVE: the ACTUAL released number. This feed has no such field. An agent must still fetch what a print came in at.',
    released: [], upcoming: [], errors: [],
  };

  const seen = new Set();
  for (const [which, url] of FEEDS) {
    const r = await getWithRetry(url);
    if (r.status !== 200) { out.errors.push(`${which}: HTTP ${r.status}`); continue; }
    let j; try { j = JSON.parse(r.body); } catch { out.errors.push(`${which}: unparseable`); continue; }
    if (!Array.isArray(j)) { out.errors.push(`${which}: not an array`); continue; }

    for (const e of j) {
      const impact = String(e.impact || '');
      if (!CORE.has(e.country) && impact !== 'High') continue;
      if (impact === 'Low' && !relevance(e.title || '', e.country)) continue;   // drop Low-impact noise
      const key = `${e.country}|${e.title}|${e.date}`;
      if (seen.has(key)) continue; seen.add(key);

      const t = Date.parse(e.date);
      const rec = {
        title: e.title, country: e.country, impact,
        whenSGT: sgt(e.date), whenISO: e.date,
        forecast: e.forecast || null, previous: e.previous || null,
        relevance: relevance(e.title || '', e.country),
      };
      // A release is "released" only once its timestamp has passed — never trust the presence of
      // an `actual` field alone, and never present a past event as upcoming.
      // NOTE: this feed carries NO `actual` — verified empirically, 0 of 96 events had one.
      // So `released` means "its moment has passed", not "here is the print". Getting the actual
      // number is still an agent's job; what is now free and exact is WHEN it lands, the
      // CONSENSUS and the PREVIOUS. Do not add an `actual` field back without re-checking the
      // feed — a null that looks like data is worse than an absent field.
      if (isFinite(t) && t <= nowMs) out.released.push(rec); else out.upcoming.push(rec);
    }
  }

  out.released.sort((a, b) => b.whenISO.localeCompare(a.whenISO));   // newest first
  out.upcoming.sort((a, b) => a.whenISO.localeCompare(b.whenISO));   // soonest first

  // Do NOT overwrite a good file with an empty one. The first version did exactly that when the
  // endpoint returned 429 mid-iteration: a transient rate-limit silently replaced a complete
  // calendar with zero events, which downstream would read as "nothing is scheduled this week".
  // A stale-but-labelled calendar is far safer than an empty one presented as current.
  const OUT = path.join(__dirname, '..', 'data', '.calendar.json');
  if (!out.released.length && !out.upcoming.length) {
    console.error(`calendar spine: fetch produced ZERO events (${out.errors.join('; ') || 'no reason given'})`);
    if (fs.existsSync(OUT)) {
      const prior = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      prior.staleSince = prior.staleSince || prior.generated;
      prior.lastFetchFailed = { at: new Date().toISOString(), errors: out.errors };
      fs.writeFileSync(OUT, JSON.stringify(prior, null, 2) + '\n');
      console.error('  kept the previous calendar and flagged it as stale — NOT overwritten');
      process.exit(2);
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    process.exit(2);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  const bookRel = [...out.released, ...out.upcoming].filter(x => x.relevance).length;
  console.log(`calendar spine: ${out.released.length} released, ${out.upcoming.length} upcoming (${bookRel} book-relevant) → data/.calendar.json`);
  if (out.errors.length) out.errors.forEach(e => console.log('  ! ' + e));
  const next = out.upcoming.filter(x => x.impact === 'High' || x.relevance).slice(0, 6);
  if (next.length) { console.log('  next up:'); next.forEach(x =>
    console.log(`    ${x.whenSGT} SGT  ${x.country}  ${x.title}${x.forecast ? `  (cons ${x.forecast}, prev ${x.previous || '—'})` : ''}`)); }
}

if (require.main === module) main();
module.exports = { main };
