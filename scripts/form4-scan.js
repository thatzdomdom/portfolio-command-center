#!/usr/bin/env node
/*
 * form4-scan.js — insider trades, MARKET-WIDE, from the primary source, in code.
 *
 * Phase 2 of the 11 Sep 2026 redesign: the Dell fix. The retired poller asked "which 15 tickers
 * do I care about" and polled their Form 4s. Dell was not one of them, so three insider trades
 * went unseen. This asks the other question — "what notable insider activity happened anywhere
 * today, and does it touch me" — by reading EDGAR's daily form index (every filing of every type,
 * ~1,000 Form 4s a weekday), fetching each Form 4's submission file (the XML is inline), and
 * writing the parsed FACTS to data/signals.json. It makes no judgment: alerts.js applies
 * policy.json to these facts.
 *
 * Keyless. SEC asks for a User-Agent naming the operator and a contact; SEC_UA is read from the
 * environment (on the Mac: ~/.claude/portfolio-brief.env; on GitHub Actions: a secret) so nothing
 * personal is hardcoded in a public repo. Rate: ~4.5 requests/s against SEC's cap of 10.
 *
 * Modes:  (default)         the last 2 EDGAR business days (covers both daily passes)
 *         --date YYYYMMDD   one index day            --days N       last N business days
 *         --cik 1571996[,…] only filings by those issuer CIKs (targeted; e.g. "what did Dell file")
 *         --limit N         at most N Form 4 fetches (testing)     --no-13   skip SC 13D/13G
 */
const fs = require('fs'), path = require('path'), https = require('https');
const D = f => path.join(__dirname, '..', 'data', f);
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = k => args.includes(k);

function readEnv() { const o = {}; try { fs.readFileSync(path.join(process.env.HOME || '', '.claude', 'portfolio-brief.env'), 'utf8')
  .split('\n').forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].trim(); }); } catch (_) {} return o; }
const env = readEnv();
const UA = process.env.SEC_UA || env.SEC_UA || (env.EMAIL_FROM ? `Dominic Zhao portfolio-dashboard ${env.EMAIL_FROM}` : null);
if (!UA) { console.error('form4-scan: no SEC_UA (and no EMAIL_FROM to build one) — SEC requires an identifying User-Agent. Refusing.'); process.exit(78); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => new Promise(res => {
  https.get(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' } }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(r.headers.location).then(res);
    let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
  }).on('error', e => res({ status: 0, body: e.message }));
});
let lastReq = 0;
async function polite(url) { const wait = 220 - (Date.now() - lastReq); if (wait > 0) await sleep(wait); lastReq = Date.now(); return get(url); }

// ── which index days ────────────────────────────────────────────────────────
const etDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const isWeekday = ymd => { const dow = new Date(ymd + 'T12:00:00Z').getUTCDay(); return dow >= 1 && dow <= 5; };
function businessDays(n, endYmd) {
  const out = []; let d = new Date(endYmd + 'T12:00:00Z');
  while (out.length < n) { const y = d.toISOString().slice(0, 10); if (isWeekday(y)) out.push(y); d.setUTCDate(d.getUTCDate() - 1); }
  return out.reverse();
}
let days;
if (opt('--date')) days = [opt('--date').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')];
else {
  // The current ET day's index is not posted until the evening; a run at 12:15 ET got 503/403 for
  // it. Count the current day as complete only after 22:00 ET (EDGAR's filing cutoff).
  const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).formatToParts(new Date()).find(x => x.type === 'hour');
  const endYmd = (+et.value >= 22) ? etDate(new Date()) : etDate(new Date(Date.now() - 864e5));
  days = businessDays(+(opt('--days') || 2), endYmd);
}
const onlyCiks = opt('--cik') ? new Set(opt('--cik').split(',').map(s => String(+s))) : null;
const limit = +(opt('--limit') || 0);

// ── index parsing ───────────────────────────────────────────────────────────
// Fixed-width text; columns are separated by 2+ spaces. Form types may contain a space ("SC 13D/A").
const LINE = /^(\S+(?: \S+)*?)\s{2,}(.+?)\s{2,}(\d+)\s{2,}(\d{8})\s{2,}(edgar\/\S+)\s*$/;
function indexUrl(ymd) { const [y, m] = ymd.split('-'); const q = Math.floor((+m - 1) / 3) + 1; return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${ymd.replace(/-/g, '')}.idx`; }

// ── Form 4 parsing (XML is inline in the submission .txt) ──────────────────
function parseForm4(txt) {
  const xml = (txt.match(/<XML>([\s\S]*?)<\/XML>/i) || [])[1] || txt;
  if (!/ownershipDocument/i.test(xml)) return null;
  const one = (re, src = xml) => { const m = src.match(re); return m ? m[1].trim() : null; };
  const owners = (xml.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/gi) || []).map(b => ({
    name: one(/<rptOwnerName>([^<]+)</i, b), cik: one(/<rptOwnerCik>([^<]+)</i, b),
    isDir: /<isDirector>\s*(1|true)/i.test(b),
    isOff: /<isOfficer>\s*(1|true)/i.test(b), is10: /<isTenPercentOwner>\s*(1|true)/i.test(b),
    title: one(/<officerTitle>([^<]+)</i, b) }));
  const txns = (xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) || []).map(b => {
    const g = re => one(re, b);
    const shares = g(/<transactionShares>[\s\S]*?<value>([^<]+)</i), price = g(/<transactionPricePerShare>[\s\S]*?<value>([^<]+)</i);
    return { code: g(/<transactionCode>([^<]+)</i), ad: g(/<transactionAcquiredDisposedCode>[\s\S]*?<value>([^<]+)</i),
      date: g(/<transactionDate>[\s\S]*?<value>([^<]+)</i), shares: shares ? +shares : null, price: price ? +price : null,
      after: (v => v ? +v : null)(g(/<sharesOwnedFollowingTransaction>[\s\S]*?<value>([^<]+)</i)),
      aff10b5: /<aff10b5One>\s*(1|true)/i.test(b) };
  }).filter(t => t.code);
  return {
    issuer: { cik: one(/<issuerCik>([^<]+)</i), name: one(/<issuerName>([^<]+)</i), ticker: (one(/<issuerTradingSymbol>([^<]+)</i) || '').toUpperCase() || null },
    owners, aff10b5Doc: /<aff10b5One>\s*(1|true)/i.test(xml), txns,
  };
}
// SC 13D / 13G: header blocks give subject and filer; percent is best-effort (XML since Dec 2024, else prose)
function parse13(txt) {
  const block = (label) => { const m = txt.match(new RegExp(label + ':[\\s\\S]*?COMPANY CONFORMED NAME:\\s*([^\\n]+)[\\s\\S]*?CENTRAL INDEX KEY:\\s*(\\d+)', 'i')); return m ? { name: m[1].trim(), cik: String(+m[2]) } : null; };
  const subject = block('SUBJECT COMPANY'), filer = block('FILED BY');
  const pct = (txt.match(/<percentOfClass>\s*([\d.]+)/i) || txt.match(/Percent of class[^\d]{0,80}([\d]{1,2}(?:\.\d+)?)\s*%/i) || [])[1];
  return { subject, filer, percent: pct ? +pct : null };
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const prior = (() => { try { return JSON.parse(fs.readFileSync(D('signals.json'), 'utf8')); } catch (_) { return { form4: [], sc13: [], scans: [] }; } })();
  const seen = new Set(prior.form4.map(f => f.id).concat(prior.sc13.map(f => f.id)));
  const added = { form4: [], sc13: [] }; let fetched = 0;
  for (const ymd of days) {
    const url = indexUrl(ymd);
    const r = await polite(url);
    if (r.status !== 200) { prior.scans.push({ date: ymd, at: new Date().toISOString(), error: `index HTTP ${r.status}` }); console.log(`  ${ymd}: index HTTP ${r.status} (holiday or not yet posted)`); continue; }
    const rows = r.body.split('\n').map(l => LINE.exec(l)).filter(Boolean)
      .map(m => ({ form: m[1], name: m[2].trim(), cik: String(+m[3]), filed: m[4], path: m[5] }));
    const f4 = rows.filter(x => x.form === '4' || x.form === '4/A'), s13 = has('--no-13') ? [] : rows.filter(x => /^SC 13[DG]/.test(x.form));
    let parsed = 0, skipped = 0, kept = 0;
    for (const row of f4) {
      if (onlyCiks && !onlyCiks.has(row.cik)) continue;
      const id = row.path.match(/(\d{10}-\d{2}-\d{6})/)?.[1] || row.path; if (seen.has(id)) continue;
      if (limit && fetched >= limit) break;
      const t = await polite(`https://www.sec.gov/Archives/${row.path}`); fetched++;
      if (t.status !== 200) { skipped++; continue; }
      const p = parseForm4(t.body); if (!p) { skipped++; continue; }
      parsed++;
      const info = p.txns.filter(x => x.code === 'P' || x.code === 'S');
      if (!info.length) continue;               // grants / exercises / withholding only — not stored
      kept++;
      const rec = { id, form: row.form, filed: row.filed, indexName: row.name, indexCik: row.cik, issuer: p.issuer, owners: p.owners,
        aff10b5: p.aff10b5Doc || p.txns.some(x => x.aff10b5), txns: info, url: `https://www.sec.gov/Archives/${row.path}` };
      added.form4.push(rec); seen.add(id);
    }
    let kept13 = 0;
    for (const row of s13) {
      const id = row.path.match(/(\d{10}-\d{2}-\d{6})/)?.[1] || row.path; if (seen.has(id)) continue;
      const t = await polite(`https://www.sec.gov/Archives/${row.path}`); fetched++;
      if (t.status !== 200) continue;
      const p = parse13(t.body); kept13++;
      added.sc13.push({ id, form: row.form, filed: row.filed, indexName: row.name, indexCik: row.cik, ...p, url: `https://www.sec.gov/Archives/${row.path}` }); seen.add(id);
    }
    prior.scans.push({ date: ymd, at: new Date().toISOString(), form4Lines: f4.length, sc13Lines: s13.length, parsed, kept, skipped, kept13, targeted: !!onlyCiks });
    console.log(`  ${ymd}: ${f4.length} Form 4 lines · parsed ${parsed} · kept ${kept} with P/S · skipped ${skipped} · 13D/G ${s13.length} (${kept13} kept)`);
  }
  const cutoff = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const out = {
    generatedAt: new Date().toISOString(), source: 'SEC EDGAR daily form index + submission files (keyless)', retentionDays: 45,
    form4: prior.form4.concat(added.form4).filter(f => f.filed >= cutoff).sort((a, b) => b.filed.localeCompare(a.filed)),
    sc13: prior.sc13.concat(added.sc13).filter(f => f.filed >= cutoff).sort((a, b) => b.filed.localeCompare(a.filed)),
    scans: prior.scans.slice(-60),
  };
  fs.writeFileSync(D('signals.json'), JSON.stringify(out) + '\n');
  console.log(`signals.json: +${added.form4.length} Form 4 / +${added.sc13.length} 13D/G this run · ${out.form4.length} / ${out.sc13.length} retained (45d) · ${fetched} fetches`);
})();
