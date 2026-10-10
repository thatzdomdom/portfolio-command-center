#!/usr/bin/env node
/*
 * hkex-di.js — Hong Kong disclosure-of-interests notices for the book's HK names.
 *
 * Phase 7 of the 11 Sep 2026 redesign. The book is 3.0% HKEX across three lines (0700 Tencent,
 * 0981 SMIC, 1810 Xiaomi) and has never had insider coverage: form4-scan.js reads EDGAR, which
 * cannot see a Hong Kong filing, so the pages have said "HKEX/SGX insider coverage: not built"
 * since 12 Sep. This is form4-scan.js's twin for HKEX — same shape, same flags, same retention,
 * same rule that it stores FACTS and makes no judgment. alerts.js applies policy.json to these.
 *
 * SGX is deliberately absent. api.sgx.com's announcements service began requiring a credential in
 * Sep 2026 (403 from code, 401 from inside a real browser session), and scraping a key out of the
 * site's JavaScript or reading a third-party mirror is not acceptable here — the same principle
 * that struck Quiver and House Stock Watcher off the plan. SGX waits for the owner's own email
 * alerts and the reply reader (decision 7). Nothing in this file touches SGX.
 *
 * HKEX is keyless: a plain GET, no session, no POST, no viewstate, no login and no terms gate.
 * Two steps per code — resolve the stock code to HKEX's internal `sid` (cached, it is stable),
 * then read the "List of all notices within a specified period" table for the window. We send a
 * real Chrome User-Agent because unlike SEC, HKEX publishes no operator-identifying UA convention
 * to follow, an unknown UA was never tested against the site, and a public page answering a public
 * URL is exactly what a browser would ask for. 400 ms between requests, one retry on a 5xx.
 *
 * Three things about this source that a naive parser gets wrong, and that cost real money if they
 * go wrong silently:
 *
 *  1. THE REASON IS A CODE, NOT PROSE. The column reads "1205", not "sold the shares". Matching
 *     words is a trap: code 1004 is "you acquired a security interest in the shares" — a pledge
 *     against a stock-lending book, not a purchase — and 1205 is the release of that same pledge.
 *     Direction therefore comes from an explicit allow-list of HKEX's own standard codes (REASON
 *     below, transcribed from di.hkex.com.hk/di/NSStdCode.aspx?ft=CS and ?ft=DA on 19 Sep 2026).
 *     Only "you purchased the shares" is a buy and only "you completed a sale" is a sell; the
 *     top-up-placing legs are counted because they move shares for cash in a named direction.
 *     EVERYTHING ELSE IS 'other'. A 5% holder can cross a threshold because the company issued
 *     shares — SMIC's 24 Jun 2026 notice is exactly that, a crossing with no trade behind it —
 *     and reporting that as a sale would be an invented fact.
 *
 *  2. THERE ARE TWO DATES AND THEY ARE NOT THE SAME. The form serial encodes the FILING date
 *     (CS20260625E00375 was filed 25/06/2026, confirmed on its own detail page), while the table's
 *     "Date of relevant event" column is when the thing happened (23/06/2026 for that notice).
 *     HKEX allows three business days, so they routinely differ. `date` is the event date, because
 *     that is what a reader means by "when"; `filed` carries the serial's date and `filedLagDays`
 *     the gap. A field that cannot be parsed is null — never a guess.
 *
 *  3. THE TABLE PAGES AT 50 ROWS. Xiaomi over 01/01–19/09/2026 is 114 records across three pages;
 *     a parser that reads page 1 only loses two thirds of them and looks healthy doing it. We
 *     follow `pg=` until the rows we hold match the page's own "Total records", and say so in
 *     scan.errors if they never do.
 *
 * The Mac READS data/hkex.json; GitHub Actions (hkex-di.yml, 06:45 SGT) WRITES it, the same split
 * as 13f.json. If both could write, an Actions commit and a local edit of one tracked file would
 * make the 07:02 `git pull` refuse and turn the publish red. Off Actions this is therefore a dry
 * run unless --local says otherwise.
 *
 * Modes:  (default)       the last 7 days of relevant events (the scan is cheap, re-runs dedupe)
 *         --days N        widen the window          --code 1810   one stock code only
 *         --dry-run       parse and print, write nothing        --local  write from this machine
 */
const fs = require('fs'), path = require('path'), https = require('https');
const ROOT = path.join(__dirname, '..');
const D = f => path.join(ROOT, 'data', f);
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = k => args.includes(k);

const HOST = 'https://di.hkex.com.hk/di/';
const DAYS = Math.max(1, +(opt('--days') || 14) || 14);   // the window filters on the EVENT date; filing may lag it by days
const ONLY = (opt('--code') || '').replace(/\D/g, '') || null;
const RETENTION_DAYS = 45, SCAN_KEEP = 30, SID_MAX_AGE_DAYS = 90, PAGE_CAP = 40;
const READER = !process.env.GITHUB_ACTIONS && !has('--local');
const DRY = has('--dry-run') || READER;

// A real desktop Chrome UA. See the header: the site is public and unauthenticated, HKEX asks for
// no operator identification the way SEC does, and an unknown UA was never tested against it.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
function atomicWrite(file, text) { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
const sgtDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const ddmmyyyy = ymd => { const [y, m, d] = ymd.split('-'); return `${d}/${m}/${y}`; };

let requests = 0, lastReq = 0;
const raw = (url, depth = 0) => new Promise(res => {
  https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' }, timeout: 45e3 }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 4) {
      r.resume();
      return raw(new URL(r.headers.location, url).href, depth + 1).then(res);
    }
    let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
  }).on('error', e => res({ status: 0, body: e.message })).on('timeout', function () { this.destroy(new Error('timeout')); });
});
// 400 ms between requests, one retry with backoff on a 5xx or a dropped connection. HKEX is a
// small public service and this job asks it for three pages a day; there is no reason to push.
async function polite(url) {
  for (let attempt = 0; ; attempt++) {
    const wait = 400 - (Date.now() - lastReq);
    if (wait > 0) await sleep(wait);
    lastReq = Date.now(); requests++;
    const r = await raw(url);
    if (r.status === 200 || attempt >= 1 || !(r.status === 0 || r.status >= 500)) return r;
    await sleep(3000);
  }
}

// ── HTML helpers ────────────────────────────────────────────────────────────
// The notices table is server-rendered ASP.NET: no entities inside cells except &nbsp; and the
// occasional &amp;, <br> between the long/short/lending-pool lines of one cell.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const unent = s => String(s).replace(/&(#?\w+);/g, (m, k) => (k in ENT ? ENT[k] : (/^#\d+$/.test(k) ? String.fromCharCode(+k.slice(1)) : m)));
function cellText(html) {
  return unent(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/ /g, ' ').split('\n').map(s => s.trim()).filter(Boolean).join('\n');
}
const spanText = (html, id) => {
  const m = new RegExp(`<span id="${id}"[^>]*>([\\s\\S]*?)</span>`, 'i').exec(html);
  return m ? cellText(m[1]) : null;
};

// "1,065,871,110(L)\n30,260,800(S)" → [{position:'L',value:1065871110},{position:'S',value:30260800}]
// Commas go; a footnote marker after the number is ignored; a cell with a marker but no digits is
// a null value with a known position, which is the truth and not a zero.
function numsByPosition(text) {
  const out = [];
  for (const part of String(text || '').split('\n')) {
    const t = part.trim();
    if (!t) continue;
    const pos = (/\(([LSP])\)/.exec(t) || [])[1] || null;
    const n = (/-?[\d,]*\d(?:\.\d+)?/.exec(t.replace(/\((?:Note|Notes)[^)]*\)/gi, '').replace(/\([LSP]\)/g, '')) || [])[0];
    out.push({ position: pos, value: n == null ? null : Number(n.replace(/,/g, '')) });
  }
  return out;
}
function pickAt(list, position) {
  const hit = list.find(x => x.position === position);
  if (hit) return hit.value;
  if (list.length === 1 && (list[0].position === null || position === null)) return list[0].value;
  return null;
}
const ymdOf = dmy => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dmy || '').trim());
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[1] < 1 || +m[1] > 31) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
};
const ymdOfSerial = serial => {
  const m = /^[A-Z]+(\d{4})(\d{2})(\d{2})/.exec(String(serial || ''));
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
};
const daysBetween = (a, b) => (a && b) ? Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5) : null;

// ── the universe: the book's .HK lines, plus anything HK on the watchlist ───
function universe() {
  const out = new Map();
  let source = 'none';
  const codeOf = yf => { const m = /^(\d{3,5})\.HK$/i.exec(String(yf || '').trim()); return m ? (m[1].length < 4 ? m[1].padStart(4, '0') : m[1]) : null; };
  const add = (code, yf, name) => { if (code && !out.has(code)) out.set(code, { code, yf: yf || `${code}.HK`, bookName: name || null }); };
  const b = readJSON(D('book.json'));
  if (b && Array.isArray(b.holdings)) {
    b.holdings.forEach(h => add(codeOf(h.yf), h.yf, h.n));
    source = 'book.json';
  } else {
    // Actions has no book.json (it is private), exactly as 13f-scan.js finds. index.html's holdings
    // literals are the same rows and validate-all checks the two agree, so the universe is identical
    // on either machine.
    try {
      for (const line of fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').split('\n')) {
        if (!/^\s*\{id:\s*\d+,/.test(line)) continue;
        const m = /\byf:\s*["']([^"']+)["']/.exec(line);
        const n = /\bn:\s*["']([^"']+)["']/.exec(line);
        add(codeOf(m && m[1]), m && m[1], n && n[1]);
      }
      if (out.size) source = 'index.html';
    } catch (_) {}
  }
  const w = readJSON(D('watchlist.json'));
  if (w) for (const arr of Object.values(w)) {
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (!e || typeof e !== 'object') continue;
      const sym = [e.yf, e.t, e.symbol].find(x => /^\d{3,5}\.HK$/i.test(String(x || '').trim()));
      if (sym) { add(codeOf(sym), sym, e.n || null); continue; }
      const hk = String(e.hk == null ? '' : e.hk).trim();
      if (/^\d{4,5}$/.test(hk)) add(hk, `${hk}.HK`, e.n || null);
    }
  }
  return { list: [...out.values()].sort((a, b2) => a.code.localeCompare(b2.code)), source };
}

// ── step 1: stock code → HKEX's internal sid ────────────────────────────────
async function resolveSid(code, sd, ed) {
  const url = `${HOST}NSSrchCorpList.aspx?sa1=cl&scsd=${encodeURIComponent(sd)}&sced=${encodeURIComponent(ed)}&sc=${encodeURIComponent(code)}&src=MAIN&lang=EN`;
  const r = await polite(url);
  if (r.status !== 200) throw new Error(`sid lookup for ${code}: HTTP ${r.status}`);
  const m = /NSAllSSList\.aspx\?sa2=as&(?:amp;)?sid=(\d+)&(?:amp;)?corpn=([^&"'>]*)/i.exec(r.body);
  if (!m) throw new Error(`sid lookup for ${code}: no corporation link in the reply (delisted code, or the page changed)`);
  return { sid: m[1], name: unent(decodeURIComponent(m[2].replace(/\+/g, ' '))).trim() || null, at: sgtDate() };
}

// ── step 2: every notice in the window, following the 50-row pages ──────────
// corpn is NOT sent: the page resolves the name from sid on its own (verified — identical rows
// with and without it), and not round-tripping a name through URL encoding removes a whole class
// of bugs. The name we store comes from the page's own lblSCCorpName.
function noticesUrl(sid, code, sd, ed, page) {
  const q = [`sa2=an`, `sid=${encodeURIComponent(sid)}`, `sd=${encodeURIComponent(sd)}`, `ed=${encodeURIComponent(ed)}`,
    `cid=0`, `sa1=cl`, `scsd=${encodeURIComponent(sd)}`, `sced=${encodeURIComponent(ed)}`, `sc=${encodeURIComponent(code)}`, `src=MAIN`, `lang=EN`];
  if (page > 1) q.push(`pg=${page}`);
  return `${HOST}NSAllFormList.aspx?${q.join('&')}`;
}
function parseNoticesPage(html, code) {
  const echoed = (spanText(html, 'lblSCStockCode') || '').replace(/\D/g, '');
  if (echoed && echoed.replace(/^0+/, '') !== code.replace(/^0+/, '')) {
    throw new Error(`asked for ${code} and the page answered for ${echoed || '?'} — refusing to store it`);
  }
  const totalText = spanText(html, 'lblRecCount');
  const total = totalText && /^\d+$/.test(totalText.replace(/,/g, '')) ? +totalText.replace(/,/g, '') : null;
  const tm = /<table[^>]*id="grdPaging"[\s\S]*?<\/table>/i.exec(html);
  if (!tm && total === null) throw new Error('no notices table and no record count in the reply — the page shape changed');
  const rows = tm ? (tm[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) : [];
  const name = spanText(html, 'lblSCCorpName');
  const cells = tr => (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(td => cellText(td.replace(/^<td[^>]*>/i, '').replace(/<\/td>$/i, '')));
  const out = [];
  let want = null, skipped = 0;
  for (const tr of rows) {
    const c = cells(tr);
    // The header defines the column count. parseRow reads by position, so a row of a different width
    // has had a column added or dropped and every field after it would be wrong. Skip and count it.
    if (/Form Serial Number/i.test(c[0] || '')) { want = c.length; continue; }
    if (want == null ? c.length < 8 : c.length !== want) { if (c.length >= 4) skipped++; continue; }
    const href = /href="(NSForm[^"]*)"/i.exec(tr);
    out.push({ c, href: href ? unent(href[1]) : null });
  }
  return { name, total, rows: out, hasTable: !!tm, skipped, columns: want };
}

// Columns, verbatim from the header row on 19 Sep 2026 (ten of them, not six):
// 0 Form Serial Number · 1 Name of substantial shareholder / director / chief executive ·
// 2 Reason for disclosure · 3 No. of shares bought / sold / involved · 4 Average price per share ·
// 5 No. of shares interested · 6 % of issued voting shares · 7 Date of relevant event (dd/mm/yyyy) ·
// 8 Interests in shares of associated corporation · 9 Interests in debentures
function parseRow(row, holding, corpName) {
  const c = row.c;
  const serial = (/^[A-Z0-9]+$/.test(c[0]) ? c[0] : (/([A-Z]{2}\d{8}[A-Z]\d+)/.exec(c[0]) || [])[1]) || null;
  if (!serial) return null;
  const form = row.href ? ((/NSForm([0-9A-Z]+)\.aspx/i.exec(row.href) || [])[1] || null) : null;
  const role = form == null ? null : (/^[12]$/.test(form) ? 'substantial-shareholder' : (/^3/.test(form) ? 'director-or-ceo' : null));
  const reasons = String(c[2] || '').split('\n').map(t => {
    const code = (/\d{4,5}/.exec(t) || [])[0] || null;
    return { code, position: (/\(([LSP])\)/.exec(t) || [])[1] || null, text: (code && REASON[code]) || null };
  }).filter(r => r.code);
  const involved = numsByPosition(c[3]), after = numsByPosition(c[5]), pcts = numsByPosition(c[6]);
  const position = (reasons[0] && reasons[0].position) || (after[0] && after[0].position) || null;
  const priceText = String(c[4] || '').replace(/\n/g, ' ').trim();
  const priceNum = (/-?[\d,]*\d(?:\.\d+)?/.exec(priceText.replace(/\((?:Note|Notes)[^)]*\)/gi, '')) || [])[0];
  const posKeys = [...new Set(after.concat(pcts).map(x => x.position))];
  const date = ymdOf(c[7]), filed = ymdOfSerial(serial);
  const codes = reasons.map(r => r.code);
  const bought = codes.some(k => BUY.has(k)), sold = codes.some(k => SELL.has(k));
  return {
    id: `${holding.code}:${serial}`,
    code: holding.code,
    yf: holding.yf,
    name: corpName || holding.bookName || null,
    serial,
    form,
    role,
    filer: c[1] ? c[1].replace(/\n/g, ' ').trim() : null,
    reason: (reasons[0] && reasons[0].code) || null,
    reasonText: (reasons[0] && reasons[0].text) || null,
    reasons,
    // buy and sell are an allow-list of HKEX's own codes; a code that is neither, or a row that
    // somehow claims both, is 'other'. See note 1 in the header.
    direction: (bought && !sold) ? 'buy' : ((sold && !bought) ? 'sell' : 'other'),
    sharesInvolved: pickAt(involved, position),
    avgPrice: priceNum == null ? null : Number(priceNum.replace(/,/g, '')),
    currency: (/\b([A-Z]{3})\b/.exec(priceText) || [])[1] || null,
    sharesAfter: pickAt(after, position),
    pctAfter: pickAt(pcts, position),
    position,
    interests: posKeys.map(p => ({ position: p, shares: pickAt(after, p), pct: pickAt(pcts, p) })),
    date,
    filed,
    filedLagDays: daysBetween(filed, date),
    url: row.href ? HOST + row.href : null,
  };
}

async function scanCode(holding, sd, ed, sids, errors) {
  const code = holding.code;
  let cached = sids[code];
  const stale = !cached || !cached.sid || !cached.at || (Date.now() - Date.parse(cached.at + 'T00:00:00Z')) / 864e5 > SID_MAX_AGE_DAYS;
  if (stale) { cached = await resolveSid(code, sd, ed); sids[code] = cached; }
  let page = 1, total = null, name = null, out = [], seenPage = new Set();
  for (;;) {
    const r = await polite(noticesUrl(cached.sid, code, sd, ed, page));
    if (r.status !== 200) throw new Error(`notices for ${code} page ${page}: HTTP ${r.status}`);
    let p;
    try { p = parseNoticesPage(r.body, code); }
    catch (e) {
      // A sid that no longer answers is the spec's re-resolve trigger; try once from scratch.
      if (page === 1 && !stale) {
        cached = await resolveSid(code, sd, ed); sids[code] = cached;
        const r2 = await polite(noticesUrl(cached.sid, code, sd, ed, 1));
        if (r2.status !== 200) throw new Error(`notices for ${code} after re-resolving sid: HTTP ${r2.status}`);
        p = parseNoticesPage(r2.body, code);
      } else throw e;
    }
    if (page === 1) { total = p.total; name = p.name; }
    const before = out.length;
    for (const row of p.rows) {
      const f = parseRow(row, holding, name);
      if (f && !seenPage.has(f.serial)) { seenPage.add(f.serial); out.push(f); }
    }
    if (total == null || out.length >= total || out.length === before || page >= PAGE_CAP) break;
    page++;
  }
  if (total != null && out.length !== total) {
    errors.push({ code, stage: 'paging', message: `${code}: the page says ${total} record(s) and ${out.length} parsed — rows may be missing` });
  }
  return { sid: cached.sid, name: name || cached.name || holding.bookName || null, total, rows: out, pages: page };
}

// ── HKEX standard codes, leaf codes only ────────────────────────────────────
// Transcribed 19 Sep 2026 from di.hkex.com.hk/di/NSStdCode.aspx?ft=CS (Form 1/2, substantial
// shareholders) and ?ft=DA (Form 3A/3B, directors and chief executives), which publish the same
// leaf codes with a handful of wording differences — Form 2's wording is stored and Form 3A's is
// noted where it differs. Group headers (100, 110, 120, 130, 140, 150, 160, 170) are omitted
// because the "Reason for disclosure" column only ever prints a leaf.
const BUY = new Set([
  '1001', '1101',        // you purchased the shares
  '1010', '1110',        // you were placed the shares as a placee under a top-up placing
  '1011', '1111',        // new shares were issued to you after placing your own to placees
]);
const SELL = new Set([
  '1201',                // you completed a sale of the shares
  '1209',                // you placed the shares to placee(s) under a top-up placing
]);

const REASON = {
  1001: "you purchased the shares",
  1002: "you were given the shares",
  1003: "you became the holder of, wrote or issued equity derivatives under which (choose one):",
  10031: "you have a right to take the underlying shares",
  10032: "you are under an obligation to take the underlying shares",
  10033: "you have a right to receive from another person an amount if the price of the underlying shares is above a certain level",
  10034: "you are under an obligation to pay another person an amount if the price of the underlying shares is below a certain level",
  10035: "you have any of the rights or obligations referred to in 10031 to 10034 above embedded in a contract or instrument",
  1004: "you acquired a security interest in the shares",
  1005: "you inherited the shares",
  1006: "you became a beneficiary under a trust interested in the shares",
  1007: "you took steps to enforce your rights in the shares you hold by way of security as a qualified lender",
  1009: "you entered into an agreement for the exchange of an instrument for another instrument in respect of the same underlying shares",
  1010: "you were placed the shares as a placee under a top-up placing",
  1011: "new shares were issued to you after you have reduced your interest in shares by placing them to placee(s) under a top-up placing",
  1012: "you became a member of a concert party group or a member of the concert party group acquired more of the shares",
  1013: "any other event (you must briefly describe the relevant event in the Supplementary Information box)",
  1101: "you purchased the shares",
  1102: "you were given the shares",
  1103: "you became the holder of, wrote or issued equity derivatives under which (choose one):",
  11031: "you have a right to take the underlying shares",
  11032: "you are under an obligation to take the underlying shares",
  11033: "you have a right to receive from another person an amount if the price of the underlying shares is above a certain level",
  11034: "you are under an obligation to pay another person an amount if the price of the underlying shares is below a certain level",
  11035: "you have any of the rights or obligations referred to in 11031 to 11034 above embedded in a contract or instrument",
  1104: "you acquired a security interest in the shares",
  1105: "you inherited the shares",
  1106: "you became a beneficiary under a trust interested in the shares",
  1107: "you took steps to enforce your rights in the shares you hold by way of security as a qualified lender",
  1108: "your spouse ceased to be a director or chief executive of the listed corporation",
  1109: "you entered into an agreement for the exchange of an instrument for another instrument in respect of the same underlying shares",
  1110: "you were placed the shares as a placee under a top-up placing",
  1111: "new shares were issued to you after you have reduced your interest in shares by placing them to placee(s) under a top-up placing",
  1112: "you became a member of a concert party group or a member of the concert party group acquired more of the shares",
  1113: "any other event (you must briefly describe the relevant event in the Supplementary Information box)",
  1201: "you completed a sale of the shares",
  1202: "you made a gift of the shares",
  1203: "you delivered the shares or an amount due under equity derivatives",
  1204: "expiry or cancellation without exercise of equity derivatives under which (choose one):",
  12041: "you had a right to take the underlying shares",
  12042: "you were under an obligation to take the underlying shares",
  12043: "you had a right to receive from another person an amount if the price of the underlying shares was above a certain level",
  12044: "you were under an obligation to pay another person an amount if the price of the underlying shares was below a certain level",
  12045: "you had any of the rights or obligations referred to in 12041 to 12044 above embedded in a contract or instrument",
  1205: "you ceased to have a security interest in the shares",
  1206: "you did not take up, or sold, rights in a rights issue",
  1207: "your spouse became a director or chief executive of the listed corporation",
  1208: "you entered into an agreement for the exchange of an instrument for another instrument in respect of the same underlying shares",
  1209: "you placed the shares to placee(s) under a top-up placing",
  1210: "new shares were issued in a top-up placing",
  1211: "you have ceased to be a member of a concert party group or a member of the concert party group has disposed of some of the shares",
  1213: "any other event (you must briefly describe the relevant event in the Supplementary Information box)",
  1301: "the shares have been delivered to you and you have not previously notified the purchase of the shares",
  1302: "you have entered into an agreement for the sale of shares in which you are interested but are not required to deliver them within 4 trading days",   // Form 3A/3B wording: you have entered into an agreement for the sale of shares in which you are interested
  1303: "you have exercised rights to the shares under equity derivatives",
  1304: "rights to the shares under equity derivatives have been exercised against you",
  1305: "you have provided an interest in the shares as security to a person other than a qualified lender",
  1306: "an interest in the shares, that you provided as security to a person other than a qualified lender, has been released",
  1307: "you have taken steps to enforce a security interest in the shares, or rights to such shares held as security, and you are not a qualified lender",
  1308: "steps have been taken to enforce a security interest in the shares, or rights to such shares held as security, against you",
  1309: "you are a beneficiary under a will and the shares have been transferred to you by an executor",
  1310: "you are a beneficiary under a trust and the shares have been transferred to you by a trustee",
  1311: "you have delivered the shares to a person who had agreed to borrow them",
  1312: "the shares lent by you have been returned to you",
  1313: "you have lent the shares under a securities borrowing and lending agreement",
  1314: "you have recalled the shares under a securities borrowing and lending agreement",
  1315: "you have declared a trust over shares that you continue to hold",
  1316: "any other event (you must briefly describe the relevant event in the Supplementary Information box)",
  1401: "you became the holder of, wrote or issued equity derivatives under which (choose one):",
  14011: "you have a right to require another person to take delivery of the underlying shares",
  14012: "you are under an obligation to deliver the underlying shares",
  14013: "you have a right to receive from another person an amount if the price of the underlying shares is below a certain level",
  14014: "you are under an obligation to pay another person an amount if the price of the underlying shares is above a certain level",
  14015: "you have any of the rights or obligations referred to in 14011 to 14014 above embedded in a contract or instrument",
  1402: "you borrowed the shares under a securities borrowing and lending agreement",
  1403: "any other event (you must briefly describe the relevant event in the Supplementary Information box)",
  1501: "expiry or cancellation without exercise of equity derivatives under which (choose one):",
  15011: "you have a right to require another person to take delivery of the underlying shares",
  15012: "you are under an obligation to deliver the underlying shares",
  15013: "you have a right to receive from another person an amount if the price of the underlying shares is below a certain level",
  15014: "you are under an obligation to pay another person an amount if the price of the underlying shares is above a certain level",
  15015: "you have any of the rights or obligations referred to in 15011 to 15014 above embedded in a contract or instrument",
  1502: "you returned the shares borrowed under a securities borrowing and lending agreement",
  1503: "any other event (you must briefly describe the relevant event in the Supplementary Information box)",
  1601: "Notice under section 5(4) of the Securities and Futures (Disclosure of Interests \u2013 Securities Borrowing and Lending) Rules by an approved lending agent (choose one):",
  16011: "the percentage level of your interest in the shares held in your lending pool is taken to have increased",
  16012: "the percentage level of your interest in the shares held in your lending pool is taken to have reduced",
  1602: "Notice under section 5(4) of the Securities and Futures (Disclosure of Interests \u2013 Securities Borrowing and Lending) Rules by a person that controls an approved lending agent (choose one):",
  16021: "the percentage level of your interest in the shares held in the lending pool of the approved lending agent is taken to have increased",
  16022: "the percentage level of your interest in the shares held in the lending pool of the approved lending agent is taken to have reduced",
  1701: "On listing of the corporation or a class of shares of the listed corporation",
  1702: "Notice filed to remove outdated information (if you select this Code you must state the outdated information in the Supplementary Information box and identify the box which contains the updated information)",
  1703: "Notice filed because of a change in the threshold for disclosure",
  1704: "Notice filed because you ceased to have a notifiable interest in the shares of the listed corporation (you must briefly describe the relevant event in the Supplementary Information box)",
  1705: "Notice filed because you became a director or chief executive of the listed corporation",
  1706: "Notice filed because you ceased to be a director or chief executive of the listed corporation",
  1710: "Voluntary disclosure (you must briefly describe the relevant event in the Supplementary Information box)",
  1711: "Other (you must briefly describe the relevant event in the Supplementary Information box)",
};

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const today = sgtDate(), nowIso = new Date().toISOString();
  const start = new Date(Date.parse(today + 'T00:00:00Z') - (DAYS - 1) * 864e5).toISOString().slice(0, 10);
  const sd = ddmmyyyy(start), ed = ddmmyyyy(today);
  const { list, source: bookSource } = universe();
  const targets = ONLY ? list.filter(h => h.code.replace(/^0+/, '') === ONLY.replace(/^0+/, '')) : list;
  if (ONLY && !targets.length) { console.error(`hkex-di: --code ${ONLY} is not in the book or the watchlist`); process.exit(1); }
  if (!targets.length) { console.error(`hkex-di: no .HK holding found (book source: ${bookSource}) — nothing to scan`); process.exit(1); }
  console.log(`hkex-di: ${targets.length} code(s) from ${bookSource} · relevant events ${sd} – ${ed} (${DAYS}d)`);

  const prev = readJSON(D('hkex.json'));
  const sids = readJSON(D('.hkex-sids.json')) || {};
  const sidsBefore = JSON.stringify(sids);
  const errors = [], universeOut = [];
  let rowsSeen = 0, tablesRead = 0;
  const found = [];
  for (const h of targets) {
    try {
      const s = await scanCode(h, sd, ed, sids, errors);
      tablesRead++; rowsSeen += s.rows.length;
      universeOut.push({ code: h.code, yf: h.yf, name: s.name, sid: s.sid });
      s.rows.forEach(f => found.push(f));
      const newest = s.rows.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      console.log(`  ${h.code} ${String(s.name || '').slice(0, 42).padEnd(42)} sid ${String(s.sid).padEnd(7)} ${String(s.rows.length).padStart(3)} row(s)${s.pages > 1 ? ` over ${s.pages} pages` : ''}${newest ? ` · newest ${newest.date} ${newest.filer} ${newest.reason}` : ''}`);
    } catch (e) {
      errors.push({ code: h.code, stage: 'fetch', message: e.message });
      universeOut.push({ code: h.code, yf: h.yf, name: (sids[h.code] && sids[h.code].name) || h.bookName || null, sid: (sids[h.code] && sids[h.code].sid) || null });
      console.log(`  ${h.code} FAILED: ${e.message}`);
    }
  }
  // Zero notices is a normal quiet week — Tencent filed one in ninety days. Zero TABLES is the
  // feed being down, and the workflow must not commit that over a good file.
  if (!tablesRead) { console.error(`hkex-di: every code failed — first: ${errors[0] && errors[0].message}`); process.exit(1); }

  const seen = new Set(((prev && prev.filings) || []).map(f => f.id));
  const fresh = found.filter(f => !seen.has(f.id));
  // Retention is 45 days of relevant-event dates, floored by the window actually asked for: if the
  // operator says --days 90 they want ninety days, and pruning them away inside the same run would
  // make the wide scan pointless. A normal --days 7 run therefore keeps the plain 45-day archive.
  const cutoff = [new Date(Date.parse(today + 'T00:00:00Z') - RETENTION_DAYS * 864e5).toISOString().slice(0, 10), start]
    .sort()[0];
  const byId = new Map();
  for (const f of ((prev && prev.filings) || []).concat(found)) byId.set(f.id, f);
  const filings = [...byId.values()]
    .filter(f => (f.date || f.filed || '') >= cutoff)
    .sort((a, b) => String(b.date || b.filed || '').localeCompare(String(a.date || a.filed || '')) || String(a.id).localeCompare(String(b.id)));

  // A --code run scans one name; it must not shrink the stored universe to that one name, or the
  // next reader would think the book had lost two HK lines. A full run replaces the list, so a
  // holding sold out of the book does eventually drop off.
  const universeFinal = ONLY
    ? [...((prev && prev.universe) || []).filter(u => !universeOut.some(n => n.code === u.code)), ...universeOut].sort((a, b) => a.code.localeCompare(b.code))
    : universeOut;

  const scanEntry = { date: today, at: nowIso, codes: tablesRead, rows: rowsSeen, kept: fresh.length };
  if (errors.length) scanEntry.error = errors[0].message;
  const out = {
    generatedAt: nowIso,
    source: 'HKEX Disclosure of Interests (di.hkex.com.hk), notices list per stock code (keyless, public)',
    bookSource,
    // A single code failing (delisted, renamed, a flaky reply) must not discard the others' filings:
    // ok is false only when every code in the universe failed. partial says the run was incomplete.
    scan: { checkedAt: nowIso, ok: errors.length < Math.max(1, universeFinal.length), partial: errors.length > 0, errors, requests },
    universe: universeFinal,
    filings,
    scans: (((prev && prev.scans) || []).concat([scanEntry])).slice(-SCAN_KEEP),
  };
  // `scans` is bookkeeping like `scan`, so it is excluded from the change test: a quiet day must
  // re-stamp the file (validate-all fails the feed at 4 days silent) without churning the body.
  const body = o => JSON.stringify({ ...o, generatedAt: null, scan: null, scans: null });
  const changed = !prev || body(prev) !== body(out);
  const final = changed ? out : { ...prev, scan: out.scan, scans: out.scans };
  const text = JSON.stringify(final) + '\n';

  const x = filings.find(f => f.code === '1810') || filings[0];
  if (x) console.log(`sample row · ${JSON.stringify(x)}`);
  console.log(`filings: +${fresh.length} new · ${filings.length} retained (${RETENTION_DAYS}d) · ${requests} request(s) · ${errors.length} error(s)`);
  if (DRY) { console.log(`--dry-run: nothing written (hkex.json would be ${changed ? 'rewritten' : 'stamped only'}, ${text.length} bytes)`); return; }
  if (JSON.stringify(sids) !== sidsBefore) atomicWrite(D('.hkex-sids.json'), JSON.stringify(sids, null, 2) + '\n');
  atomicWrite(D('hkex.json'), text);
  console.log(`hkex.json: ${changed ? 'content changed, rewritten' : 'unchanged, checkedAt stamped'} · ${text.length} bytes`);
}

// Run only when invoked directly. fixtures/20-hkex.js requires this file to assert the parser
// against a stored copy of a real notices page with the network unplugged, and must not set off a
// scan by importing it.
if (require.main === module) {
  if (READER && !has('--dry-run')) console.log('hkex-di: not on GitHub Actions — running as a dry run; pass --local to write data/hkex.json from this machine');
  main().catch(e => { console.error(`hkex-di: ${e && e.message ? e.message : e}`); process.exit(1); });
}

module.exports = { parseNoticesPage, parseRow, numsByPosition, pickAt, cellText, ymdOf, ymdOfSerial, universe, REASON, BUY, SELL };
