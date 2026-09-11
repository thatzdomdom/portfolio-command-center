#!/usr/bin/env node
/*
 * alerts.js — judge the facts in signals.json against data/policy.json and APPEND to data/alerts.json.
 *
 * Phase 2 of the 11 Sep 2026 redesign. The scanner stores facts and makes no judgment; this file
 * makes the judgment and never changes the facts. alerts.json is append-only: an alert, once
 * written, is never edited or removed — it gets a `clearsWhen` so a page can grey it out. That is
 * the "home the next day's brief does not overwrite" — the second half of the Dell failure.
 *
 * Severity by EVIDENCE CLASS first, size second (policy.json). Tags say whether the issuer is
 * in-book, on the watchlist, or market-wide. Market-wide sells and market-wide 10b5-1 buys are
 * kept as facts but do NOT become alerts — ~500 a day would bury everything; they still feed the
 * cluster rule. Market-wide small buys likewise feed only the cluster rule.
 */
const fs = require('fs'), path = require('path'), https = require('https');
const D = f => path.join(__dirname, '..', 'data', f);
const J = f => { try { return JSON.parse(fs.readFileSync(D(f), 'utf8')); } catch (_) { return null; } };
const signals = J('signals.json') || { form4: [], sc13: [] };
const policy = J('policy.json'), book = J('book.json') || { holdings: [] }, watch = J('watchlist.json') || { us: [] };
const prices = J('.prices-2y.json') || J('.prices.json') || { instruments: {} };
const prior = J('alerts.json') || { alerts: [], meta: { evaluated: [] } };
if (!policy) { console.error('alerts: data/policy.json missing'); process.exit(1); }
const P = policy.insider, O = policy.ownership;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const ymd = s => s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s;

// ── who we care about ────────────────────────────────────────────────────────
const held = new Map();   // TICKER -> 'in-book' | 'watchlist'
book.holdings.forEach(h => { if (h.yf && !/\.(SI|HK|AX)$/.test(h.yf) && !/=F$|-USD$/.test(h.yf)) held.set(h.yf.toUpperCase(), 'in-book'); });
(watch.us || []).forEach(w => { if (!held.has(w.t.toUpperCase())) held.set(w.t.toUpperCase(), 'watchlist'); });
const tagOf = t => (t && held.get(String(t).toUpperCase())) || 'market-wide';

// CIK map for 13D/G subjects (cached 30 days; SEC asks for a UA — same one the scanner uses)
async function cikMap() {
  const C = D('.ciks.json'); try { const c = JSON.parse(fs.readFileSync(C, 'utf8')); if (Date.now() - Date.parse(c.at) < 30 * 864e5) return c.map; } catch (_) {}
  const env = (() => { const o = {}; try { fs.readFileSync(path.join(process.env.HOME || '', '.claude', 'portfolio-brief.env'), 'utf8').split('\n').forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].trim(); }); } catch (_) {} return o; })();
  const UA = process.env.SEC_UA || env.SEC_UA || (env.EMAIL_FROM ? `Dominic Zhao portfolio-dashboard ${env.EMAIL_FROM}` : 'portfolio-dashboard');
  const body = await new Promise(res => https.get('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': UA } }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', () => res('')));
  const map = {}; try { Object.values(JSON.parse(body)).forEach(x => { map[String(x.cik_str)] = String(x.ticker).toUpperCase(); }); } catch (_) {}
  if (Object.keys(map).length) fs.writeFileSync(C, JSON.stringify({ at: new Date().toISOString(), map }));
  return map;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const usd = n => '$' + Math.round(n).toLocaleString();
const isSenior = title => !!title && P.seniorOfficerBuy.titles.some(t => new RegExp(t, 'i').test(title));
function below52wHigh(ticker) {
  const i = prices.instruments && prices.instruments[ticker]; if (!i) return null;
  const b = (i.bars || []).filter(x => !x.partial).slice(-252); if (b.length < 60) return null;
  const hi = Math.max(...b.map(x => x.h || x.c)), last = b[b.length - 1].c;
  return +((1 - last / hi) * 100).toFixed(1);
}
const existing = new Set(prior.alerts.map(a => a.id));
const evaluated = new Set(prior.meta.evaluated || []);
const out = []; const push = a => { if (!existing.has(a.id)) { out.push({ at: new Date().toISOString(), ...a }); existing.add(a.id); } };

(async () => {
  // ── Form 4 ────────────────────────────────────────────────────────────────
  for (const f of signals.form4) {
    if (evaluated.has(f.id)) continue; evaluated.add(f.id);
    const t = f.issuer.ticker, tag = tagOf(t), name = f.issuer.name || f.indexName;
    const owner = f.owners[0] || {}, who = owner.name || 'insider', role = [owner.isOff ? (owner.title || 'Officer') : null, owner.isDir ? 'Director' : null, owner.is10 ? '10% owner' : null].filter(Boolean).join(' · ') || 'reporting owner';
    const buys = f.txns.filter(x => x.code === 'P'), sells = f.txns.filter(x => x.code === 'S');
    const sumUSD = a => a.reduce((s, x) => s + (x.shares || 0) * (x.price || 0), 0), sumSh = a => a.reduce((s, x) => s + (x.shares || 0), 0);
    if (sells.length && tag !== 'market-wide') {
      push({ id: `f4:${f.id}:S`, date: ymd(f.filed), severity: P.sells.severity, family: 'insider', ticker: t, issuer: name, tags: [tag, f.aff10b5 ? '10b5-1' : 'discretionary'],
        headline: `${t} · insider sell · ${usd(sumUSD(sells))} · ${f.aff10b5 ? '10b5-1 plan' : 'not a plan'}`,
        detail: `${who} (${role}) sold ${sumSh(sells).toLocaleString()} sh${sells[0].price ? ' at ~$' + sells[0].price : ''}`, url: f.url, clearsWhen: 'read' });
    }
    if (!buys.length) continue;
    const total = sumUSD(buys), sh = sumSh(buys), after = buys[buys.length - 1].after;
    const incPct = after && after > sh ? +((sh / (after - sh)) * 100).toFixed(0) : null;
    const dd = t ? below52wHigh(t) : null;
    if (f.aff10b5) { if (tag !== 'market-wide') push({ id: `f4:${f.id}:P10b5`, date: ymd(f.filed), severity: P.tenB5OneBuy.severity, family: 'insider', ticker: t, issuer: name, tags: [tag, '10b5-1'],
      headline: `${t} · scheduled (10b5-1) buy · ${usd(total)}`, detail: `${who} (${role}) — pre-scheduled plan purchase; carries no decision made today`, url: f.url, clearsWhen: 'read' }); continue; }
    const reasons = [];
    if (isSenior(owner.title) && total >= P.seniorOfficerBuy.minUSD) reasons.push(`senior officer buy ≥ ${usd(P.seniorOfficerBuy.minUSD)}`);
    if (incPct != null && incPct >= P.stakeIncreaseBuy.minIncreasePct) reasons.push(`raises own stake ${incPct}%`);
    if (dd != null && dd >= P.drawdownBuy.minBelow52wHighPct) reasons.push(`name is ${dd}% below its 52-week high`);
    if (owner.is10 && total >= P.tenPercentOwnerBuy.minUSD) reasons.push(`10% owner buy ≥ ${usd(P.tenPercentOwnerBuy.minUSD)}`);
    if (!reasons.length && total >= P.otherInsiderBuy.minUSD) reasons.push(`insider buy ≥ ${usd(P.otherInsiderBuy.minUSD)}`);
    if (reasons.length) push({ id: `f4:${f.id}:P`, date: ymd(f.filed), severity: 'Notable', family: 'insider', ticker: t, issuer: name, tags: [tag, 'open-market'],
      headline: `${t} · ${who} (${role}) bought ${usd(total)}`, detail: `${sh.toLocaleString()} sh${buys[0].price ? ' at ~$' + buys[0].price : ''}${after ? ' · now holds ' + after.toLocaleString() : ''} · ${reasons.join('; ')}`, url: f.url, clearsWhen: 'read' });
    else if (tag !== 'market-wide') push({ id: `f4:${f.id}:Psmall`, date: ymd(f.filed), severity: 'Log', family: 'insider', ticker: t, issuer: name, tags: [tag, 'open-market'],
      headline: `${t} · ${who} bought ${usd(total)}`, detail: `${sh.toLocaleString()} sh — below Notable thresholds`, url: f.url, clearsWhen: 'read' });
  }
  // ── clusters (any tag, any size) ──────────────────────────────────────────
  const win = P.cluster.windowDays * 864e5;
  const byIssuer = {};
  signals.form4.filter(f => !f.aff10b5 && f.txns.some(x => x.code === 'P')).forEach(f => { (byIssuer[f.issuer.cik || f.indexCik] = byIssuer[f.issuer.cik || f.indexCik] || []).push(f); });
  for (const [cik, fs4] of Object.entries(byIssuer)) {
    fs4.sort((a, b) => a.filed.localeCompare(b.filed));
    for (let i = 0; i < fs4.length; i++) {
      const end = fs4[i], endT = Date.parse(ymd(end.filed));
      const inWin = fs4.filter(f => Date.parse(ymd(f.filed)) >= endT - win && Date.parse(ymd(f.filed)) <= endT);
      const owners = new Set(inWin.map(f => (f.owners[0] && f.owners[0].name) || f.id));
      if (owners.size < P.cluster.minDistinctInsiders) continue;
      const id = `cluster:${cik}:${end.filed}`;
      if ([...existing].some(x => x.startsWith(`cluster:${cik}:`) && Math.abs(Date.parse(ymd(x.split(':')[2])) - endT) < win)) continue;
      const t = end.issuer.ticker, total = inWin.reduce((s, f) => s + f.txns.filter(x => x.code === 'P').reduce((q, x) => q + (x.shares || 0) * (x.price || 0), 0), 0);
      push({ id, date: ymd(end.filed), severity: P.cluster.severity, family: 'insider', ticker: t, issuer: end.issuer.name || end.indexName, tags: [tagOf(t), 'cluster'],
        headline: `${t} · CLUSTER · ${owners.size} insiders bought · ${usd(total)} · ${P.cluster.windowDays}d`,
        detail: [...owners].slice(0, 5).join(', ') + (owners.size > 5 ? ` +${owners.size - 5}` : '') + ' — independent open-market buys, no 10b5-1 plans' + (tagOf(t) === 'market-wide' ? ' · not in book — reply WATCH ' + t + ' to promote' : ''),
        url: end.url, clearsWhen: `${P.cluster.windowDays}d after ${ymd(end.filed)}` });
      break;
    }
  }
  // ── 13D / 13G ─────────────────────────────────────────────────────────────
  const ciks = await cikMap();
  for (const s of signals.sc13) {
    if (evaluated.has(s.id)) continue; evaluated.add(s.id);
    const subjT = s.subject && ciks[s.subject.cik], tag = tagOf(subjT), filer = (s.filer && s.filer.name) || s.indexName;
    const activist = O.activists.find(a => new RegExp(a, 'i').test(filer || ''));
    const is13D = /13D/.test(s.form);
    let sev = 'ignore';
    if (is13D && tag !== 'market-wide') sev = O.sc13dOnHeldOrWatch.severity; else if (is13D && activist) sev = O.sc13dByActivist.severity; else if (!is13D && tag !== 'market-wide') sev = O.sc13gOnHeldOrWatch.severity;
    if (sev === 'ignore') continue;
    push({ id: `13:${s.id}`, date: ymd(s.filed), severity: sev, family: 'ownership', ticker: subjT || null, issuer: (s.subject && s.subject.name) || s.indexName, tags: [tag, s.form, ...(activist ? ['activist:' + activist] : [])],
      headline: `${subjT || (s.subject && s.subject.name) || '?'} · ${s.form} by ${filer}${s.percent != null ? ' · ' + s.percent + '%' : ''}`,
      detail: is13D ? (tag !== 'market-wide' ? 'a 5% holder with intent to influence, in a name you hold or watch — re-underwrite by a date' : `activist filer (${activist})`) : 'passive 5% crossing', url: s.url, clearsWhen: is13D ? 'until re-underwritten' : 'read' });
  }
  // ── write, append-only ────────────────────────────────────────────────────
  const alerts = out.concat(prior.alerts).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.at || '').localeCompare(a.at || '')).slice(0, policy.retention.alertsMax);
  fs.writeFileSync(D('alerts.json'), JSON.stringify({ generatedAt: new Date().toISOString(), policyVersion: policy.version, meta: { evaluated: [...evaluated].slice(-8000) }, alerts }, null, 1) + '\n');
  const n = out.filter(a => a.severity === 'Notable');
  console.log(`alerts.json: +${out.length} (${n.length} Notable) · ${alerts.length} total · evaluated ${evaluated.size} filings`);
  n.slice(0, 8).forEach(a => console.log(`  ! ${a.date} ${a.headline} [${a.tags.join(' ')}]`));
})();
