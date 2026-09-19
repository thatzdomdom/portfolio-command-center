#!/usr/bin/env node
/*
 * validate-all.js — verify EVERY published file before it reaches the dashboard.
 *
 * Requested 31 Jul 2026 ("please check all results that you extract and send")
 * after an insider item turned out to be a Dec-2020 article re-stamped with a
 * 2026 date. The price gate (validate-intel.js) covers asserted insider prices;
 * this covers the rest of the surface, mechanically:
 *
 *   news.json      dates not in the future / not stale-as-fresh; sources present
 *                  and document-level; every ticker resolvable
 *   model.json     probabilities in [0,1] and internally coherent with EV sign;
 *                  full universe present; asOf fresh
 *   market.json    Fear&Greed 0-100, breadth percentages 0-100, dates sane
 *   track.json     APPEND-ONLY — past snapshots must never change (rewriting
 *                  history would silently flatter the model's hit rate)
 *   investors.json 13F timing sanity (a quarter cannot be "current" before its
 *                  45-day deadline), stamp freshness
 *   brief.json     dated today, and consistent with model.json's regime
 *
 * Exit 0 clean · 2 warnings only · 1 something is wrong enough to block.
 * Report is written to data/.validation.json for the brief and the dashboard.
 */
const fs = require('fs'), path = require('path');
const D = path.join(__dirname, '..', 'data');
const J = f => { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch (e) { return null; } };
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const daysAgo = d => { const t = Date.parse(String(d).slice(0, 10)); return isNaN(t) ? null : Math.floor((Date.parse(today) - t) / 864e5); };

const problems = [], warnings = [], checks = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);
const ok = msg => checks.push(msg);
const isBareDomain = u => { try { const p = new URL(String(u)).pathname; return p === '' || p === '/'; } catch (_) { return true; } };
// Catch-all (phase 4, 12 Sep 2026): a crash anywhere below becomes a FAIL line and the report is
// still written (writeReport is hoisted). Exit 1 either way — publish.js stays red.
process.on('uncaughtException', e => { fail('validate-all', `crashed: ${String((e && e.message) || e).slice(0, 120)}`); try { writeReport(); } catch (_) {} process.exit(1); });

// ── news.json ──────────────────────────────────────────────────────────────
const news = J('news.json');
if (!news) fail('news.json', 'missing or unparseable');
else {
  const items = news.items || [];
  let future = 0, stale = 0, noSrc = 0, bareSrc = 0;
  items.forEach(n => {
    const a = daysAgo(n.date);
    if (a == null) { warn('news.json', `item has an unparseable date: "${n.headline || ''}".slice(0,60)`); return; }
    if (a < 0) { future++; fail('news.json', `FUTURE-DATED item (${n.date}): ${String(n.headline).slice(0, 70)}`); }
    if (a > 14) stale++;
    const s = (n.sources || []).filter(Boolean);
    if (!s.length) noSrc++; else if (s.every(isBareDomain)) bareSrc++;
  });
  const freshest = items.map(n => daysAgo(n.date)).filter(x => x != null && x >= 0).sort((a, b) => a - b)[0];
  // Age the news against the latest COMPLETED trading session, not against the calendar.
  // (Added 2026-08-17: this rule fired on a correct Monday-morning catch-up. Written before
  // 09:00 SGT on a Monday, the newest close that CAN exist is Friday's — 3 calendar days old —
  // so a flat ">2 days" test fails every Monday and after every holiday. The bug was mine, and
  // silently padding news.json to satisfy it would have been the wrong fix.)
  // Derive the allowance from the SPINE's own most recent completed session rather than guessing
  // from the day of week. The first version hard-coded "Monday → 3 days", which is wrong the
  // moment a holiday lands (SGX shut for National Day on 10 Aug, JPX for Mountain Day on the
  // 11th) and wrong again after midnight SGT, when Asia has closed but the US has not. The spine
  // already knows exactly which sessions completed, so ask it instead of re-deriving a calendar.
  let allowance = 2, basis = 'default';
  try {
    const spine = JSON.parse(fs.readFileSync(path.join(D, '.prices.json'), 'utf8'));
    // Exclude PARTIAL bars AND crypto entirely. Crypto never closes, so it always has the newest
    // bar — first it was Bitcoin's live same-day level, then its Sunday bar — and neither says
    // anything about whether an equity session has closed that the news sweep ought to cover.
    const lastBar = Object.values(spine.instruments || {})
      .filter(i => i.exchange !== 'CRYPTO')
      .flatMap(i => (i.bars || []).filter(b => !b.partial).map(b => b.d))
      .sort().pop();
    if (lastBar) { allowance = Math.max(0, daysAgo(lastBar)); basis = `latest completed session ${lastBar}`; }
  } catch (_) { /* no spine — fall back to the conservative default */ }
  if (freshest == null) fail('news.json', 'no validly dated items at all');
  else if (freshest > allowance) fail('news.json', `newest item is ${freshest} days old but a session has closed since (${basis}) — the sweep is behind`);
  else ok(`news: ${items.length} items, newest ${freshest === 0 ? 'today' : freshest + 'd old'} (${basis})`);
  if (stale) warn('news.json', `${stale} item(s) older than 14 days still published`);
  if (noSrc) fail('news.json', `${noSrc} item(s) cite no source at all`);
  if (bareSrc) warn('news.json', `${bareSrc} item(s) cite only homepage-level URLs (no specific article)`);
}

// ── model.json ─────────────────────────────────────────────────────────────
const model = J('model.json');
if (!model) fail('model.json', 'missing or unparseable');
else {
  const calls = model.calls || [];
  let badProb = 0, incoherent = 0;
  calls.forEach(c => {
    ['pUp1m', 'pUp3m', 'pUp12m'].forEach(k => { const v = c[k]; if (v != null && (v < 0 || v > 1)) { badProb++; fail('model.json', `${c.ticker} ${k}=${v} is not a probability`); } });
    // a call cannot say "more likely up than not" while expecting a loss, or vice versa
    if (c.pUp3m != null && c.ev3m != null) {
      const bull = c.pUp3m > 0.55, bear = c.pUp3m < 0.45;
      if ((bull && c.ev3m < -0.02) || (bear && c.ev3m > 0.02)) { incoherent++; warn('model.json', `${c.ticker}: pUp3m ${c.pUp3m} vs ev3m ${c.ev3m} point opposite ways`); }
    }
  });
  if (!badProb) ok(`model: ${calls.length} calls, all probabilities in range`);
  if (incoherent) warn('model.json', `${incoherent} call(s) have probability/EV disagreeing in sign`);
  const a = daysAgo(model.macro && model.macro.asOf);
  if (a == null) warn('model.json', 'macro.asOf missing/unparseable');
  else if (a > 3) fail('model.json', `macro commentary stamped ${a} days ago — it is being served as current`);
  else ok(`model: macro re-stamped ${a === 0 ? 'today' : a + 'd ago'}`);
}

// ── market.json ────────────────────────────────────────────────────────────
const market = J('market.json');
if (!market) fail('market.json', 'missing or unparseable');
else {
  const fg = market.fearGreed || {};
  [['value', fg.value], ['cryptoValue', fg.cryptoValue]].forEach(([k, v]) => {
    if (v != null && (v < 0 || v > 100)) fail('market.json', `fearGreed.${k}=${v} outside 0-100`);
  });
  (market.breadth && market.breadth.metrics || []).forEach(m => {
    if (m.pct != null && (m.pct < 0 || m.pct > 100)) fail('market.json', `breadth "${String(m.label).slice(0, 40)}" pct=${m.pct} outside 0-100`);
  });
  const a = daysAgo(market.updated);
  if (a != null && a > 3) fail('market.json', `sentiment/breadth stamped ${a} days ago`);
  else ok(`market: F&G ${fg.value ?? '—'}, stamps current`);
}

// ── track.json — APPEND-ONLY is the whole point ───────────────────────────
const track = J('track.json');
if (!track) warn('track.json', 'missing');
else {
  const snaps = track.snapshots || [];
  const dates = snaps.map(s => s.date);
  const sorted = [...dates].sort();
  if (dates.join() !== sorted.join()) fail('track.json', 'snapshots are not in chronological order — history may have been rewritten');
  const dupes = dates.filter((d, i) => dates.indexOf(d) !== i);
  if (dupes.length) fail('track.json', `duplicate snapshot dates: ${[...new Set(dupes)].join(', ')}`);
  // fingerprint history so a later rewrite of a PAST snapshot is detectable
  const FP = path.join(D, '.track-fingerprint.json');
  const fpNow = {};
  snaps.forEach(s => { if (s.date !== today) fpNow[s.date] = (s.calls || []).length + ':' + (s.calls || []).map(c => c.t + (c.p3 ?? '')).join('|').length; });
  const prev = (() => { try { return JSON.parse(fs.readFileSync(FP, 'utf8')); } catch (_) { return null; } })();
  if (prev) {
    const changed = Object.keys(prev).filter(d => fpNow[d] && fpNow[d] !== prev[d]);
    const vanished = Object.keys(prev).filter(d => !fpNow[d]);
    if (changed.length) fail('track.json', `PAST snapshot(s) altered: ${changed.join(', ')} — the model's hit rate is computed off these`);
    if (vanished.length) fail('track.json', `PAST snapshot(s) deleted: ${vanished.join(', ')}`);
    if (!changed.length && !vanished.length) ok(`track: ${snaps.length} snapshots, history intact`);
  } else ok(`track: ${snaps.length} snapshots, fingerprint baseline created`);
  fs.writeFileSync(FP, JSON.stringify(fpNow));
}

// ── investors.json ─────────────────────────────────────────────────────────
const inv = J('investors.json');
if (!inv) warn('investors.json', 'missing');
else {
  const a = daysAgo(inv.updated);
  if (a == null) warn('investors.json', 'no updated stamp');
  // Only a WARNING now, never a failure. (Changed 18 Aug 2026.) Failing on stamp age created a
  // perverse incentive: the cheapest way to pass was to bump `updated` without re-pulling any
  // filing, which is exactly what happened — the file carried a fresh 17 Aug stamp over Q1 data
  // from May. Staleness that matters is measured against the FILING CALENDAR below, not against
  // when a job last ran.
  else if (a > 3) warn('investors.json', `stamped ${a} days ago — re-verify (note: bumping this stamp is NOT a fix; the quarter check below is what matters)`);
  else ok(`investors: re-verified ${a === 0 ? 'today' : a + 'd ago'}`);

  // 13F QUARTER CHECK — BOTH DIRECTIONS.
  // The original only asked "is this quarter presented as current before its deadline?" It never
  // asked the question that actually caught us out: "has a NEWER quarter already passed its
  // deadline and become public while we are still showing the old one?" On 18 Aug 2026 it happily
  // printed "2026 Q1 is past its 13F deadline — legitimately current" while Q2 had been public
  // since Friday the 14th and Berkshire's Alphabet position had more than doubled inside it.
  const qEndOf = (q, y) => new Date(Date.UTC(y, q * 3, 0));           // last day of the quarter
  // The deadline ROLLS to the next weekday (phase 6, 13 Sep 2026). 2026 Q3's day 45 is Saturday 14 Nov
  // and EDGAR takes the filings on Monday 16 Nov; unrolled, this check called Q3 public over a weekend
  // on which no Q3 13F can exist yet, and would have failed the publish for correctly showing Q2.
  const dueOf  = (q, y) => { const d = new Date(qEndOf(q, y).getTime() + 45 * 864e5), w = d.getUTCDay(); return w === 6 ? new Date(d.getTime() + 2 * 864e5) : w === 0 ? new Date(d.getTime() + 864e5) : d; };
  // …and a quarter is public only from the SGT day AFTER that rolled deadline: at 07:02 SGT on the
  // deadline itself it is still the previous evening in New York, so no deadline-day 13F exists yet.
  const DAY_AFTER = 864e5;
  const cur = inv.convictionPlays && inv.convictionPlays.current;
  if (cur) {
    const m = /Q([1-4])\s*(\d{4})/.exec(cur) || /(\d{4})\s*Q([1-4])/.exec(cur);
    const qn = m ? (m[1].length === 4 ? +m[2] : +m[1]) : null;
    const yr = m ? (m[1].length === 4 ? +m[1] : +m[2]) : null;
    if (qn && yr) {
      const due = dueOf(qn, yr);
      if (Date.parse(today) < due.getTime() + DAY_AFTER) {
        fail('investors.json', `presents ${cur} as current, but those 13Fs are not due until ${due.toISOString().slice(0, 10)}`);
      } else {
        // Walk forward: is there a LATER quarter whose deadline has also passed?
        let nq = qn, ny = yr, newest = null;
        for (let i = 0; i < 8; i++) {
          nq++; if (nq > 4) { nq = 1; ny++; }
          if (Date.parse(today) >= dueOf(nq, ny).getTime() + DAY_AFTER) newest = `${ny} Q${nq}`; else break;
        }
        if (newest) {
          fail('investors.json', `shows ${cur} but ${newest} 13Fs are ALREADY PUBLIC (deadline passed) — the tables are a full quarter behind`);
        } else ok(`investors: ${cur} is the newest quarter whose 13F deadline has passed`);
      }
    }
  }
}

// ── flows-investors.json ───────────────────────────────────────────────────
// Cadences differ wildly by market (Korea daily, Japan/SG weekly, HK/CN/US
// proxies only), so this checks the two things that actually mislead: a stale
// period presented as current, and a proxy presented as a direct measurement.
const flows = J('flows-investors.json');
if (flows) {
  const ms = flows.markets || [];
  let noSrc = 0, bare = 0, unlabelled = 0;
  ms.forEach(m => {
    const s = (m.sources || []).filter(Boolean);
    if (!s.length) { noSrc++; fail('flows-investors.json', `${m.market}: no source cited`); }
    else if (s.every(isBareDomain)) bare++;
    // markets with no official split must not present figures as direct measurement
    if (m.available === false) {
      const direct = (m.flows || []).filter(f => !f.isProxy && !/southbound|connect/i.test(f.investorType || ''));
      if (direct.length) { unlabelled++; fail('flows-investors.json', `${m.market} has no official investor-type split, but ${direct.length} flow(s) are not marked isProxy`); }
    }
    const a = daysAgo(m.asOf);
    if (a != null && a > 21) warn('flows-investors.json', `${m.market} data is ${a} days old — check it is labelled as carried forward`);
  });
  if (bare) warn('flows-investors.json', `${bare} market(s) cite only homepage-level sources`);
  if (!noSrc && !unlabelled) ok(`flows: ${ms.length} markets, sources present, proxies labelled`);
  const a = daysAgo(flows.updated);
  if (a != null && a > 8) warn('flows-investors.json', `file stamp is ${a} days old`);
}

// ── brief.json ─────────────────────────────────────────────────────────────
const brief = J('brief.json');
if (!brief) warn('brief.json', 'missing');
else {
  const a = daysAgo(brief.date);
  if (a == null) fail('brief.json', 'no parseable date');
  else if (a > 0) fail('brief.json', `dated ${a} day(s) ago — the morning email would send stale content under today's date`);
  else ok('brief: written today');
  if (model && model.macro && brief.regime && brief.regime.label &&
      String(brief.regime.label).trim() && String(model.macro.regime).trim() &&
      brief.regime.label !== model.macro.regime) {
    warn('brief.json', `regime label "${brief.regime.label}" differs from model.json's "${model.macro.regime}"`);
  }
}

// ── PRICE RECONCILIATION GATE (added 17 Aug 2026) ──────────────────────────
// This replaces work that used to be done by one verification AGENT PER ITEM — roughly thirty
// agents on a busy day, each re-opening quote pages to check arithmetic, which is most of why a
// single daily run cost ~2.4M tokens. Arithmetic is not a research task. Every price an agent
// asserts is now checked in code against data/.prices.json (the deterministic spine), for free.
//
// The point is not only cost. An agent that "verifies" a number by reading another vendor page
// inherits that vendor's errors — which is exactly how a spot/CFD quote got published as a Brent
// exchange settle, and how OCBC carried two different Tuesday closes for days. Code comparing
// against one anchored series cannot make that mistake.
//
// Only claims that FAIL here need a human-or-agent look, so the expensive path is reserved for
// genuine disagreements instead of being paid on every item.
{
  const PF = path.join(D, '.prices.json');
  if (!fs.existsSync(PF)) {
    warn('prices', 'data/.prices.json missing — run `node scripts/price-spine.js` before validating');
  } else {
    // Phase 4: an unparseable spine used to crash the whole validator here (exit 1, no report
    // written, research-headless.sh's alarm then quoted YESTERDAY's report). It is a FAIL line now.
    let spine = null;
    try { spine = JSON.parse(fs.readFileSync(PF, 'utf8')); } catch (e) { fail('prices', `data/.prices.json is unparseable (${e.message.slice(0, 80)}) — re-run price-spine.js; no price claim was reconciled`); }
    if (spine) {
    const ageMin = Math.floor((Date.now() - Date.parse(spine.generated)) / 60000);
    if (ageMin > 24 * 60) warn('prices', `spine is ${Math.floor(ageMin / 60)}h old — re-run price-spine.js`);

    // Build "TICKER @ price" candidates out of the published prose. Deliberately conservative:
    // it only fires on a $/HK$/S$-prefixed number sitting near a ticker we actually track, so a
    // percentage or a share count is never mistaken for a price.
    const CUR = '(?:US\\$|HK\\$|S\\$|\\$)';
    const bySym = spine.instruments || {};
    const alias = { 'Tencent': '0700.HK', 'Xiaomi': '1810.HK', 'SMIC': '0981.HK', 'DBS': 'D05.SI',
      'OCBC': 'O39.SI', 'Singtel': 'Z74.SI', 'UOL': 'U14.SI', 'Keppel REIT': 'K71U.SI',
      'Newmont': 'NEM', 'Barrick': 'GOLD', 'Pan American': 'PAAS', 'MP Materials': 'MP',
      'Brent': 'BZ=F', 'WTI': 'CL=F', 'GDX': 'GDX', 'SILJ': 'SILJ', 'Bitcoin': 'BTC-USD' };

    let checked = 0, matched = 0; const mismatches = []; const lowTrustSkipped = new Set();
    const scan = (text, where) => {
      if (!text) return;
      for (const [name, sym] of Object.entries(alias)) {
        const inst = bySym[sym]; if (!inst) continue;
        // Never "confirm" a price against a series the spine itself distrusts. On 19 Aug the
        // futures feed was found to roll contracts and carry volumes forward, which had already
        // put a wrong gold close into a published brief. Reconciling against it would have
        // rubber-stamped the error. Skip and surface it instead of passing silently.
        if (inst.trust === 'low') { lowTrustSkipped.add(sym); continue; }
        const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^.!?]{0,80}?' + CUR + '\\s?([\\d,]+\\.?\\d*)', 'gi');
        let m;
        while ((m = re.exec(text)) !== null) {
          const claimed = parseFloat(m[1].replace(/,/g, ''));
          if (!isFinite(claimed) || claimed <= 0) continue;
          // Reject figures that are not share prices at all. The first version of this gate
          // flagged Barrick's "$1,993/oz" cost of sales and Pan American's "$305m" of net
          // earnings as bad prices, because both sit within 80 characters of the company name.
          // Two filters, in order of reliability:
          //   (a) an explicit unit right after the number (/oz, m, bn, per ounce…);
          //   (b) magnitude — a real price claim lives near the instrument's actual trading band.
          //       Anything outside 0.3x-3x of the recent range is a revenue, a cost, a market cap
          //       or a target, not a quote, so it is silently skipped rather than reported.
          const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
          if (/^\s*(?:\/|per\b|m\b|mn\b|bn\b|k\b|million|billion|trillion|%)/i.test(tail)) continue;
          const lows = inst.bars.map(b => b.l), highs = inst.bars.map(b => b.h);
          const lo = Math.min(...lows) * 0.3, hi = Math.max(...highs) * 3;
          if (claimed < lo || claimed > hi) continue;
          // A claim counts as reconciled if it matches ANY completed close in the window —
          // items legitimately quote several sessions, and highs/lows are quoted too.
          // "toward $108-109", "~$64", "about 4,400" are approximations, not asserted closes. On
          // 11 Sep a futures contract roll moved Brent's close 108.95 -> 107.63 after the brief had
          // said "toward $108-109"; 0.25% blocked the push over a rounded range. Widen to 1% ONLY
          // when the claim is explicitly approximate or a range; exact assertions keep 0.25%.
          const after = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
          const approx = /(toward|towards|about|near|around|roughly|circa|~)\s*(?:US\$|HK\$|S\$|\$)?\s*[\d,]+\.?\d*$/i.test(m[0]) || /^\s*[-–]\s*\d/.test(after);
          const rounded = !/\d\.\d/.test(m[0]);   // "at 107" is a rounded claim; "at 107.63" is an assertion
          const tol = (approx || rounded) ? 0.01 : 0.0025;
          const hit = inst.bars.some(b =>
            Math.abs(b.c - claimed) <= Math.max(0.011, b.c * tol) ||
            Math.abs(b.h - claimed) <= Math.max(0.011, b.h * tol) ||
            Math.abs(b.l - claimed) <= Math.max(0.011, b.l * tol));
          checked++;
          if (hit) matched++;
          else mismatches.push({ where, sym, claimed, near: inst.bars.slice(-4).map(b => b.c) });
        }
      }
    };
    (news.items || []).forEach((n, i) => { scan(n.summary, `news[${i}]`); scan(n.actionable, `news[${i}]`); });
    if (brief) { (brief.tldr || []).forEach((t, i) => scan(t, `brief.tldr[${i}]`)); (brief.signals || []).forEach((t, i) => scan(t, `brief.signals[${i}]`)); }
    if (model && model.macro) scan(model.macro.narrative, 'model.macro.narrative');

    if (lowTrustSkipped.size) {
      warn('prices', `skipped reconciliation for low-trust series (${[...lowTrustSkipped].join(', ')}) — the spine flags these as rolled/thin; quote the ETF proxy instead`);
    }
    if (!checked) ok('prices: spine loaded; no ticker-anchored price claims to reconcile');
    else if (!mismatches.length) ok(`prices: ${matched}/${checked} asserted prices reconcile against the spine`);
    else {
      mismatches.slice(0, 6).forEach(x =>
        fail('prices', `${x.where} asserts ${x.sym} at ${x.claimed}, which matches no traded close/high/low (recent closes: ${x.near.map(v => +Number(v).toFixed(4)).join(', ')})`));
      if (mismatches.length > 6) fail('prices', `…and ${mismatches.length - 6} more unreconciled price claim(s)`);
    }
    }
  }
}

// ── PHASE 1 GUARDS (added 11 Sep 2026) ──────────────────────────────────────
// (a) book.json ↔ index.html parity. During the parallel week the HTML keeps its own copy of the
//     holdings and keeps rendering from it. Two copies of the same truth WILL drift unless a gate
//     fails on the first divergence — so this compares every id/ticker/qty/book/manual mark.
// (b) sensitive plaintext must never be tracked. book.json and valuation.json carry cash balances,
//     property marks and the margin loan; only their .enc envelopes may be committed.
// (c) manifest.json should be today's; warn (not fail) because publish.js writes it last.
{
  const book = J('book.json');
  if (!book) warn('book.json', 'absent — run scripts/extract-book.js (phase 1)');
  else {
    try {
      const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').split('\n');
      const fromHtml = {};
      html.forEach(ln => {
        if (!/^\s*\{id:\s*\d+\s*,.*\}\s*,?\s*(\/\/.*)?$/.test(ln)) return;
        const lit = ln.trim().replace(/,\s*(\/\/.*)?$/, '').replace(/\/\/.*$/, '');
        const o = new Function('return ' + lit)();
        fromHtml[o.id] = { t: o.t, yf: o.yf ?? null, qty: o.qty ?? null, book: o.book ?? null, manualNative: o.manualNative ?? null };
      });
      const diffs = [];
      for (const h of book.holdings) {
        const x = fromHtml[h.id];
        if (!x) { diffs.push(`id ${h.id} (${h.t}) in book.json but not in index.html`); continue; }
        for (const k of ['t', 'yf', 'qty', 'book', 'manualNative']) {
          const a = h[k] ?? null, b = x[k] ?? null;
          if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`id ${h.id} ${h.t}: ${k} book.json=${a} html=${b}`);
        }
      }
      const htmlIds = Object.keys(fromHtml).map(Number), bookIds = new Set(book.holdings.map(h => h.id));
      htmlIds.filter(i => !bookIds.has(i)).forEach(i => diffs.push(`id ${i} (${fromHtml[i].t}) in index.html but not in book.json`));
      if (diffs.length) { diffs.slice(0, 6).forEach(d => fail('book.json', `DRIFT vs index.html — ${d}`)); if (diffs.length > 6) fail('book.json', `…and ${diffs.length - 6} more`); }
      else ok(`book: ${book.holdings.length} holdings match index.html exactly`);
    } catch (e) { warn('book.json', `parity check could not run: ${e.message}`); }
  }
  const { spawnSync } = require('child_process');
  // Same list as publish.js PRIVATE and .gitignore (phase 4 added the write path's files).
  const PLAINTEXT = ['data/book.json', 'data/valuation.json', 'data/.prices-2y.json', 'data/.credentials.json',
    'data/journal.json', 'data/journal.ndjson', 'data/oneaction.json', 'data/.oneaction-history.ndjson',
    'data/.state-history.ndjson', 'data/.publish-history.ndjson', 'data/.tickers.json', 'data/.cutover.json',
    'data/.last-brief-at', 'data/.last-brief-date'];
  let tracked = null;
  try {
    const g = spawnSync('git', ['ls-files', '--', ...PLAINTEXT], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    if (g.error) throw g.error;
    tracked = (g.stdout || '').trim();
  } catch (e) { fail('git', `could not run git ls-files (${String(e.message || e).slice(0, 60)}) — the plaintext guard did not run`); }
  if (tracked) fail('git', `sensitive PLAINTEXT is tracked: ${tracked.replace(/\n/g, ', ')} — must be gitignored; only .enc envelopes may be committed`);
  else if (tracked === '') ok('git: no sensitive plaintext tracked');
  const man = J('manifest.json');
  if (!man) warn('manifest.json', 'absent — publish.js writes it');
  else if (man.sgtDate !== today) warn('manifest.json', `sgtDate ${man.sgtDate} ≠ today ${today} (publish has not run yet today)`);
  else ok(`manifest: ${Object.keys(man.files || {}).length} files, sgtDate today`);
}

// ── PHASE 2: the signal feed must be alive, not merely present ─────────────
{
  const sig = J('signals.json'), al = J('alerts.json');
  if (!sig) warn('signals.json', 'absent — form4-scan.js has not run (GitHub Actions or launchd)');
  else {
    const last = (sig.scans || []).filter(x => !x.error).slice(-1)[0];   // freshness from the last scan that actually read an index
    const a = last ? daysAgo(last.date) : null;
    if (a == null) warn('signals.json', 'no scan log');
    else if (a > 4) fail('signals.json', `last EDGAR scan is ${a} days old — the market-wide insider feed is DEAD, not quiet`);
    else if (last.form4Lines === 0 && !last.error) warn('signals.json', `scan ${last.date} saw ZERO Form 4 lines — a weekday index with no filings is a fetch problem, not a quiet day`);
    else ok(`signals: last scan ${last.date} · ${last.form4Lines || 0} Form 4 lines · ${(sig.form4 || []).length} facts retained`);
  }
  if (!al) warn('alerts.json', 'absent — alerts.js has not run');
  else { const a = daysAgo(String(al.generatedAt || '').slice(0, 10)); if (a != null && a > 2) warn('alerts.json', `not re-evaluated for ${a} days`); else ok(`alerts: ${(al.alerts || []).length} in the log · ${(al.alerts || []).filter(x => x.severity === 'Notable').length} Notable`); }
}

// ── PHASE 3: the technical layer must be current ───────────────────────────
{
  // Phase 4: a technicals.json without `summary` or a targets.json without `clusters` used to throw
  // here — exit 1 with NO report written. Malformed is a FAIL line, and the report still lands.
  const T = J('technicals.json');
  if (!T) warn('technicals.json', 'absent — technicals.js has not run');
  else if (!T.summary || typeof T.summary !== 'object') fail('technicals.json', 'malformed — no `summary` block (technicals.js did not finish); the trend gate cannot be trusted this run');
  else { const a = daysAgo(T.asOf); if (a != null && a > 4) fail('technicals.json', `trend gate is ${a} days old — stale gate, stale risk block`); else ok(`technicals: ${T.summary.instruments} instruments · gate ON ${T.summary.gateOn} / OFF ${T.summary.gateOff} · as of ${T.asOf}`); }
  const G = J('targets.json');
  if (G && !Array.isArray(G.clusters)) fail('targets.json', 'malformed — no `clusters` array (targets.js did not finish)');
  else if (G) ok(`targets (shadow): ${G.eligible}/${G.universe} eligible · top cluster ${(G.clusters[0] || {}).name || '—'} ${G.clusters[0] ? (G.clusters[0].actualRiskShare * 100).toFixed(0) + '%' : ''} of risk`);
}

// ── PHASE 5: the pages themselves must be structurally sound ───────────────
// (added 13 Sep 2026) The three new surfaces — today.html, book.html, inbox.html — and the
// pcc.css/common.js contract under them. scripts/validate-pages.js holds the rules (zero external
// calls, unique ids, today.html ≡ the email's block order, nothing fetched that publish.js does not
// publish, no data through innerHTML) and returns lines rather than printing, so they land in
// .validation.json with everything else. A page that does not exist yet WARNS; the checker failing
// to run WARNS too — a bug in a structure test must never be the reason the 07:02 publish stops.
{
  try {
    const { validatePages } = require('./validate-pages.js');
    const r = validatePages({ root: path.join(__dirname, '..') });
    r.problems.forEach(p => fail(p.file, p.msg));
    r.warnings.forEach(w => warn(w.file, w.msg));
    r.passed.forEach(c => ok(c));
  } catch (e) { warn('validate-pages', `did not run: ${String((e && e.message) || e).slice(0, 120)}`); }
}

// ── PHASE 6: 13F from EDGAR, in code ───────────────────────────────────────
// (added 13 Sep 2026) scripts/13f-scan.js (GitHub Actions, 06:15 SGT) reads the tracked funds' filings
// into data/13f.json; investors-compat.js copies them into investors.json. Three questions, each one a
// failure this pipeline has already had: is the feed ALIVE (a scan that stopped reads exactly like a
// quiet quarter — the 8–11 Sep Form 4 lesson); did EDGAR get a quarter we did NOT ingest (the 18 Aug
// lesson, now asked per fund against EDGAR itself rather than against the calendar); does every stored
// table add up to its own cover page. A fund that simply has not filed is THEIR lateness and only warns.
// funds.json is the authority on status — the scan's inference only warns. Wrapped: a bug in this block
// warns; it is never, on its own, the reason the 07:02 publish stops.
{
  try {
    const F13 = J('13f.json');
    if (!F13) {
      if (fs.existsSync(path.join(D, '13f.json'))) fail('13f.json', 'unparseable — the 13F tables, and every page that reads them, are broken this run');
      else warn('13f.json', 'absent — 13f-scan.js has not run (GitHub Actions)');
    } else {
      const sgtOf = iso => { const t = Date.parse(iso); return isNaN(t) ? null : new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); };
      const qLabel = p => `${String(p).slice(0, 4)} Q${Math.ceil(+String(p).slice(5, 7) / 3)}`;
      // quarter end + 45 days, rolled off a weekend — the rule 13f-scan.js's deadlineFor uses
      const rolledDue = p => { const d = new Date(p + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 45); const w = d.getUTCDay(); if (w === 6) d.setUTCDate(d.getUTCDate() + 2); else if (w === 0) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
      // the newest quarter end whose ROLLED deadline is today or earlier
      let qy = +today.slice(0, 4), qm = Math.ceil(+today.slice(5, 7) / 3) * 3;
      const qEnd = () => new Date(Date.UTC(qy, qm, 0)).toISOString().slice(0, 10);
      let passed = qEnd();
      // a quarter counts as passed only from the SGT day after its rolled deadline (see DAY_AFTER above)
      while (passed > today || rolledDue(passed) >= today) { qm -= 3; if (qm <= 0) { qm += 12; qy--; } passed = qEnd(); }

      const checked = sgtOf(F13.scan && F13.scan.checkedAt), age = checked ? daysAgo(checked) : null;
      if (age == null) fail('13f.json', 'no scan.checkedAt — a live 13F feed cannot be told from a dead one');
      else if (age > 3) fail('13f.json', `last EDGAR check is ${age} days old (${checked}) — the 13F feed is DEAD, not quiet`);
      else ok(`13f: last EDGAR check ${checked} (${age === 0 ? 'today' : age + 'd ago'})`);
      const errs = F13.scan && Array.isArray(F13.scan.errors) ? F13.scan.errors : [];
      if (errs.length) warn('13f.json', `last scan recorded ${errs.length} error(s) — ${errs.slice(0, 3).map(e => `${e.fund || '?'} ${e.stage || ''}: ${String(e.message || '').slice(0, 60)}`).join('; ')} (each fund keeps its last good table)`);

      const declared = {};
      (((J('funds.json') || {}).funds) || []).forEach(x => { if (x && x.id) declared[x.id] = x; });
      const unrec = [];
      let tables = 0, active = 0, current = 0;
      for (const [id, f] of Object.entries(F13.funds || {})) {
        const name = f.name || id, status = (declared[id] && declared[id].status) || f.status;
        // every stored table — latest, prior and history — whatever the fund's status
        const periods = new Map();
        for (const r of [f.latest, f.prior, ...(Array.isArray(f.history) ? f.history : [])]) {
          if (!r || !r.period) continue;
          const p = periods.get(r.period) || { quarter: r.quarter || qLabel(r.period), bad: false, why: null };
          if (r.reconciled === false) { p.bad = true; p.why = p.why || (r.filings || []).filter(x => x && x.inTable !== false).flatMap(x => x.why || [])[0] || null; }
          periods.set(r.period, p);
        }
        tables += periods.size;
        for (const p of periods.values()) if (p.bad) unrec.push(`${name} ${p.quarter}${p.why ? ` (${p.why})` : ''}`);
        if (f.proposedCik && f.proposedCik.cik) warn('13f.json', `${name}: add CIK ${f.proposedCik.cik} (${f.proposedCik.name || 'unnamed filer'}) to funds.json${f.proposedCik.period ? ` — it reported ${qLabel(f.proposedCik.period)} for this fund` : ''}`);
        if (status !== 'active') continue;
        active++;
        const lp = f.latest && f.latest.period, ep = f.edgarLatestPeriod;
        if (ep && (!lp || ep > lp)) { fail('13f.json', `${name} filed ${qLabel(ep)} on EDGAR but it is not ingested`); continue; }
        if (f.pendingNotice) warn('13f.json', `${name}: a 13F-NT for ${f.pendingNotice.quarter} is on EDGAR (filed ${f.pendingNotice.filed || '?'}) but the reporting manager's holdings are not posted yet — normal for hours on a deadline day`);
        if (f.inferredStatus === 'stopped') { warn('13f.json', `${name}: nothing on EDGAR after ${ep ? qLabel(ep) : 'any period'}${f.missedDeadlines != null ? ` (${f.missedDeadlines} deadlines missed)` : ''} — the scan infers STOPPED but funds.json says active; the owner decides`); continue; }
        if (!lp || lp < passed) warn('13f.json', `${name} has not filed ${qLabel(passed)} — their lateness, not ours`);
        else current++;
      }
      unrec.slice(0, 6).forEach(u => fail('13f.json', `${u} does not reconcile to its own cover page — its figures cannot be trusted`));
      if (unrec.length > 6) fail('13f.json', `…and ${unrec.length - 6} more stored 13F table(s) that do not reconcile`);
      if (!unrec.length) ok(`13f: all ${tables} stored tables reconcile to their cover pages`);
      if (active && current === active) ok(`13f: all ${active} active tracked funds current through ${qLabel(passed)} (rolled deadline ${rolledDue(passed)})`);
      const integ = Array.isArray(F13.integrity) ? F13.integrity : [];
      integ.slice(0, 6).forEach(x => warn('13f.json', `units cross-check ${x.quarter || ''} ${x.ticker || x.cusip}: price per share differs ×${x.ratio} across ${(x.funds || []).map(g => `${g.fund} $${g.pricePerShare}`).join(' vs ')} — one filer's units or shares are probably wrong`));
      if (integ.length > 6) warn('13f.json', `…and ${integ.length - 6} more units cross-check disagreement(s)`);
    }
  } catch (e) { warn('13f.json', `PHASE 6 check did not run: ${String((e && e.message) || e).slice(0, 120)}`); }
}

// ── PHASE 7: HKEX disclosure of interests ──────────────────────────────────
// (added 19 Sep 2026) scripts/hkex-di.js (GitHub Actions, 06:45 SGT) reads di.hkex.com.hk's notices
// table for the book's HK codes into data/hkex.json; alerts.js judges it against policy.hkex.
//
// LIVENESS IS JUDGED ON THE SCAN, NEVER ON THE ROW COUNT. This feed is genuinely quiet: across all
// three HK names over the 90 days to 19 Sep 2026 there was exactly one purchase and one sale, and a
// normal 7-day window returns nothing at all. "No filings" is therefore the usual healthy answer,
// and a test on filings.length would declare a working feed dead most weeks — the 8–11 Sep Form 4
// lesson pointing the other way. What must not happen is the scan silently stopping, or quietly
// covering fewer codes than the book holds, and both of those are visible in the scan log.
// Wrapped: a bug in this block warns; it is never, on its own, the reason the 07:02 publish stops.
{
  try {
    const HK = J('hkex.json');
    if (!HK) {
      if (fs.existsSync(path.join(D, 'hkex.json'))) fail('hkex.json', 'unparseable — the HK insider rows, and every page that reads them, are broken this run');
      else warn('hkex.json', 'absent — hkex-di.js has not run (GitHub Actions)');
    } else {
      const sgtOf = iso => { const t = Date.parse(iso); return isNaN(t) ? null : new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); };
      const scans = Array.isArray(HK.scans) ? HK.scans : [];
      const lastOk = scans.filter(s => s && !s.error).slice(-1)[0] || null;
      const when = (lastOk && sgtOf(lastOk.at)) || (HK.scan && sgtOf(HK.scan.checkedAt)) || null;
      const age = when ? daysAgo(when) : null;
      const filings = (HK.filings || []).length;
      const newest = (HK.filings || []).map(f => f && f.filed).filter(Boolean).sort().pop() || null;
      if (age == null) fail('hkex.json', 'no successful scan recorded — a live HKEX feed cannot be told from a dead one, and this one is quiet by nature');
      else if (age > 4) fail('hkex.json', `last successful scan is ${age} days old (${when}) — the HKEX disclosure feed is DEAD, not quiet`);
      else ok(`hkex: last scan ${when} (${age === 0 ? 'today' : age + 'd ago'}) · ${(HK.universe || []).length} code(s) · ${filings} notice(s) retained · newest filed ${newest || 'none in the window'}`);
      const errs = (HK.scan && Array.isArray(HK.scan.errors)) ? HK.scan.errors : [];
      if (errs.length) warn('hkex.json', `last scan recorded ${errs.length} error(s) — ${errs.slice(0, 3).map(e => `${e.code || '?'} ${e.stage || ''}: ${String(e.message || '').slice(0, 60)}`).join('; ')}`);
      if (HK.bookSource === 'none') warn('hkex.json', "bookSource 'none' — the scan found neither book.json nor index.html holdings, so its universe is whatever the watchlist gave it, not the book");
      // The book is the authority on which codes must be covered. On GitHub Actions book.json is not
      // present (it is private); there the universe came from index.html and this sub-check is skipped
      // rather than guessed at.
      const bk = J('book.json');
      if (bk && Array.isArray(bk.holdings) && lastOk) {
        const codeOf = yf => { const m = /^(\d{3,5})\.HK$/i.exec(String(yf || '').trim()); return m ? (m[1].length < 4 ? m[1].padStart(4, '0') : m[1]) : null; };
        const bookCodes = [...new Set(bk.holdings.map(h => codeOf(h.yf)).filter(Boolean))].sort();
        const scanned = new Set((HK.universe || []).map(u => u && u.code).filter(Boolean));
        const missing = bookCodes.filter(c => !scanned.has(c));
        if ((lastOk.codes || 0) < bookCodes.length) {
          warn('hkex.json', `the last scan covered ${lastOk.codes || 0} code(s) but the book holds ${bookCodes.length} HK line(s)${missing.length ? ` — ${missing.join(', ')} never scanned` : ' — the scan log and the universe disagree'}`);
        } else if (missing.length) {
          warn('hkex.json', `the book holds ${missing.join(', ')} but the scanned universe does not — ${missing.join(', ')} never scanned`);
        } else if (bookCodes.length) {
          ok(`hkex: all ${bookCodes.length} HK book line(s) covered (${bookCodes.join(', ')})`);
        }
      }
    }
  } catch (e) { warn('hkex.json', `PHASE 7 check did not run: ${String((e && e.message) || e).slice(0, 120)}`); }
}

// ── report ─────────────────────────────────────────────────────────────────
// Always written — even from the catch-all below — so research-headless.sh's alarm and the brief
// never read yesterday's report for today's failure.
function writeReport() {
  const report = { checkedOn: today, at: new Date().toISOString(), problems, warnings, passed: checks };
  fs.writeFileSync(path.join(D, '.validation.json'), JSON.stringify(report, null, 1) + '\n');
  console.log(`validate-all — ${today}\n`);
  checks.forEach(c => console.log('  ✓ ' + c));
  if (warnings.length) { console.log(''); warnings.forEach(w => console.log('  ⚠ ' + w)); }
  if (problems.length) { console.log(''); problems.forEach(p => console.log('  ❌ ' + p)); }
  console.log(`\n${checks.length} passed · ${warnings.length} warning(s) · ${problems.length} problem(s)`);
  return problems.length ? 1 : warnings.length ? 2 : 0;
}
process.exit(writeReport());
