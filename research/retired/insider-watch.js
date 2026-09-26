#!/usr/bin/env node
/*
 * insider-watch.js — near-real-time SEC Form 4 alerts on the names that matter
 * to this book, plus a queue the morning brief drains.
 *
 * SCOPE, HONESTLY: this covers US-listed names only. SEC EDGAR publishes Form 4
 * as clean JSON within minutes of filing, so "the moment it is filed" is real
 * here (poll every 20 min). SGX and HKEX have NO equivalent open feed — SGX's
 * api.sgx.com demands an auth token, its site is a JS shell, HKEX redirects —
 * so Singapore/HK insider activity stays with the daily research agent. Do not
 * let the dashboard imply otherwise.
 *
 *   node scripts/insider-watch.js            poll, alert on anything new
 *   node scripts/insider-watch.js --dry-run  poll and print, never alert/persist
 *   node scripts/insider-watch.js --seed     mark everything current as seen
 *                                            (first install, so you don't get
 *                                             a flood of historical filings)
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const UA = 'Dominic Zhao portfolio-dashboard thatzdomdom@gmail.com';
const STATE = path.join(process.env.HOME, '.claude', 'insider-watch-seen.json');
const QUEUE = path.join(__dirname, '..', 'data', '.insider-queue.json'); // drained by daily-brief.js
const DRY = process.argv.includes('--dry-run'), SEED = process.argv.includes('--seed');
const MAX_ALERT_EMAILS_PER_DAY = 3;   // beyond this, items still reach the morning brief

// The silver/gold miner complex is the book's largest risk, plus the rare-earth
// watchlist. ETFs are deliberately absent — they have no insiders.
const WATCH = {
  MP: 'MP Materials', UUUU: 'Energy Fuels', USAR: 'USA Rare Earth',
  NEM: 'Newmont', GOLD: 'Barrick', AEM: 'Agnico Eagle',
  PAAS: 'Pan American Silver', AG: 'First Majestic', FSM: 'Fortuna',
  HL: 'Hecla', CDE: 'Coeur', WPM: 'Wheaton PM', SSRM: 'SSR Mining',
  EXK: 'Endeavour Silver', MAG: 'MAG Silver',
};

const getJson = url => {
  const r = spawnSync('curl', ['-s', '--compressed', '--max-time', '25', '-H', `User-Agent: ${UA}`, '-H', 'Accept: application/json', url], { encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse(r.stdout); } catch (_) { return null; }
};
const getText = url => {
  const r = spawnSync('curl', ['-s', '--compressed', '--max-time', '25', '-H', `User-Agent: ${UA}`, url], { encoding: 'utf8', timeout: 30000 });
  return r.stdout || '';
};
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } };
const readEnv = () => { const o = {}; try { fs.readFileSync(path.join(process.env.HOME, '.claude', 'portfolio-brief.env'), 'utf8')
  .split('\n').forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].trim(); }); } catch (_) {} return o; };

// ── resolve tickers → CIK (cached; EDGAR asks you not to hammer this file) ──
function cikMap(state) {
  const age = Date.now() - (state.cikFetchedAt || 0);
  if (state.ciks && Object.keys(state.ciks).length && age < 30 * 864e5) return state.ciks;
  const j = getJson('https://www.sec.gov/files/company_tickers.json');
  if (!j) return state.ciks || {};
  const out = {};
  Object.values(j).forEach(x => { if (WATCH[x.ticker]) out[x.ticker] = String(x.cik_str).padStart(10, '0'); });
  state.ciks = out; state.cikFetchedAt = Date.now();
  return out;
}

// ── Form 4 XML → the facts a human actually wants ──
// transactionCode P = open-market purchase, S = sale, A = award/grant,
// M = option exercise, F = tax withholding. P and S are the signal; the rest is comp.
const CODE = { P: 'open-market BUY', S: 'sale', A: 'grant/award', M: 'option exercise', F: 'tax withholding', G: 'gift', C: 'conversion', X: 'option exercise' };
function parseForm4(cik, accession, primaryDoc) {
  const accNo = accession.replace(/-/g, '');
  const raw = String(primaryDoc || '').replace(/^xslF345X\d+\//, '');   // strip the XSL render path
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNo}/${raw}`;
  const xml = getText(url);
  if (!xml || !/ownershipDocument/i.test(xml)) return { url, parsed: false };
  const one = re => { const m = xml.match(re); return m ? m[1].trim() : null; };
  const owner = one(/<reportingOwnerId>[\s\S]*?<rptOwnerName>([^<]+)</i);
  const isDir = /<isDirector>\s*(1|true)\s*</i.test(xml), isOff = /<isOfficer>\s*(1|true)\s*</i.test(xml);
  const title = one(/<officerTitle>([^<]+)</i);
  const txns = [];
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) || [];
  for (const b of blocks) {
    const g = re => { const m = b.match(re); return m ? m[1].trim() : null; };
    const code = g(/<transactionCode>([^<]+)</i);
    const shares = g(/<transactionShares>[\s\S]*?<value>([^<]+)</i);
    const price = g(/<transactionPricePerShare>[\s\S]*?<value>([^<]+)</i);
    const date = g(/<transactionDate>[\s\S]*?<value>([^<]+)</i);
    const acqDisp = g(/<transactionAcquiredDisposedCode>[\s\S]*?<value>([^<]+)</i);
    const after = g(/<sharesOwnedFollowingTransaction>[\s\S]*?<value>([^<]+)</i);
    if (code) txns.push({ code, shares: shares ? +shares : null, price: price ? +price : null, date, acqDisp, after: after ? +after : null });
  }
  return { url, parsed: true, owner, role: [isOff ? (title || 'Officer') : null, isDir ? 'Director' : null].filter(Boolean).join(' · ') || 'Reporting owner', txns };
}

const state = readJson(STATE, { seen: [], ciks: {}, alertsByDay: {} });
state.seen = state.seen || []; state.alertsByDay = state.alertsByDay || {};
const seen = new Set(state.seen);
const ciks = cikMap(state);
if (!Object.keys(ciks).length) { console.log('could not resolve any CIKs (EDGAR unreachable) — exiting quietly'); process.exit(0); }

const fresh = [];
for (const [tkr, cik] of Object.entries(ciks)) {
  const sub = getJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const r = sub && sub.filings && sub.filings.recent;
  if (!r) continue;
  for (let i = 0; i < r.form.length; i++) {
    if (!/^4(\/A)?$/.test(r.form[i])) continue;
    const acc = r.accessionNumber[i];
    const key = `${tkr}:${acc}`;
    if (seen.has(key)) continue;
    // Only look at the last 5 days on a normal run; older ones are just marked seen.
    const ageDays = (Date.now() - Date.parse(r.filingDate[i] + 'T00:00:00Z')) / 864e5;
    if (SEED || ageDays > 5) { seen.add(key); continue; }
    fresh.push({ tkr, name: WATCH[tkr], cik, acc, filed: r.filingDate[i], doc: r.primaryDocument[i], key });
  }
}

if (SEED) {
  state.seen = [...seen].slice(-4000);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  console.log(`seeded ${seen.size} historical filings as already-seen across ${Object.keys(ciks).length} tickers`);
  process.exit(0);
}

if (!fresh.length) { console.log(`no new Form 4s across ${Object.keys(ciks).length} watched names`); if (!DRY) { state.seen = [...seen].slice(-4000); fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); } process.exit(0); }

// enrich, newest first
const items = [];
for (const f of fresh.slice(0, 12)) {
  const d = parseForm4(f.cik, f.acc, f.doc);
  const real = (d.txns || []).filter(t => /^[PS]$/.test(t.code));      // open-market only
  items.push({ ...f, ...d, material: real.length > 0, real });
}
items.sort((a, b) => (b.filed || '').localeCompare(a.filed || ''));

const fmtN = n => n == null ? '?' : n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const line = it => {
  const t = it.real && it.real[0];
  const head = `${it.tkr} (${it.name}) — ${it.owner || 'insider'}, ${it.role || ''}`;
  if (!t) return `${head}\n   ${(it.txns || []).map(x => CODE[x.code] || x.code).join(', ') || 'no non-derivative transactions'} · filed ${it.filed}\n   ${it.url}`;
  const val = (t.shares != null && t.price) ? ` ≈ $${fmtN(t.shares * t.price)}` : '';
  return `${head}\n   ${CODE[t.code] || t.code}: ${fmtN(t.shares)} sh @ $${t.price != null ? t.price : '?'}${val} on ${t.date || '?'}${t.after != null ? ` · holds ${fmtN(t.after)} after` : ''}\n   filed ${it.filed} · ${it.url}`;
};

const material = items.filter(i => i.material);
console.log(`${items.length} new Form 4(s); ${material.length} open-market (P/S)\n`);
items.forEach(i => console.log(line(i) + '\n'));

if (DRY) process.exit(0);

// ── queue for the morning brief (always, regardless of alert throttle) ──
const q = readJson(QUEUE, { items: [] });
q.items = [...items.map(i => ({
  ticker: i.tkr, name: i.name, owner: i.owner, role: i.role, filed: i.filed, url: i.url,
  material: i.material,
  summary: i.real && i.real[0]
    ? `${CODE[i.real[0].code] || i.real[0].code} ${fmtN(i.real[0].shares)} sh @ $${i.real[0].price ?? '?'}${i.real[0].shares != null && i.real[0].price ? ` (≈$${fmtN(i.real[0].shares * i.real[0].price)})` : ''}`
    : (i.txns || []).map(x => CODE[x.code] || x.code).join(', ') || 'filing',
  at: new Date().toISOString(),
})), ...(q.items || [])].slice(0, 60);
fs.writeFileSync(QUEUE, JSON.stringify(q, null, 1) + '\n');

// ── immediate alert, but only for OPEN-MARKET buys/sells and rate-limited ──
const env = readEnv();
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
state.alertsByDay[today] = state.alertsByDay[today] || 0;
Object.keys(state.alertsByDay).forEach(k => { if (k < today) delete state.alertsByDay[k]; });

if (material.length && env.EMAIL_TO && state.alertsByDay[today] < MAX_ALERT_EMAILS_PER_DAY) {
  const body = [
    `INSIDER FILING ALERT — ${material.length} open-market transaction(s) just filed`,
    '',
    ...material.map(line),
    '',
    'Open-market buys/sells only — grants, option exercises and tax withholding are excluded (they are compensation, not conviction).',
    'US names only: SEC EDGAR publishes Form 4 within minutes. SGX/HKEX have no equivalent open feed, so Singapore/HK insider activity appears in the morning brief instead.',
    '',
    'https://thatzdomdom.github.io/portfolio-command-center/',
  ].join('\n');
  const as = `on run argv
  tell application "Mail" to launch
  set ok to false
  repeat 20 times
    try
      tell application "Mail" to get name of account 1
      set ok to true
      exit repeat
    on error
      delay 3
    end try
  end repeat
  if not ok then error "Mail not ready"
  with timeout of 150 seconds
    tell application "Mail"
      set msg to make new outgoing message with properties {subject:item 1 of argv, content:item 2 of argv, visible:false}
      if (count of argv) > 3 then set sender of msg to item 4 of argv
      tell msg to make new to recipient at end of to recipients with properties {address:item 3 of argv}
      send msg
    end tell
  end timeout
end run`;
  const subj = `🔔 Insider filing: ${[...new Set(material.map(m => m.tkr))].join(', ')}`;
  const args = ['-', subj, body, env.EMAIL_TO];
  if (env.EMAIL_FROM) args.push(env.EMAIL_FROM);
  let r = spawnSync('osascript', args, { input: as, encoding: 'utf8', timeout: 260000 });
  if (r.status !== 0) { spawnSync('sleep', ['20']); r = spawnSync('osascript', args, { input: as, encoding: 'utf8', timeout: 260000 }); }
  console.log('alert email: ' + (r.status === 0 ? 'sent to ' + env.EMAIL_TO : 'FAILED ' + ((r.stderr || '').trim() || r.signal || r.status)));
  if (r.status === 0) state.alertsByDay[today]++;
  if (env.NTFY_TOPIC) spawnSync('curl', ['-s', '-o', '/dev/null', '-H', `Title: ${subj}`, '-H', 'Priority: high', '-H', 'Tags: rotating_light',
    '-d', material.map(m => `${m.tkr}: ${m.owner} — ${m.real[0] ? (CODE[m.real[0].code] || m.real[0].code) : 'filing'}`).join('\n'), `https://ntfy.sh/${env.NTFY_TOPIC}`], { timeout: 20000 });
} else if (material.length) {
  console.log(`alert suppressed (daily cap ${MAX_ALERT_EMAILS_PER_DAY} reached) — items still queued for the morning brief`);
}

state.seen = [...seen, ...items.map(i => i.key)].slice(-4000);
fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
