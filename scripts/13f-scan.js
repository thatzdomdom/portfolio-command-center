#!/usr/bin/env node
/*
 * 13f-scan.js — what the tracked funds reported to EDGAR, parsed by code, every figure dated.
 *
 * Phase 6 of the 11 Sep 2026 redesign. Until now investors.json's 13F tables were written by the
 * research agent every morning under a rule that bumped their stamp daily — the incentive that on
 * 18 Aug put a fresh stamp over a quarter-old table while Q2 had been public for four days. This
 * reads the filings themselves (submissions → filing index → cover page + information table) for
 * the funds in data/funds.json and writes the FACTS to data/13f.json. It makes no judgment:
 * alerts.js, the brief and the pages apply policy to these facts.
 *
 * Three traps it exists to survive, each seen in a real filing on 13 Sep 2026:
 *  - rows repeat once per otherManager (Berkshire Q2: 89 rows, 29 positions). The raw rows are
 *    reconciled to the cover page's own totals FIRST, then aggregated by (cusip, putCall);
 *  - Duquesne and Baupost still report value in THOUSANDS despite the 2023 rule (Amazon at $0.238 a
 *    share). Units are detected per filing from the median price per share, never assumed;
 *  - Pershing Square's old CIK filed a 13F-NT for Q2 naming the manager that actually reported. A
 *    scanner reading only that CIK says Q1 is current. Notices are followed to the named CIK.
 *
 * Tickers: 13F carries CUSIPs, not tickers (the figi column was empty on every filing checked).
 * OpenFIGI maps them keyless — 10 per request, 25 requests a minute — and every answer, misses
 * included, is cached in data/.cusips.json so a warm run asks nothing.
 *
 * Keyless. SEC_UA (env; ~/.claude/portfolio-brief.env on the Mac; a secret on Actions) is the
 * identifying User-Agent SEC requires — never hardcoded, never printed. EDGAR requests ≥250 ms apart.
 *
 * Flags:  --dry-run   fetch and print, write nothing        --fund <id>  one fund; the rest kept
 *         --no-figi   no OpenFIGI (cache only)              --resolve "<name>"  print verified
 *                                                            funds.json entries, write nothing
 * Exit:   0 ok · 1 hard failure (one line) · 78 no SEC_UA. One fund failing is recorded in
 *         scan.errors[] and its last good entry is kept; the rest continue.
 *
 * scan.checkedAt/ok/errors refresh every run — a real check, which is what validate-all ages. The
 * rest of the file is rewritten only when its content changed, so generatedAt and
 * scan.secRequests/figiRequests describe the run that produced the current content.
 */
const fs = require('fs'), path = require('path'), https = require('https');
const ROOT = path.join(__dirname, '..');
const D = f => path.join(ROOT, 'data', f);
const HISTORY = 8, EVENT_DAYS = 120, MISS_RETRY_DAYS = 30, FIGI_BUDGET_MS = 25 * 60e3;
const EXCL_KINDS = new Set(['quant', 'index']);
const sgtDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

// ── pure: XML (regex, namespace-prefix tolerant — Baupost's table is all `ns1:`) ─────────────
const NS = '(?:[A-Za-z_][\\w.-]*:)?';
const reCache = new Map();
const re = (key, src, flags) => { const k = key + '/' + flags; if (!reCache.has(k)) reCache.set(k, new RegExp(src, flags)); return reCache.get(k); };
function decode(s) {
  return String(s).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
    return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
}
// First <name>text</name>; null when absent or self-closed (<tableEntryTotal/> on a notice).
function tag(src, name) {
  const m = re('t:' + name, `<${NS}${name}(?:\\s[^>]*)?>([^<]*)</${NS}${name}\\s*>`, 'i').exec(String(src || ''));
  return m ? decode(m[1]).trim() : null;
}
function blocks(src, name) {
  return [...String(src || '').matchAll(re('b:' + name, `<${NS}${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${NS}${name}\\s*>`, 'gi'))].map(m => m[1]);
}
const num = s => { if (s == null || String(s).trim() === '') return null; const n = +String(s).replace(/[,\s$]/g, ''); return Number.isFinite(n) ? n : null; };
const truthy = s => /^(true|y|yes|1)$/i.test(String(s || '').trim());
const isoOf = s => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[1]}-${m[2]}` : (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()) ? String(s).trim() : null); };

function parseInfotable(xml) {
  return blocks(xml, 'infoTable').map(b => {
    const shr = blocks(b, 'shrsOrPrnAmt')[0] || b;
    const pc = String(tag(b, 'putCall') || '').toUpperCase();
    return {
      name: tag(b, 'nameOfIssuer') || '', cls: tag(b, 'titleOfClass') || '',
      cusip: String(tag(b, 'cusip') || '').toUpperCase().replace(/\s+/g, ''), figi: tag(b, 'figi') || null,
      value: num(tag(b, 'value')) || 0, shares: num(tag(shr, 'sshPrnamt')) || 0,
      type: String(tag(shr, 'sshPrnamtType') || 'SH').toUpperCase() === 'PRN' ? 'PRN' : 'SH',
      putCall: pc === 'PUT' || pc === 'CALL' ? pc : null,
      discretion: tag(b, 'investmentDiscretion'), otherManager: tag(b, 'otherManager'),
    };
  });
}
// otherManagersInfo = the managers reporting ON BEHALF of this filer (a notice's pointer).
// Not otherManagers2Info, which lists managers INCLUDED in this filer's own table.
function noticeManagers(xml) {
  const info = blocks(xml, 'otherManagersInfo')[0];
  return info ? blocks(info, 'otherManager').map(b => ({ cik: num(tag(b, 'cik')), fileNumber: tag(b, 'form13FFileNumber'), name: tag(b, 'name') })) : [];
}
function parseCover(xml) {
  const x = String(xml || ''), summary = blocks(x, 'summaryPage')[0] || '';
  return {
    submissionType: tag(x, 'submissionType'),
    period: isoOf(tag(x, 'periodOfReport') || tag(x, 'reportCalendarOrQuarter')),
    cik: num(tag(blocks(x, 'credentials')[0] || '', 'cik')),
    filerName: tag(blocks(x, 'filingManager')[0] || '', 'name'),
    isAmendment: truthy(tag(x, 'isAmendment')), amendmentType: tag(x, 'amendmentType'), amendmentNo: num(tag(x, 'amendmentNo')),
    reportType: tag(x, 'reportType'),
    entries: num(tag(summary, 'tableEntryTotal')), valueRaw: num(tag(summary, 'tableValueTotal')),
    confidentialOmitted: truthy(tag(summary, 'isConfidentialOmitted')),
    otherManagers: noticeManagers(x),
  };
}
// → {cik:Number|null, name, fileNumber, managers[]} for the first named manager with a CIK, or null.
function followNotice(coverXml) {
  const ms = coverXml && typeof coverXml === 'object' ? (coverXml.otherManagers || []) : noticeManagers(String(coverXml || ''));
  const hit = ms.find(m => m.cik) || ms[0];
  return hit ? { cik: hit.cik || null, name: hit.name || null, fileNumber: hit.fileNumber || null, managers: ms } : null;
}

// ── pure: arithmetic on rows ─────────────────────────────────────────────────────────────────
// Raw rows vs the filer's own cover totals, in the filer's own units, BEFORE any aggregation.
function reconcile(rows, cover) {
  const sumRaw = rows.reduce((s, r) => s + (r.value || 0), 0);
  const entries = cover && cover.entries != null ? cover.entries : null, valueRaw = cover && cover.valueRaw != null ? cover.valueRaw : null;
  const why = []; let diffPct = null;
  if (entries == null) why.push('cover has no tableEntryTotal');
  else if (rows.length !== entries) why.push(`${rows.length} rows vs tableEntryTotal ${entries}`);
  if (valueRaw == null) why.push('cover has no tableValueTotal');
  else {
    diffPct = valueRaw === 0 ? (sumRaw === 0 ? 0 : 100) : Math.abs(sumRaw - valueRaw) / Math.abs(valueRaw) * 100;
    if (diffPct > 0.5) why.push(`Σvalue ${sumRaw} vs tableValueTotal ${valueRaw} (${diffPct.toFixed(2)}% apart)`);
  }
  return { reconciled: !why.length, rows: rows.length, entries, sumRaw, valueRaw, diffPct: diffPct == null ? null : +diffPct.toFixed(4), why };
}
// median(value / shares) over plain share rows: a real share price is dollars; under $1 means the
// filer typed thousands (Baupost 0.127, Duquesne 0.089 against Berkshire's 101.26).
function detectUnits(rows) {
  const px = rows.filter(r => r.type !== 'PRN' && !r.putCall && r.shares > 0).map(r => (r.value || 0) / r.shares).sort((a, b) => a - b);
  if (!px.length) return { units: 'dollars', factor: 1, medianPrice: null, sample: 0 };
  const mid = px.length >> 1, med = px.length % 2 ? px[mid] : (px[mid - 1] + px[mid]) / 2;
  return med < 1 ? { units: 'thousands', factor: 1000, medianPrice: +med.toFixed(4), sample: px.length }
    : { units: 'dollars', factor: 1, medianPrice: +med.toFixed(2), sample: px.length };
}
// Group by (cusip, putCall). Rows may carry valueUSD already (unit-normalised); else value × factor.
function aggregate(rows, factor = 1) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.cusip}|${r.putCall || ''}`;
    let h = by.get(k);
    if (!h) by.set(k, h = { cusip: r.cusip, name: r.name, cls: r.cls, putCall: r.putCall || null, type: r.type || 'SH', shares: 0, valueUSD: 0, rows: 0 });
    h.shares += r.shares || 0; h.valueUSD += r.valueUSD != null ? r.valueUSD : (r.value || 0) * factor; h.rows++;
  }
  return [...by.values()].map(h => ({ ...h, valueUSD: Math.round(h.valueUSD) }))
    .sort((a, b) => b.valueUSD - a.valueUSD || a.cusip.localeCompare(b.cusip) || String(a.putCall).localeCompare(String(b.putCall)));
}
// 13F-HR/A in filing order: RESTATEMENT replaces the table, NEW HOLDINGS adds rows to it.
function applyAmendments(base, amendments) {
  let rows = ((base && base.rows) || []).slice();
  const applied = [], skipped = [];
  const list = (amendments || []).slice().sort((a, b) => String(a.filed || '').localeCompare(String(b.filed || '')) || String(a.accession || '').localeCompare(String(b.accession || '')));
  for (const a of list) {
    const type = String(a.amendmentType || (a.cover && a.cover.amendmentType) || '').toUpperCase();
    const ar = a.rows || [];
    if (!ar.length) { skipped.push({ accession: a.accession || null, type: type || null, why: 'no information table rows' }); continue; }
    if (/RESTATE/.test(type)) { rows = ar.slice(); applied.push({ accession: a.accession || null, filed: a.filed || null, type: 'RESTATEMENT' }); }
    else if (/NEW\s*HOLDING/.test(type)) { rows = rows.concat(ar); applied.push({ accession: a.accession || null, filed: a.filed || null, type: 'NEW HOLDINGS' }); }
    else skipped.push({ accession: a.accession || null, type: type || null, why: 'amendment type is neither RESTATEMENT nor NEW HOLDINGS' });
  }
  return { rows, applied, skipped };
}
// Holdings arrays (or compact {key:{shares,valueUSD}} maps) → New / Added / Reduced / Exited rows.
// Share change decides; for PRN (principal amounts) the value change decides.
function diffPeriods(prior, latest) {
  const toMap = h => { h = h && !Array.isArray(h) && h.holdings !== undefined ? h.holdings : h; const m = new Map();
    if (Array.isArray(h)) h.forEach(x => m.set(x.key, x)); else if (h) Object.keys(h).forEach(k => m.set(k, { key: k, ...h[k] })); return m; };
  const P = toMap(prior), L = toMap(latest), out = [];
  const r1 = x => Math.round(x * 10) / 10;
  const row = (k, l, p, action) => {
    const src = l || p, type = (l && l.type) || (p && p.type) || 'SH';
    const sp = p ? p.shares || 0 : 0, sl = l ? l.shares || 0 : 0, vp = p ? p.valueUSD || 0 : 0, vl = l ? l.valueUSD || 0 : 0;
    const [b0, b1] = type === 'PRN' ? [vp, vl] : [sp, sl];
    return { key: k, ticker: src.ticker || null, name: src.name || null, cusip: src.cusip || null, action, type,
      putCall: src.putCall || ((/:(PUT|CALL)$/.exec(k) || [])[1] || null),
      sharesPrior: sp, sharesLatest: sl, sharesChg: sl - sp,
      pctChg: action === 'New' ? null : action === 'Exited' ? -100 : (b0 ? r1((b1 - b0) / b0 * 100) : null),
      valueUSD: vl, valuePriorUSD: vp, valueChgUSD: vl - vp, pctOfPortfolio: l ? l.pct || 0 : 0,
      tags: ((l && l.tags) || (p && p.tags) || []).slice() };
  };
  for (const [k, l] of L) {
    const p = P.get(k);
    if (!p) { out.push(row(k, l, null, 'New')); continue; }
    const d = l.type === 'PRN' ? (l.valueUSD || 0) - (p.valueUSD || 0) : (l.shares || 0) - (p.shares || 0);
    if (d > 0) out.push(row(k, l, p, 'Added')); else if (d < 0) out.push(row(k, l, p, 'Reduced'));
  }
  for (const [k, p] of P) if (!L.has(k)) out.push(row(k, null, p, 'Exited'));
  return out.sort((a, b) => Math.abs(b.valueChgUSD) - Math.abs(a.valueChgUSD) || a.key.localeCompare(b.key));
}

// ── pure: the filing calendar ────────────────────────────────────────────────────────────────
const ymd = d => d.toISOString().slice(0, 10);
// Quarter end + 45 days, rolled forward off a weekend (2026 Q3: Sat 14 Nov → Mon 16 Nov).
function deadlineFor(periodISO) {
  const d = new Date(periodISO + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 45);
  const dow = d.getUTCDay(); if (dow === 6) d.setUTCDate(d.getUTCDate() + 2); else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d);
}
function quarterLabel(periodISO) { const [y, m] = String(periodISO).split('-'); return `${y} Q${Math.ceil(+m / 3)}`; }
const quarterEndOf = (y, m1) => ymd(new Date(Date.UTC(y, m1, 0)));          // m1 = 1-based month of the quarter end
function nextQuarterEnd(p) { const [y, m] = p.split('-').map(Number); return quarterEndOf(y, m + 3); }
function prevQuarterEnd(p) { const [y, m] = p.split('-').map(Number); return quarterEndOf(y, m - 3); }
function lastQuarterEndOnOrBefore(day) { const [y, m] = day.split('-').map(Number); const q = quarterEndOf(y, Math.ceil(m / 3) * 3); return q <= day ? q : prevQuarterEnd(q); }
// The newest quarter whose rolled deadline has passed, and the next one.
function deadlinesAround(today) {
  let passed = lastQuarterEndOnOrBefore(today);
  while (deadlineFor(passed) > today) passed = prevQuarterEnd(passed);
  const next = nextQuarterEnd(passed);
  return { [quarterLabel(passed)]: deadlineFor(passed), [quarterLabel(next)]: deadlineFor(next) };
}
// Consecutive rolled deadlines passed since the newest period EDGAR shows (any 13F form, notices
// included). Two or more with nothing filed ⇒ the filer has stopped (Scion after 2025 Q3).
function inferStatus(edgarLatestPeriod, today) {
  if (!edgarLatestPeriod) return { inferredStatus: null, missedDeadlines: null };
  let q = nextQuarterEnd(edgarLatestPeriod), missed = 0;
  while (deadlineFor(q) < today && missed < 80) { missed++; q = nextQuarterEnd(q); }
  return { inferredStatus: missed >= 2 ? 'stopped' : null, missedDeadlines: missed };
}

// ── pure: tickers, keys, tags ────────────────────────────────────────────────────────────────
// BRK/B, BRK-B → BRK.B. A bond or preferred "ticker" is a description ("AEIS 2.5 09/15/28") — left as is.
const normTicker = t => { if (!t) return null; const s = String(t).trim().toUpperCase(); return /\s/.test(s) ? s : s.replace(/[\/-]/g, '.'); };
const US_VENUES = new Set(['US', 'UN', 'UW', 'UQ', 'UA', 'UP', 'UR', 'UV', 'UF', 'UD', 'UC', 'UT', 'UX', 'UO', 'UB', 'UM', 'UI', 'UL']);
// OpenFIGI answer for one identifier → cache entry. The composite US line, else another US venue.
// An EQUITY with only foreign lines gets no ticker: on 13 Sep 2026 Hologic, Amicus, EA, ONEOK and
// Honeywell came back as HO1 / AM6 / EA* / ONK / HONGBP (Frankfurt, Mexico, Euro TLX) with no US line,
// even by composite FIGI — a Frankfurt code in a 13F consensus table is a wrong fact, the CUSIP and the
// filing's own issuer name are not. Notes and preferreds (no US composite exists) keep their first line.
function pickFigi(answer, at, idType = 'ID_CUSIP') {
  const tried = [idType];
  if (answer && Array.isArray(answer.data) && answer.data.length) {
    const d = answer.data.find(x => x.exchCode === 'US') || answer.data.find(x => US_VENUES.has(x.exchCode));
    const extra = idType === 'ID_CUSIP' ? {} : { idType };
    if (d && d.ticker) return { ticker: normTicker(d.ticker), name: d.name || null, type: d.securityType || d.securityType2 || null, exch: d.exchCode || null, at, ...extra };
    const f = answer.data[0];
    if (f.marketSector === 'Equity') return { ticker: null, reason: `no US listing on OpenFIGI (first line ${f.exchCode} ${f.ticker})`, name: f.name || null, at, idTypes: tried };
    if (f.ticker) return { ticker: normTicker(f.ticker), name: f.name || null, type: f.securityType || f.securityType2 || null, exch: f.exchCode || null, sector: f.marketSector || null, at, ...extra };
    return { ticker: null, reason: 'listing has no ticker', at, idTypes: tried };
  }
  return { ticker: null, reason: (answer && (answer.warning || answer.error)) || 'empty answer', at, idTypes: tried };
}
const tagsFor = (ticker, book, watch) => { const t = []; if (ticker && book.has(ticker)) t.push('in-book'); if (ticker && watch.has(ticker)) t.push('watchlist'); return t; };
// key = ticker||cusip (+ :PUT/:CALL). Holdings arrive largest first, so when two CUSIPs resolve to
// one ticker the larger keeps the ticker and the smaller keeps its CUSIP — keys stay unique.
function keyed(agg, cusips, book, watch) {
  const total = agg.reduce((s, h) => s + h.valueUSD, 0), used = new Set();
  return agg.map(h => {
    const c = cusips[h.cusip], ticker = c && c.ticker ? c.ticker : null, sfx = h.putCall ? ':' + h.putCall : '';
    let key = (ticker || h.cusip) + sfx; if (used.has(key)) key = h.cusip + sfx; used.add(key);
    return { key, cusip: h.cusip, ticker, name: h.name, cls: h.cls, putCall: h.putCall, type: h.type, shares: h.shares, valueUSD: h.valueUSD,
      pct: total ? +(h.valueUSD / total * 100).toFixed(2) : 0, tags: tagsFor(ticker, book, watch) };
  });
}
// Consensus for the newest period that at least half the active tracked funds have reached, over
// the funds whose latest table IS that period (their diff is that quarter's diff).
function consensusFor(funds) {
  const act = Object.entries(funds).filter(([, f]) => f.status === 'active' && f.inferredStatus !== 'stopped' && !EXCL_KINDS.has(f.kind) && f.latest);
  if (!act.length) return null;
  const periods = [...new Set(act.map(([, f]) => f.latest.period))].sort().reverse();
  const P = periods.find(p => act.filter(([, f]) => f.latest.period >= p).length * 2 >= act.length);
  const used = act.filter(([, f]) => f.latest.period === P);
  const acc = { New: new Map(), Added: new Map(), Reduced: new Map(), Exited: new Map() };
  for (const [id, f] of used) for (const d of f.diff || []) {
    const m = acc[d.action]; if (!m) continue;
    let c = m.get(d.key);
    if (!c) m.set(d.key, c = { key: d.key, ticker: d.ticker, name: d.name, putCall: d.putCall, count: 0, funds: [], names: [], valueUSD: 0 });
    c.count++; c.funds.push(id); c.names.push(f.name); c.valueUSD += d.valueChgUSD || 0;
  }
  const top = m => [...m.values()].sort((a, b) => b.count - a.count || Math.abs(b.valueUSD) - Math.abs(a.valueUSD) || a.key.localeCompare(b.key)).slice(0, 10);
  return { period: P, quarter: quarterLabel(P), funds: used.length, activeTracked: act.length, fundIds: used.map(([id]) => id),
    New: top(acc.New), Added: top(acc.Added), Reduced: top(acc.Reduced), Exited: top(acc.Exited) };
}
// A CUSIP held by ≥2 funds in one period must agree on price per share within ×3 once units are
// normalised. This is the check that would have caught Duquesne's thousands.
function unitsCrossCheck(sides) {
  const by = new Map();
  for (const s of sides) for (const h of s.holdings) {
    if (h.type === 'PRN' || h.putCall || !(h.shares > 0) || !(h.valueUSD > 0)) continue;
    const k = s.period + '|' + h.cusip;
    if (!by.has(k)) by.set(k, { period: s.period, cusip: h.cusip, ticker: h.ticker, name: h.name, funds: [] });
    const g = by.get(k); if (!g.funds.some(x => x.fund === s.fund)) g.funds.push({ fund: s.fund, pricePerShare: +(h.valueUSD / h.shares).toFixed(4) });
  }
  const out = [];
  for (const g of by.values()) {
    if (g.funds.length < 2) continue;
    const px = g.funds.map(x => x.pricePerShare), lo = Math.min(...px), hi = Math.max(...px), ratio = lo > 0 ? hi / lo : Infinity;
    if (ratio > 3) out.push({ period: g.period, quarter: quarterLabel(g.period), cusip: g.cusip, ticker: g.ticker, name: g.name,
      ratio: Number.isFinite(ratio) ? +ratio.toFixed(1) : null, funds: g.funds, why: 'price per share disagrees by more than ×3 across funds — one filer\'s units or shares are probably wrong' });
  }
  return out.sort((a, b) => (b.ratio || 1e9) - (a.ratio || 1e9));
}

module.exports = { parseInfotable, parseCover, detectUnits, aggregate, applyAmendments, reconcile, diffPeriods, deadlineFor, quarterLabel,
  followNotice, nextQuarterEnd, prevQuarterEnd, deadlinesAround, inferStatus, pickFigi, keyed, consensusFor, unitsCrossCheck, tag, blocks };

// ════════════════════════════════════════════════════════════════════════════════════════════
// I/O — only when run directly.
// ════════════════════════════════════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpReq(url, { method = 'GET', headers = {}, body = null, timeout = 90e3 } = {}) {
  return new Promise(res => {
    const u = new URL(url);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, r => {
      if (method === 'GET' && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return httpReq(new URL(r.headers.location, url).toString(), { method, headers, timeout }).then(res); }
      let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d, headers: r.headers }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', e => res({ status: 0, body: e.message, headers: {} }));
    if (body) req.write(body);
    req.end();
  });
}
function atomicWrite(file, text) { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const hardError = msg => Object.assign(new Error(msg), { hard: true });

function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const has = k => args.includes(k);
  const NOFIGI = has('--no-figi'), ONLY = opt('--fund'), RESOLVE = opt('--resolve');
  // The Mac READS data/13f.json; GitHub Actions WRITES it (13f-scan.yml, 06:15 SGT). If both could write,
  // an Actions commit and a local edit of the same tracked file would make the 07:02 `git pull` refuse and
  // turn the publish red. Off Actions this is therefore always a dry run unless --local says otherwise.
  const READER = !process.env.GITHUB_ACTIONS && !has('--local');
  const DRY = has('--dry-run') || READER;
  if (READER && !has('--dry-run') && !RESOLVE) console.log('13f-scan: not on GitHub Actions — running as a dry run; pass --local to write data/13f.json from this machine');

  const env = (() => { const o = {}; try { fs.readFileSync(path.join(process.env.HOME || '', '.claude', 'portfolio-brief.env'), 'utf8')
    .split('\n').forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].trim(); }); } catch (_) {} return o; })();
  const UA = process.env.SEC_UA || env.SEC_UA;
  if (!UA) { console.error('13f-scan: no SEC_UA — SEC requires an identifying User-Agent. Refusing.'); process.exit(78); }

  let secRequests = 0, figiRequests = 0, lastSec = 0, secStreak = 0;
  async function sec(url) {
    for (let attempt = 0; ; attempt++) {
      const wait = 260 - (Date.now() - lastSec); if (wait > 0) await sleep(wait);
      lastSec = Date.now(); secRequests++;
      const r = await httpReq(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' } });
      if (r.status === 200 || r.status === 404) { secStreak = 0; return r; }
      if (attempt < 3 && (r.status === 0 || r.status === 429 || r.status === 403 || r.status >= 500)) { await sleep([2000, 6000, 15000][attempt]); continue; }
      if (++secStreak >= 6) throw hardError(`EDGAR unreachable — ${secStreak} requests in a row failed (last HTTP ${r.status})`);
      return r;
    }
  }
  // 13F rows from a submissions JSON block (recent, or an older page).
  const pick13F = (rec, cik) => { const out = []; if (!rec || !rec.form) return out;
    for (let i = 0; i < rec.form.length; i++) if (/^13F-(HR|NT)(\/A)?$/.test(rec.form[i]) && rec.reportDate[i])
      out.push({ form: rec.form[i], period: rec.reportDate[i], filed: rec.filingDate[i], accession: rec.accessionNumber[i], cik: +cik });
    return out; };
  async function submissions(cik, deep = true) {
    const r = await sec(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`);
    if (r.status !== 200) throw new Error(`submissions CIK ${cik}: HTTP ${r.status}`);
    const j = JSON.parse(r.body), out = pick13F(j.filings && j.filings.recent, cik);
    // Busy filers push old 13Fs out of `recent`; read at most two older pages for HISTORY.
    let pages = 0;
    for (const f of (deep && j.filings && j.filings.files) || []) {
      if (new Set(out.map(x => x.period)).size >= HISTORY + 2 || pages++ >= 2) break;
      const q = await sec(`https://data.sec.gov/submissions/${f.name}`); if (q.status !== 200) break;
      pick13F(JSON.parse(q.body), cik).forEach(x => out.push(x));
    }
    return { name: j.name, filings: out };
  }
  const dirOf = f => `https://www.sec.gov/Archives/edgar/data/${+f.cik}/${f.accession.replace(/-/g, '')}/`;
  const urlOf = f => `${dirOf(f)}${f.accession}-index.htm`;
  async function loadFiling(f, wantTable) {
    const dir = dirOf(f);
    if (!wantTable) {   // a notice: the cover is all there is, at its standard name
      const c = await sec(dir + 'primary_doc.xml');
      if (c.status === 200) return { ...f, coverXml: c.body, cover: parseCover(c.body), rows: [], url: urlOf(f) };
    }
    const idx = await sec(dir + 'index.json');
    if (idx.status !== 200) throw new Error(`${f.form} ${f.accession}: filing index HTTP ${idx.status}`);
    const xmls = ((JSON.parse(idx.body).directory || {}).item || []).filter(i => /\.xml$/i.test(i.name));
    const coverItem = xmls.find(i => /^primary_doc\.xml$/i.test(i.name));
    if (!coverItem) throw new Error(`${f.form} ${f.accession}: no primary_doc.xml`);
    const c = await sec(dir + coverItem.name);
    if (c.status !== 200) throw new Error(`${f.form} ${f.accession}: cover HTTP ${c.status}`);
    let rows = [], table = null;
    if (wantTable) for (const it of xmls.filter(i => i !== coverItem).sort((a, b) => (+b.size || 0) - (+a.size || 0))) {
      const t = await sec(dir + it.name);
      if (t.status === 200 && /infoTable/i.test(t.body)) { rows = parseInfotable(t.body); table = it.name; break; }
    }
    return { ...f, coverXml: c.body, cover: parseCover(c.body), rows, table, url: urlOf(f) };
  }
  // parse → reconcile raw rows to the cover → detect units → normalise. Aggregation comes later,
  // after amendments. A small amendment inherits the original's units rather than guessing from 1 row.
  function prepare(lf, base) {
    const recon = reconcile(lf.rows, lf.cover);
    let u = detectUnits(lf.rows);
    if (base && u.sample < 3) u = { units: base.units, factor: base.factor, medianPrice: u.medianPrice, sample: u.sample };
    return { accession: lf.accession, form: lf.form, filed: lf.filed, cik: lf.cik, url: lf.url, cover: lf.cover, recon,
      units: u.units, factor: u.factor, medianPrice: u.medianPrice, amendmentType: lf.cover.amendmentType || null,
      rows: lf.rows.map(r => ({ ...r, valueUSD: (r.value || 0) * u.factor })) };
  }

  async function processPeriod(ctx, p, full) {
    const here = ctx.all.filter(x => x.period === p);
    const nts = here.filter(x => /^13F-NT/.test(x.form)).sort((a, b) => b.filed.localeCompare(a.filed));
    const hrs = ctx.ciks.map(c => here.find(x => x.form === '13F-HR' && x.cik === c.cik && ctx.inRange(x.cik, p))).filter(Boolean);
    let base = null, via = 'direct', reporter = null, pool = ctx.all;
    if (nts.length && !hrs.some(h => h.cik === nts[0].cik)) {
      const nt = nts[0], lf = await loadFiling(nt, false), named = followNotice(lf.coverXml);
      if (named && named.cik) {
        reporter = { cik: named.cik, name: named.name };
        if (!ctx.ciks.some(c => c.cik === named.cik)) {
          ctx.proposedCik = ctx.proposedCik || { cik: named.cik, name: named.name, period: p };
          if (!ctx.extra[named.cik]) ctx.extra[named.cik] = await submissions(named.cik, false);
          pool = ctx.extra[named.cik].filings;
        }
        const hr = pool.find(x => x.form === '13F-HR' && x.cik === named.cik && x.period === p);
        if (hr) { base = hr; via = 'notice'; }
      }
      if (!base && hrs[0]) { base = hrs[0]; reporter = null; }
      if (!base) throw new Error(`13F-NT ${nt.accession} (CIK ${nt.cik}) names ${named ? `${named.name || '?'} CIK ${named.cik || 'none'}` : 'no manager'}, and no matching 13F-HR was found`);
    } else if (hrs.length) base = hrs[0];
    else throw new Error('amendments on file but no original 13F-HR');

    const b = prepare(await loadFiling(base, true));
    const amends = [];
    for (const a of pool.filter(x => x.form === '13F-HR/A' && x.cik === base.cik && x.period === p).sort((x, y) => x.filed.localeCompare(y.filed) || x.accession.localeCompare(y.accession))) {
      const lf = await loadFiling(a, true);
      if (/NOTICE/i.test(lf.cover.reportType || '')) continue;
      amends.push(prepare(lf, b));
    }
    const merged = applyAmendments(b, amends);
    const agg = aggregate(merged.rows);
    // Reconciliation is judged on the filings that make up the table as it now stands. A RESTATEMENT
    // supersedes everything before it: Scion's 2023 Q4 original said tableEntryTotal 0 over 25 rows,
    // and the restatement two days later said 25 and matched to the dollar.
    let used = [b];
    for (const x of merged.applied) { const a = amends.find(y => y.accession === x.accession); if (x.type === 'RESTATEMENT') used = [a]; else used.push(a); }
    return {
      period: p, quarter: quarterLabel(p), filed: base.filed, accession: base.accession, cik: base.cik, via, reporter,
      units: b.units, positions: agg.length, valueUSD: agg.reduce((s, h) => s + h.valueUSD, 0),
      confidentialOmitted: !!b.cover.confidentialOmitted, cover: { entries: b.cover.entries, valueRaw: b.cover.valueRaw },
      reconciled: used.every(x => x.recon.reconciled), url: b.url,
      amendments: merged.applied, filings: [b, ...amends].map(x => ({ accession: x.accession, form: x.form, filed: x.filed, amendmentType: x.amendmentType,
        units: x.units, medianPrice: x.medianPrice, rows: x.recon.rows, entries: x.recon.entries, valueRaw: x.recon.valueRaw, sumRaw: x.recon.sumRaw,
        diffPct: x.recon.diffPct, reconciled: x.recon.reconciled, why: x.recon.why, inTable: used.includes(x) })),
      accessions: here.map(x => x.accession).concat(pool === ctx.all ? [] : [base.accession]).sort(),
      agg: full ? agg : null,
    };
  }

  async function scanFund(f, prevFund) {
    const ciks = (f.ciks || []).map(c => ({ cik: +c.cik, from: c.from || null, to: c.to || null }));
    if (!ciks.length) throw new Error('no CIK in funds.json');
    const all = [];
    for (const c of ciks) (await submissions(c.cik)).filings.forEach(x => all.push(x));
    const inRange = (cik, p) => { const c = ciks.find(x => x.cik === cik); return !!c && (!c.from || p >= c.from) && (!c.to || p <= c.to); };
    const periods = [...new Set(all.map(x => x.period))].sort().reverse();
    const usable = periods.filter(p => all.some(x => x.period === p && ((x.form === '13F-HR' && inRange(x.cik, p)) || /^13F-NT/.test(x.form))));
    const ctx = { ciks, all, inRange, extra: {}, proposedCik: null };
    const prevHist = new Map(((prevFund && prevFund.history) || []).map(h => [h.period, h]));
    const got = [], errs = [];
    for (const p of usable) {
      if (got.length >= HISTORY) break;
      const full = got.filter(g => g.agg).length < 2;
      if (!full) {   // history rows are reused while their accession set is unchanged; unreconciled ones are re-read
        const h = prevHist.get(p), sig = all.filter(x => x.period === p).map(x => x.accession).sort().join();
        if (h && h.reconciled && (h.accessions || []).join() === sig) { got.push({ ...h, agg: null }); continue; }
      }
      try { got.push(await processPeriod(ctx, p, full)); }
      catch (e) { if (e.hard) throw e; errs.push(`${quarterLabel(p)}: ${e.message}`); if (errs.length >= 4) break; }
    }
    if (!got.some(g => g.agg)) throw new Error(errs[0] || 'no 13F-HR on EDGAR for any listed CIK');
    // edgarLatestPeriod = the newest period EDGAR really has HOLDINGS for: a 13F-HR under a listed CIK, or
    // a period this run actually read (a notice whose reporter's 13F-HR was found). A 13F-NT on its own is
    // not a table. On a deadline day an old CIK can post its notice hours before the new filer posts the
    // holdings (Pershing Square, 16 Nov); counting the notice would fail the publish with "filed on EDGAR
    // but not ingested" for a table that does not exist yet. That window is pendingNotice — a warning.
    const hrPeriods = periods.filter(p => all.some(x => x.period === p && x.form === '13F-HR' && inRange(x.cik, p)));
    const readPeriods = got.map(g => g.period).filter(Boolean).sort().reverse();
    const edgarLatest = [hrPeriods[0], readPeriods[0]].filter(Boolean).sort().reverse()[0] || null;
    const nt = periods.find(p => p > (edgarLatest || '') && all.some(x => x.period === p && /^13F-NT/.test(x.form)));
    const ntF = nt ? all.filter(x => x.period === nt && /^13F-NT/.test(x.form)).sort((a, b) => String(b.filed).localeCompare(String(a.filed)))[0] : null;
    const pendingNotice = nt ? { period: nt, quarter: quarterLabel(nt), filed: (ntF && ntF.filed) || null, cik: (ntF && ntF.cik) || null } : null;
    return { edgarLatestPeriod: edgarLatest, pendingNotice, periods: got, errors: errs, proposedCik: ctx.proposedCik };
  }

  async function resolveName(name) {
    const r = await sec(`https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(name)}`);
    if (r.status !== 200) throw hardError(`name search HTTP ${r.status}`);
    const hits = ((JSON.parse(r.body).hits || {}).hits || []).slice(0, 10);
    const today = sgtDate(), recentFrom = prevQuarterEnd(prevQuarterEnd(prevQuarterEnd(prevQuarterEnd(lastQuarterEndOnOrBefore(today)))));
    console.log(`resolve "${name}": ${hits.length} entity hit(s) · accepted only with a 13F-HR for a period on/after ${recentFrom}`);
    const ok = [];
    for (const h of hits) {
      const cik = +String(h._id).replace(/\D/g, ''), entity = (h._source && (h._source.entity || h._source.display_names)) || '';
      if (!cik) continue;
      try {
        const s = await submissions(cik, false), hr = s.filings.filter(x => x.form === '13F-HR').sort((a, b) => b.period.localeCompare(a.period));
        if (!hr.length) { console.log(`  ✗ ${cik} ${s.name}: no 13F-HR`); continue; }
        if (hr[0].period < recentFrom) { console.log(`  ✗ ${cik} ${s.name}: newest 13F-HR is ${quarterLabel(hr[0].period)} (filed ${hr[0].filed}) — not recent`); continue; }
        ok.push({ cik, name: s.name, newest: hr[0].period, filed: hr[0].filed });
      } catch (e) { if (e.hard) throw e; console.log(`  ✗ ${cik} ${entity}: ${e.message}`); }
    }
    ok.sort((a, b) => b.newest.localeCompare(a.newest) || a.cik - b.cik);
    for (const c of ok) {
      const id = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
      console.log(`  ✓ newest ${quarterLabel(c.newest)} filed ${c.filed}\n    ${JSON.stringify({ id, name: c.name, manager: '', kind: 'discretionary', track: true, status: 'active', ciks: [{ cik: c.cik }] })}`);
    }
    if (!ok.length) console.log('  no verified candidate — nothing to paste');
  }

  // OpenFIGI, keyless: ≤10 jobs a request (11 → 413), honour ratelimit-remaining/reset, back off on 429.
  // Letter-prefixed identifiers are CINS numbers (G25508105 is CRH): OpenFIGI misses them as ID_CUSIP
  // and finds them as ID_CINS, so a CUSIP miss on one is asked again that way. Numeric ones reject CINS.
  async function mapCusips(list, cache, errors, at) {
    const now = Date.now(), queue = [];
    const isCins = c => /^[A-Z]/.test(c), triedOf = e => (e && e.idTypes) || [];
    for (const c of list) {
      const e = cache[c];
      if (!/^[0-9A-Z]{9}$/.test(c)) { if (!e) cache[c] = { ticker: null, reason: 'malformed cusip', at }; continue; }
      if (!e || (!e.ticker && now - Date.parse(e.at) >= MISS_RETRY_DAYS * 864e5)) queue.push({ c, idType: 'ID_CUSIP' });
      else if (e.ticker && !US_VENUES.has(e.exch) && !('sector' in e)) queue.push({ c, idType: 'ID_CUSIP' });   // cached before the no-foreign-ticker rule
      else if (!e.ticker && isCins(c) && !triedOf(e).includes('ID_CINS')) queue.push({ c, idType: 'ID_CINS' });
    }
    if (!queue.length) return 0;
    console.log(`OpenFIGI: ${queue.length} identifier(s) to map in ~${Math.ceil(queue.length / 10)} request(s)`);
    let remaining = null, resetAt = 0, lastFigi = 0, mapped = 0, asked = 0;
    const t0 = Date.now();
    while (queue.length) {
      if (Date.now() - t0 > FIGI_BUDGET_MS) { errors.push({ fund: null, stage: 'figi', message: `OpenFIGI budget of ${FIGI_BUDGET_MS / 60e3} min spent — ${queue.length} identifier(s) left unmapped for the next run` }); break; }
      const batch = queue.splice(0, 10); asked += batch.length;
      for (let attempt = 0; ; attempt++) {
        if (remaining === 0 && Date.now() < resetAt) await sleep(resetAt - Date.now() + 750);
        const gap = 250 - (Date.now() - lastFigi); if (gap > 0) await sleep(gap);
        lastFigi = Date.now(); figiRequests++;
        const r = await httpReq('https://api.openfigi.com/v3/mapping', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch.map(j => ({ idType: j.idType, idValue: j.c }))), timeout: 60e3 });
        const rem = r.headers['ratelimit-remaining'], rst = r.headers['ratelimit-reset'];
        if (rem != null && rem !== '') remaining = +rem;
        if (rst != null && rst !== '') resetAt = Date.now() + (+rst) * 1000;
        if (r.status === 200) {
          let arr = null; try { arr = JSON.parse(r.body); } catch (_) {}
          if (!Array.isArray(arr) || arr.length !== batch.length) { errors.push({ fund: null, stage: 'figi', message: `OpenFIGI answered ${batch.length} jobs with an unreadable body — left unmapped` }); break; }
          batch.forEach((j, k) => {
            const prevTried = triedOf(cache[j.c]).filter(t => t !== j.idType), entry = pickFigi(arr[k], at, j.idType);
            if (!entry.ticker) entry.idTypes = prevTried.concat(entry.idTypes || [j.idType]);
            cache[j.c] = entry;
            if (entry.ticker) mapped++;
            else if (j.idType === 'ID_CUSIP' && isCins(j.c) && !entry.idTypes.includes('ID_CINS')) queue.push({ c: j.c, idType: 'ID_CINS' });
          });
          break;
        }
        if (r.status === 429 && attempt < 6) { await sleep(Math.max(rst ? +rst * 1000 + 750 : 0, 2000 * 2 ** attempt)); continue; }
        if ((r.status === 0 || r.status >= 500) && attempt < 3) { await sleep(5000 * (attempt + 1)); continue; }
        errors.push({ fund: null, stage: 'figi', message: `OpenFIGI HTTP ${r.status} on a batch of ${batch.length} — left unmapped, retried next run` });
        break;
      }
      if (figiRequests % 15 === 0) console.log(`  OpenFIGI: ${asked} asked · ${mapped} mapped · ${queue.length} queued · ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    console.log(`OpenFIGI: ${mapped}/${asked} asked mapped · ${figiRequests} request(s) · ${Math.round((Date.now() - t0) / 1000)}s`);
    return mapped;
  }

  function bookSets() {
    const book = new Set(); let source = 'none';
    const usYf = yf => /^[A-Z][A-Z0-9.-]*$/i.test(yf || '') && !/\./.test(yf) && !/-USD$/i.test(yf);
    const b = readJSON(D('book.json'));
    if (b && Array.isArray(b.holdings)) { b.holdings.forEach(h => { if (usYf(h.yf)) book.add(normTicker(h.yf)); }); source = 'book.json'; }
    else {
      // Actions has no book.json (it is private); index.html's holdings literals are the same 59 rows
      // (validate-all checks they match), so tags come out identical on either machine.
      try { for (const line of fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').split('\n')) {
        if (!/^\s*\{id:\s*\d+,/.test(line)) continue;
        const m = /\byf:\s*["']([^"']+)["']/.exec(line); if (m && usYf(m[1])) book.add(normTicker(m[1]));
      } if (book.size) source = 'index.html'; } catch (_) {}
    }
    const w = readJSON(D('watchlist.json')), watch = new Set(((w && w.us) || []).map(x => normTicker(x.t)).filter(Boolean));
    return { book, watch, source };
  }
  function retag(fund, book, watch) {
    const f = JSON.parse(JSON.stringify(fund));
    ((f.latest && f.latest.holdings) || []).forEach(h => { h.tags = tagsFor(h.ticker, book, watch); });
    (f.diff || []).forEach(d => { d.tags = tagsFor(d.ticker, book, watch); });
    return f;
  }

  return (async () => {
    if (RESOLVE) { await resolveName(RESOLVE); console.log(`(${secRequests} EDGAR request(s); nothing written)`); return; }
    const cfg = readJSON(D('funds.json'));
    if (!cfg || !Array.isArray(cfg.funds)) throw hardError('data/funds.json missing or unreadable');
    const prev = readJSON(D('13f.json')), cache = readJSON(D('.cusips.json')) || {};
    const cacheBefore = JSON.stringify(cache);
    const today = sgtDate(), nowIso = new Date().toISOString();
    const tracked = cfg.funds.filter(f => f.track);
    const targets = ONLY ? tracked.filter(f => f.id === ONLY) : tracked;
    if (ONLY && !targets.length) throw hardError(`--fund ${ONLY}: no tracked fund with that id in funds.json`);

    const errors = [], scanned = {};
    for (const f of targets) {
      const t0 = Date.now();
      try {
        const s = scanFund(f, prev && prev.funds && prev.funds[f.id]);
        scanned[f.id] = await s;
        const g = scanned[f.id].periods.filter(x => x.agg);
        console.log(`  ${f.id.padEnd(12)} ${g.map(x => `${x.quarter} ${x.positions} pos $${(x.valueUSD / 1e9).toFixed(2)}bn ${x.units}${x.via === 'notice' ? ' via notice' : ''}${x.reconciled ? '' : ' UNRECONCILED'}`).join(' ← ')} · history ${scanned[f.id].periods.length} · ${Math.round((Date.now() - t0) / 1000)}s`);
        scanned[f.id].errors.forEach(m => errors.push({ fund: f.id, stage: 'period', message: m }));
      } catch (e) {
        if (e.hard) throw e;
        errors.push({ fund: f.id, stage: 'edgar', message: e.message });
        console.log(`  ${f.id.padEnd(12)} FAILED: ${e.message}`);
      }
    }
    if (targets.length && !Object.keys(scanned).length) throw hardError(`every fund failed — first: ${errors[0] && errors[0].message}`);

    const want = new Set();
    for (const s of Object.values(scanned)) s.periods.filter(g => g.agg).forEach(g => g.agg.forEach(h => want.add(h.cusip)));
    if (!NOFIGI) await mapCusips([...want].sort(), cache, errors, today);

    const { book, watch, source: bookSource } = bookSets();
    const funds = {}, sides = [];
    for (const f of tracked) {
      const s = scanned[f.id], prevFund = prev && prev.funds && prev.funds[f.id];
      if (!s) {
        if (prevFund) { funds[f.id] = retag(prevFund, book, watch); if (funds[f.id].latest) sides.push({ fund: f.id, period: funds[f.id].latest.period, holdings: funds[f.id].latest.holdings || [] }); }
        continue;
      }
      const full = s.periods.filter(g => g.agg), L = full[0], P = full[1] || null;
      const Lh = keyed(L.agg, cache, book, watch), Ph = P ? keyed(P.agg, cache, book, watch) : [];
      sides.push({ fund: f.id, period: L.period, holdings: Lh }); if (P) sides.push({ fund: f.id, period: P.period, holdings: Ph });
      const head = g => ({ period: g.period, quarter: g.quarter, filed: g.filed, accession: g.accession, cik: g.cik, via: g.via, reporter: g.reporter,
        units: g.units, positions: g.positions, valueUSD: g.valueUSD, confidentialOmitted: g.confidentialOmitted, cover: g.cover, reconciled: g.reconciled,
        url: g.url, amendments: g.amendments, filings: g.filings });
      const mappedOf = hs => ({ mapped: hs.filter(h => h.ticker).length, total: hs.length });
      const st = inferStatus(s.edgarLatestPeriod, today);
      funds[f.id] = {
        name: f.name, manager: f.manager || null, kind: f.kind, status: f.status || 'active', stoppedAfter: f.stoppedAfter || null,
        edgarLatestPeriod: s.edgarLatestPeriod, inferredStatus: st.inferredStatus, missedDeadlines: st.missedDeadlines, proposedCik: s.proposedCik, pendingNotice: s.pendingNotice || null,
        latest: { ...head(L), tickers: mappedOf(Lh), holdings: Lh },
        prior: P ? { ...head(P), tickers: mappedOf(Ph), holdings: Object.fromEntries(Ph.map(h => [h.key, { shares: h.shares, valueUSD: h.valueUSD }])) } : null,
        diff: P ? diffPeriods(Ph, Lh) : [],
        history: s.periods.slice(0, HISTORY).map(g => ({ period: g.period, quarter: g.quarter, filed: g.filed, cik: g.cik, via: g.via, units: g.units,
          positions: g.positions, valueUSD: g.valueUSD, reconciled: g.reconciled, accessions: g.accessions })),
      };
    }
    const cons = consensusFor(funds);
    const bookHits = [];
    for (const [id, f] of Object.entries(funds)) {
      if (f.status !== 'active' || f.inferredStatus === 'stopped' || !f.latest) continue;
      for (const d of f.diff || []) if (d.tags.length) bookHits.push({ fund: id, name: f.name, ticker: d.ticker, key: d.key, action: d.action, putCall: d.putCall,
        sharesChg: d.sharesChg, pctChg: d.pctChg, valueUSD: d.valueUSD, valueChgUSD: d.valueChgUSD, period: f.latest.period, quarter: f.latest.quarter,
        filed: f.latest.filed, url: f.latest.url, tag: d.tags.includes('in-book') ? 'in-book' : 'watchlist' });
    }
    bookHits.sort((a, b) => (a.tag === 'in-book' ? 0 : 1) - (b.tag === 'in-book' ? 0 : 1) || Math.abs(b.valueChgUSD) - Math.abs(a.valueChgUSD) || a.fund.localeCompare(b.fund));

    // events: a (fund, period) this file had never stored before, filed within EVENT_DAYS
    const seen = new Set();
    if (prev && prev.funds) for (const [id, f] of Object.entries(prev.funds)) {
      [f.latest, f.prior].concat(f.history || []).forEach(x => { if (x && x.period) seen.add(id + '|' + x.period); });
    }
    const fresh = [];
    for (const id of Object.keys(scanned)) {
      const f = funds[id], L = f && f.latest;
      if (!L || seen.has(id + '|' + L.period) || (Date.parse(today) - Date.parse(L.filed)) / 864e5 > EVENT_DAYS) continue;
      const n = a => f.diff.filter(d => d.action === a).length;
      fresh.push({ at: nowIso, fund: id, name: f.name, period: L.period, quarter: L.quarter, filed: L.filed, accession: L.accession, cik: L.cik, via: L.via,
        positions: L.positions, valueUSD: L.valueUSD, new: n('New'), added: n('Added'), reduced: n('Reduced'), exited: n('Exited'),
        bookHits: f.diff.filter(d => d.tags.length).map(d => ({ ticker: d.ticker, action: d.action, sharesChg: d.sharesChg, valueUSD: d.valueUSD })),
        url: L.url, ...(prev ? {} : { bootstrap: true }) });
    }
    const events = ((prev && prev.events) || []).filter(e => Date.now() - Date.parse(e.at) <= EVENT_DAYS * 864e5 && !fresh.some(x => x.fund === e.fund && x.period === e.period))
      .concat(fresh).sort((a, b) => b.at.localeCompare(a.at) || a.fund.localeCompare(b.fund));

    const excluded = cfg.funds.filter(f => !f.track).map(f => ({ id: f.id, name: f.name, kind: f.kind, why: f.why || null }));
    const out = {
      generatedAt: nowIso,
      scan: { checkedAt: nowIso, ok: !errors.some(e => e.stage !== 'figi'), secRequests, figiRequests, errors, bookSource },
      source: 'SEC EDGAR submissions, 13F cover pages and information tables (keyless); tickers via OpenFIGI (keyless)',
      deadlines: deadlinesAround(today), funds, excluded, consensus: cons, bookHits, events, integrity: unitsCrossCheck(sides),
    };
    const body = o => JSON.stringify({ ...o, generatedAt: null, scan: null });
    const changed = !prev || body(prev) !== body(out);
    let final = out;
    if (!changed) final = { ...prev, scan: { ...prev.scan, checkedAt: nowIso, ok: out.scan.ok, errors } };
    const text = JSON.stringify(final) + '\n';

    const cons5 = a => ((cons && cons[a]) || []).slice(0, 5).map(c => `${c.key}×${c.count}`).join(' ');
    console.log(`consensus ${cons ? `${cons.quarter} over ${cons.funds}/${cons.activeTracked} funds · New ${cons5('New')} · Exited ${cons5('Exited')}` : 'none'}`);
    console.log(`bookHits ${bookHits.length} (book from ${bookSource}) · integrity ${out.integrity.length} · events +${fresh.length}/${events.length} · errors ${errors.length}`);
    if (DRY) { console.log(`--dry-run: nothing written (13f.json would be ${changed ? 'rewritten' : 'stamped only'}, ${text.length} bytes) · ${secRequests} EDGAR / ${figiRequests} OpenFIGI request(s)`); return; }
    if (JSON.stringify(cache) !== cacheBefore) {
      const keys = Object.keys(cache).sort();
      atomicWrite(D('.cusips.json'), '{\n' + keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(cache[k])).join(',\n') + '\n}\n');
    }
    atomicWrite(D('13f.json'), text);
    console.log(`13f.json: ${changed ? 'content changed, rewritten' : 'unchanged, checkedAt stamped'} · ${text.length} bytes · ${secRequests} EDGAR / ${figiRequests} OpenFIGI request(s)`);
  })();
}

if (require.main === module) {
  main().catch(e => { console.error(`13f-scan: ${String((e && e.message) || e).split('\n')[0]}`); process.exit(1); });
}
