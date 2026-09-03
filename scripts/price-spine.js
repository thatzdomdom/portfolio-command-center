#!/usr/bin/env node
/*
 * price-spine.js — the deterministic price layer.
 *
 * WHY THIS EXISTS (17 Aug 2026). Nearly every error this dashboard has published was a PRICE
 * error made by an agent reading a number off a news page: Brent quoted at a spot/CFD price and
 * labelled a settle; OCBC printed 31.36 on one feed and 31.43 on another; a Hang Seng point-delta
 * wrong by 78 points; a delayed 14:20 ET GDX quote sold as a close; weekend CFD ticks stamped with
 * the current date. On 17 Aug a research run also burned ~2.4M tokens partly because thirty
 * verification agents were each re-opening quote pages to check arithmetic.
 *
 * Prices are structured data. They should be fetched by code, once, deterministically — not
 * researched by language models. Agents should be spent on things only they can do: reading a
 * filing, explaining WHY a number moved, catching a recycled press release.
 *
 * SOURCE: Yahoo's chart endpoint. Keyless — which matters more than it sounds, because every
 * credentialed dependency in this pipeline has eventually expired and broken it silently (the
 * Claude CLI OAuth token on 4 Aug, SMTP_PASS never filled). Validated against independently
 * verified closes: GDX 11 Aug returns 90.12 against our adversarially-verified 90.12.
 *
 * (TradingView was considered — Dom has a premium subscription — but there is no TradingView MCP
 * connected, none in the connector registry, and no public retail market-data API. The
 * subscription is a browser entitlement. This is cheaper and has nothing to authenticate.)
 *
 * THE INCOMPLETE-BAR RULE, which is the whole reason this is not a three-line fetch:
 * Yahoo returns a bar for the CURRENT session as soon as it exists — pre-market, mid-session, or
 * as a stale carry-forward. On the first test run it returned a 2026-08-17 bar for GDX hours
 * before the US market opened. Publishing that as a close is exactly the weekend-tick error this
 * file was built to prevent, so any bar whose session has not verifiably ended is dropped and
 * reported in `dropped[]` rather than silently trimmed.
 */
const fs = require('fs'), path = require('path'), https = require('https');

// exchange → [close hour, close minute] in that exchange's local zone, and the zone itself.
const EXCH = {
  US:  { tz: 'America/New_York', close: [16, 0] },
  HK:  { tz: 'Asia/Hong_Kong',   close: [16, 0] },
  SG:  { tz: 'Asia/Singapore',   close: [17, 0] },
  JP:  { tz: 'Asia/Tokyo',       close: [15, 30] },
  KR:  { tz: 'Asia/Seoul',       close: [15, 30] },
  FUT: { tz: 'America/New_York', close: [17, 0] },  // CME/ICE settlement window
  CRYPTO: { tz: 'UTC', close: null },               // never closes; today's bar is a LEVEL
};

// FUTURES ARE NOT TRUSTWORTHY ON THIS FEED — established empirically on 19 Aug 2026.
// Gold front-month returned daily volumes of 673-3,609 (real COMEX gold trades six figures);
// Brent and WTI returned IDENTICAL volumes on two different sessions, a carry-forward artifact;
// and a contract roll silently rewrote Monday's gold close from 4,479.50 to 4,417.80 after it had
// already been published as a breakout. ETFs cannot roll and trade millions of shares a day, so
// every metals/energy PERCENTAGE the brief quotes should come from the proxy, not the future.
// Futures are retained for level context only, and flagged `trust:'low'` when volume is implausible.
const PROXY = { 'GC=F': 'GLD', 'SI=F': 'SLV', 'BZ=F': 'USO', 'CL=F': 'USO' };
const MIN_PLAUSIBLE_VOL = { 'GC=F': 50000, 'SI=F': 20000, 'BZ=F': 50000, 'CL=F': 100000 };

// The book, plus the benchmarks the brief actually quotes.
const UNIVERSE = [
  // US indices
  ['^GSPC', 'S&P 500', 'US'], ['^IXIC', 'Nasdaq Composite', 'US'],
  ['^DJI', 'Dow Jones', 'US'], ['^RUT', 'Russell 2000', 'US'], ['^VIX', 'VIX', 'US'],
  // Asia indices
  ['^HSI', 'Hang Seng', 'HK'], ['^N225', 'Nikkei 225', 'JP'],
  ['^KS11', 'KOSPI', 'KR'], ['^STI', 'Straits Times', 'SG'],
  // metals + miners (the levered leg and its complex)
  ['SLV', 'iShares Silver', 'US'], ['GLD', 'SPDR Gold', 'US'],
  ['SI=F', 'Silver front-month', 'FUT'], ['GC=F', 'Gold front-month', 'FUT'],
  ['GDX', 'Gold Miners ETF', 'US'], ['SILJ', 'Junior Silver', 'US'], ['SLVP', 'Silver Miners', 'US'],
  ['NEM', 'Newmont', 'US'], ['GOLD', 'Barrick', 'US'], ['PAAS', 'Pan American Silver', 'US'],
  ['AG', 'First Majestic', 'US'], ['HL', 'Hecla', 'US'],
  // energy
  ['BZ=F', 'Brent front-month', 'FUT'], ['CL=F', 'WTI front-month', 'FUT'],
  ['USO', 'US Oil Fund', 'US'], ['XLE', 'Energy Select', 'US'],
  // HK tech holdings
  ['0700.HK', 'Tencent', 'HK'], ['1810.HK', 'Xiaomi', 'HK'], ['0981.HK', 'SMIC', 'HK'],
  // SGX holdings
  ['D05.SI', 'DBS', 'SG'], ['O39.SI', 'OCBC', 'SG'], ['Z74.SI', 'Singtel', 'SG'],
  ['C09.SI', 'City Developments', 'SG'], ['U14.SI', 'UOL', 'SG'], ['W05.SI', 'Wing Tai', 'SG'],
  ['K71U.SI', 'Keppel REIT', 'SG'], ['M44U.SI', 'Mapletree Logistics', 'SG'],
  ['ME8U.SI', 'Mapletree Industrial', 'SG'], ['N2IU.SI', 'Mapletree Pan Asia Comm', 'SG'],
  // rare earths + crypto
  ['MP', 'MP Materials', 'US'], ['LYC.AX', 'Lynas', 'US'], ['UUUU', 'Energy Fuels', 'US'],
  ['BTC-USD', 'Bitcoin', 'CRYPTO'],
];

const get = url => new Promise((res, rej) => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(r.headers.location).then(res, rej);
    let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
  }).on('error', rej);
});

// Wall-clock "now" in a named zone, as {y,m,d,hh,mm} — no external date library.
function nowIn(tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hh: +p.hour, mm: +p.minute };
}

// Has the session dated `barDate` finished on this exchange?
function sessionComplete(barDate, exch) {
  const e = EXCH[exch];
  if (!e.close) return false;                       // crypto: today's bar is always a live level
  const n = nowIn(e.tz);
  if (barDate < n.date) return true;                // an earlier calendar day — closed
  if (barDate > n.date) return false;               // future-dated — never trust
  return (n.hh * 60 + n.mm) >= (e.close[0] * 60 + e.close[1]);
}

async function fetchOne(sym, exch, range = '1mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;
  const r = await get(url);
  if (r.status !== 200) return { error: `HTTP ${r.status}` };
  let j; try { j = JSON.parse(r.body); } catch { return { error: 'unparseable JSON' }; }
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) return { error: (j.chart && j.chart.error && j.chart.error.description) || 'no data' };
  const q = res.indicators.quote[0];
  const tz = res.meta.exchangeTimezoneName || EXCH[exch].tz;
  const bars = [], dropped = [];
  res.timestamp.forEach((t, i) => {
    if (q.close[i] == null) return;
    // Date the bar in the EXCHANGE's zone, not the runner's — otherwise Asian sessions
    // shift by a day when this runs from Singapore against a US-stamped epoch.
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(t * 1000));
    const bar = { d, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] };
    if (exch === 'CRYPTO') {
      // Crypto has no close, so a same-day bar is legitimate — but it is a LEVEL, not a close,
      // and must never be published with settlement language. Keep it; label it.
      const today = nowIn('UTC').date;
      bars.push(d >= today ? { ...bar, partial: true, label: 'live level (crypto never closes) — not a close' } : bar);
    } else if (sessionComplete(d, exch)) bars.push(bar);
    else dropped.push({ ...bar, why: 'session not yet complete — live/partial bar, not a close' });
  });
  return { bars, dropped, currency: res.meta.currency, tz };
}

async function main() {
  const out = { generated: new Date().toISOString(), source: 'Yahoo Finance chart API (keyless)', instruments: {}, errors: {}, dropped: {} };
  for (const [sym, name, exch] of UNIVERSE) {
    try {
      const r = await fetchOne(sym, exch);
      if (r.error) { out.errors[sym] = r.error; continue; }
      const b = r.bars.slice(-12);
      if (!b.length) { out.errors[sym] = 'no completed sessions returned'; continue; }
      const withChg = b.map((x, i) => i === 0 ? { ...x, chg: null, pct: null }
        : { ...x, chg: +(x.c - b[i - 1].c).toFixed(6), pct: +(((x.c / b[i - 1].c) - 1) * 100).toFixed(4) });
      out.instruments[sym] = { name, exchange: exch, currency: r.currency, bars: withChg };
      if (r.dropped.length) out.dropped[sym] = r.dropped;
    } catch (e) { out.errors[sym] = e.message; }
    await new Promise(r => setTimeout(r, 90));   // be polite; this is an unauthenticated endpoint
  }
  // NOTE: the file is written ONCE, at the end. An earlier version wrote it here as well, which
  // silently defeated the revision detector below — by the time it read the "previous" run it was
  // reading the file this line had just overwritten, so every diff compared today with itself and
  // reported zero revisions forever. The detector was added to catch a wrong published gold price
  // and, on its first run, could not have caught it.
  // Tag every futures instrument with a trust level and point at its roll-immune proxy, so a
  // consumer cannot accidentally quote a thin future as if it were the market.
  for (const [sym, inst] of Object.entries(out.instruments)) {
    if (inst.exchange !== 'FUT') continue;
    const floor = MIN_PLAUSIBLE_VOL[sym] || 10000;
    const recent = inst.bars.slice(-5).map(b => b.v || 0);
    const median = recent.slice().sort((a, b) => a - b)[Math.floor(recent.length / 2)] || 0;
    inst.proxy = PROXY[sym] || null;
    inst.trust = median >= floor ? 'ok' : 'low';
    if (inst.trust === 'low') {
      inst.trustNote = `median recent volume ${median} is below the ${floor} plausibility floor for this contract — ` +
        `the series is probably a rolled or back-month contract. Quote ${inst.proxy || 'an ETF proxy'} for percentage moves instead.`;
    }
  }

  // ── REVISION DETECTOR + THIN-BAR GATE (added 19 Aug 2026) ────────────────────────────────
  // On 18 Aug this spine reported Monday's front-month gold close as 4,479.50 (high 4,486.50,
  // volume 4,739) and the brief published "gold broke out to a new high and held it". Re-read the
  // next morning, the SAME Monday bar was 4,417.80 (high 4,428.50, volume 673). The contract had
  // rolled: the "front-month" symbol pointed at a different contract, and the old bar was left
  // illiquid. The clean control — GLD, which cannot roll — rose 1.00% on Monday, agreeing with
  // the revised 0.85% and refuting the 2.26% that was published. A wrong call reached the owner.
  //
  // Two defences, because either alone would have missed it:
  //   (a) THIN-BAR GATE — futures bars with implausibly low or zero volume are not real session
  //       prints. Silver bars carried volume 0 on two consecutive days and were still published.
  //   (b) REVISION DETECTOR — diff every historical bar against the previous run and shout when
  //       one changes. Prices for a CLOSED session must never move; if one does, the series has
  //       been re-based and anything already published off it is suspect.
  const PRIOR = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','.prices.json'),'utf8')); } catch (_) { return null; } })();
  out.revisions = []; out.thinBars = [];
  for (const [sym, inst] of Object.entries(out.instruments)) {
    // (a) thin bars — only meaningful where a volume field is genuinely populated
    if (inst.exchange === 'FUT') {
      for (const b of inst.bars) {
        if (b.v === 0 || b.v == null) out.thinBars.push({ sym, d: b.d, v: b.v, why: 'zero/absent volume — not a real session print' });
        else if (b.v < 100) out.thinBars.push({ sym, d: b.d, v: b.v, why: 'implausibly thin for a front-month future — likely a rolled or back-month contract' });
      }
    }
    // (b) revisions against the prior run
    const prev = PRIOR && PRIOR.instruments && PRIOR.instruments[sym];
    if (!prev) continue;
    const pmap = {}; (prev.bars || []).forEach(b => pmap[b.d] = b);
    for (const b of inst.bars) {
      const o = pmap[b.d];
      if (!o || o.partial || b.partial) continue;
      const moved = Math.abs(o.c - b.c) > Math.max(0.005, Math.abs(o.c) * 0.0005);
      if (moved) out.revisions.push({ sym, d: b.d, was: o.c, now: b.c,
        pctMoved: +(((b.c / o.c) - 1) * 100).toFixed(3), volWas: o.v, volNow: b.v });
    }
  }

  // Per-exchange latest COMPLETED bar. Surfaces source lag explicitly instead of letting it look
  // like a market holiday. Measured 18 Aug 00:40 SGT: Yahoo had no Monday 17 Aug daily bar for ANY
  // Asian instrument — not withheld as incomplete, simply absent ~8h after the Hong Kong close.
  // Asian daily bars consolidate late, so a pre-dawn SGT run can legitimately be a session behind.
  out.latestByExchange = {};
  for (const [sym, inst] of Object.entries(out.instruments)) {
    const last = inst.bars.filter(b => !b.partial).map(b => b.d).sort().pop();
    const e = inst.exchange;
    if (last && (!out.latestByExchange[e] || last > out.latestByExchange[e])) out.latestByExchange[e] = last;
  }
  fs.writeFileSync(path.join(__dirname, '..', 'data', '.prices.json'), JSON.stringify(out, null, 2) + '\n');

  const n = Object.keys(out.instruments).length, e = Object.keys(out.errors).length,
        d = Object.values(out.dropped).reduce((a, x) => a + x.length, 0);
  console.log(`price spine: ${n} instruments, ${e} error(s), ${d} incomplete bar(s) dropped → data/.prices.json`);
  console.log('  latest completed bar by exchange: ' +
    Object.entries(out.latestByExchange).map(([k, v]) => `${k} ${v}`).join(' · '));
  if (out.revisions.length) {
    console.log(`  !! ${out.revisions.length} REVISED historical bar(s) — a closed session changed price:`);
    out.revisions.slice(0, 12).forEach(r =>
      console.log(`     ${r.sym} ${r.d}: ${r.was} -> ${r.now} (${r.pctMoved > 0 ? '+' : ''}${r.pctMoved}%), volume ${r.volWas} -> ${r.volNow}`));
    console.log('     Anything already PUBLISHED off the old values must be re-checked.');
  }
  const lowTrust = Object.entries(out.instruments).filter(([, i]) => i.trust === 'low');
  if (lowTrust.length) {
    console.log('  !! LOW-TRUST futures series (quote the ETF proxy instead): ' +
      lowTrust.map(([k, i]) => `${k} -> ${i.proxy}`).join(' · '));
  }
  if (out.thinBars.length) {
    const byS = {}; out.thinBars.forEach(t => (byS[t.sym] = byS[t.sym] || []).push(t.d));
    console.log('  ~~ thin/zero-volume futures bars (do NOT publish as session prints): ' +
      Object.entries(byS).map(([k, v]) => `${k} [${v.join(', ')}]`).join(' · '));
  }
  if (e) Object.entries(out.errors).forEach(([k, v]) => console.log(`  ! ${k}: ${v}`));
  if (d) Object.entries(out.dropped).forEach(([k, v]) => v.forEach(x => console.log(`  ~ ${k} ${x.d} dropped (${x.why})`)));
}

if (require.main === module) main();
module.exports = { fetchOne, sessionComplete };
