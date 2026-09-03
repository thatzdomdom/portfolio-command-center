#!/usr/bin/env node
/*
 * flow-collector.js — build and maintain a real DAILY flow history.
 *
 * The panel could only show 2-8 periods because most exchanges publish a
 * headline number, not a downloadable series. HKEX is the exception: its daily
 * China Connect file is public, machine-readable, and addressable BY DATE, so
 * history can be backfilled rather than waited for.
 *
 *   Southbound = mainland money buying/selling HK equities. Net = buy - sell,
 *   summed across the SSE and SZSE legs. Parser validated against an
 *   independently verified figure: 29 Jul 2026 -> SSE -4.09 + SZSE -1.50 =
 *   -HK$5.59bn, matching the value confirmed by a separate source.
 *
 * Northbound (foreign money into A-shares) is deliberately NOT collected: since
 * Beijing's 2024 disclosure change these files carry Total Turnover only, with
 * no buy/sell split, so a net flow cannot be computed. Recording turnover as if
 * it were flow would be a fabrication.
 *
 *   node scripts/flow-collector.js                 collect the last 5 days
 *   node scripts/flow-collector.js --backfill 400  backfill N calendar days
 */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const OUT = path.join(__dirname, '..', 'data', 'flows-history.json');
const arg = process.argv.indexOf('--backfill');
const DAYS = arg > -1 ? Math.min(1200, parseInt(process.argv[arg + 1] || '400', 10)) : 5;

const hist = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { return {}; } })();
hist.hkSouthbound = hist.hkSouthbound || { unit: 'HK$ bn', note: 'Net = buy - sell across the SSE and SZSE southbound legs, from HKEX daily China Connect files. Positive = mainland money buying HK equities.', source: 'https://www.hkex.com.hk/eng/csm/DailyStat/', days: {} };

function fetchDay(ymd) {
  const url = `https://www.hkex.com.hk/eng/csm/DailyStat/data_tab_daily_${ymd}e.js`;
  let raw;
  try { raw = execSync(`curl -s --max-time 20 -H "User-Agent: Mozilla/5.0" ${JSON.stringify(url)}`, { encoding: 'utf8', timeout: 25000, maxBuffer: 1 << 22 }); }
  catch (_) { return null; }
  if (!raw || !/tabData/.test(raw)) return null;                 // non-trading day -> HTML error page
  let j; try { j = JSON.parse(raw.replace(/^\s*tabData\s*=\s*/, '').replace(/;\s*$/, '')); } catch (_) { return null; }
  let net = 0, legs = 0;
  for (const m of j) {
    if (!/Southbound/i.test(m.market || '')) continue;
    const t = (m.content || [])[0] && m.content[0].table;
    const rows = t && t.tr; if (!rows || rows.length < 3) continue;
    const num = r => { const c = (r.td || [])[0]; const v = Array.isArray(c) ? c[0] : c; return parseFloat(String(v).replace(/,/g, '')); };
    const buy = num(rows[1]), sell = num(rows[2]);               // [0]=total, [1]=buy, [2]=sell (HK$ mn)
    if (!isFinite(buy) || !isFinite(sell)) continue;
    net += (buy - sell) / 1000; legs++;                          // HK$ mn -> bn
  }
  return legs === 2 ? { date: j[0].date, net: +net.toFixed(3) } : null;
}

const today = new Date();
let added = 0, checked = 0, missing = 0;
for (let i = 0; i < DAYS; i++) {
  const d = new Date(today.getTime() - i * 864e5);
  const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;      // skip weekends outright
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const iso = d.toISOString().slice(0, 10);
  if (hist.hkSouthbound.days[iso] != null) continue;                     // idempotent
  checked++;
  const r = fetchDay(ymd);
  if (r && r.date) { hist.hkSouthbound.days[r.date] = r.net; added++; }
  else missing++;
  if (checked % 25 === 0) process.stdout.write(`  …${checked} fetched, ${added} stored\n`);
}
hist.updated = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const keys = Object.keys(hist.hkSouthbound.days).sort();
if (keys.length > 900) keys.slice(0, keys.length - 900).forEach(k => delete hist.hkSouthbound.days[k]);
fs.writeFileSync(OUT, JSON.stringify(hist, null, 1) + '\n');

const ks = Object.keys(hist.hkSouthbound.days).sort();
console.log(`\nHK southbound: ${ks.length} trading days stored${ks.length ? ` (${ks[0]} → ${ks[ks.length - 1]})` : ''}`);
console.log(`this run: ${added} added, ${missing} dates with no file (holidays/not yet published)`);
if (ks.length) {
  const cum = ks.reduce((s, k) => s + hist.hkSouthbound.days[k], 0);
  const last10 = ks.slice(-10).map(k => hist.hkSouthbound.days[k]);
  console.log(`cumulative net over the whole series: ${cum >= 0 ? '+' : ''}${cum.toFixed(1)} HK$bn`);
  console.log(`last 10 sessions: ${last10.map(v => (v >= 0 ? '+' : '') + v.toFixed(2)).join(', ')}`);
}
