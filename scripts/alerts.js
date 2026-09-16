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
const seenEvent = new Set(prior.alerts.map(a => a.event).filter(Boolean));
const out = []; const push = a => { if (existing.has(a.id)) return; if (a.event && seenEvent.has(a.event)) return; if (a.event) seenEvent.add(a.event); out.push({ at: new Date().toISOString(), ...a }); existing.add(a.id); };

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
    if (incPct != null && incPct >= P.stakeIncreaseBuy.minIncreasePct && total >= (P.stakeIncreaseBuy.minUSD || 0)) reasons.push(`raises own stake ${incPct}%`);
    if (dd != null && dd >= P.drawdownBuy.minBelow52wHighPct) reasons.push(`name is ${dd}% below its 52-week high`);
    if (owner.is10 && total >= P.tenPercentOwnerBuy.minUSD) reasons.push(`10% owner buy ≥ ${usd(P.tenPercentOwnerBuy.minUSD)}`);
    if (!reasons.length && total >= P.otherInsiderBuy.minUSD) reasons.push(`insider buy ≥ ${usd(P.otherInsiderBuy.minUSD)}`);
    const event = `${t}|${who}|${buys[0].date || f.filed}|${sh}`;
    if (reasons.length) push({ id: `f4:${f.id}:P`, event, usd: Math.round(total), date: ymd(f.filed), severity: 'Notable', family: 'insider', ticker: t, issuer: name, tags: [tag, 'open-market'],
      headline: `${t} · ${who} (${role}) bought ${usd(total)}`, detail: `${sh.toLocaleString()} sh${buys[0].price ? ' at ~$' + buys[0].price : ''}${after ? ' · now holds ' + after.toLocaleString() : ''} · ${reasons.join('; ')}`, url: f.url, clearsWhen: 'read' });
    else if (tag !== 'market-wide') push({ id: `f4:${f.id}:Psmall`, event, usd: Math.round(total), date: ymd(f.filed), severity: 'Log', family: 'insider', ticker: t, issuer: name, tags: [tag, 'open-market'],
      headline: `${t} · ${who} bought ${usd(total)}`, detail: `${sh.toLocaleString()} sh — below Notable thresholds`, url: f.url, clearsWhen: 'read' });
  }
  // ── large market-wide sells: ONE Log line per issuer-day (the Dell case) ───
  // Per-filing sells market-wide would be ~500 lines a day; a sponsor distributing $60M in 200
  // lots is still one event. Aggregate by issuer and filing date; alert once above the floor.
  const MW = P.marketWideSellAggregate;
  if (MW) {
    const agg = {};
    signals.form4.filter(f => tagOf(f.issuer.ticker) === 'market-wide' && f.txns.some(x => x.code === 'S')).forEach(f => {
      const k = `${f.issuer.cik || f.indexCik}:${f.filed}`; const a = agg[k] = agg[k] || { f, usd: 0, sh: 0, owners: new Set(), plan: true };
      f.txns.filter(x => x.code === 'S').forEach(x => { a.usd += (x.shares || 0) * (x.price || 0); a.sh += (x.shares || 0); });
      a.owners.add((f.owners[0] && f.owners[0].name) || f.id); if (!f.aff10b5) a.plan = false;
    });
    for (const [k, a] of Object.entries(agg)) {
      if (a.usd < MW.minUSDPerIssuerDay) continue;
      const t = a.f.issuer.ticker, id = `mwsell:${k}`;
      push({ id, usd: Math.round(a.usd), date: ymd(a.f.filed), severity: MW.severity, family: 'insider', ticker: t, issuer: a.f.issuer.name || a.f.indexName, tags: ['market-wide', a.plan ? '10b5-1' : 'discretionary', 'aggregate'],
        headline: `${t} · ${a.owners.size} insider${a.owners.size > 1 ? 's' : ''} sold ${usd(a.usd)} · ${a.plan ? '10b5-1 plan' : 'discretionary'} · not in book`,
        detail: `${a.sh.toLocaleString()} sh across ${[...a.owners].slice(0, 3).join(', ')}${a.owners.size > 3 ? ' +' + (a.owners.size - 3) : ''} — sells carry little return information; logged so the question "did those trades mean anything" has an answer`, url: a.f.url, clearsWhen: 'read' });
    }
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
  // ── 13F: tracked funds (phase 6, 13 Sep 2026) ─────────────────────────────
  // data/13f.json is EDGAR primary data parsed by scripts/13f-scan.js on GitHub Actions; this block
  // only judges it, against policy.funds. A 13F is a quarter-end snapshot filed up to 45 days after
  // the quarter — never a trade today — so nothing here is a push or the One Action: a filing is a
  // Log, a tracked fund opening, exiting or moving ≥25% in a name he holds or watches is a Notable,
  // a name ≥3 funds opened is a Log. The FIRST scan backfilled every fund's latest quarter weeks
  // after it was filed (events[].bootstrap). Announcing a mid-August filing as news on 14 Sep would
  // be the 18 Aug failure turned round — an old table under a fresh date — so a hit whose filing
  // was backfilled (or has no ingest event at all) is written at policy.funds.backfill.severity and
  // tagged 'backfill'. Ids are per fund+period(+name+action): a quarter alerts once, like every
  // other family. No 13f.json (or no policy.funds) → nothing, silently.
  const F13 = J('13f.json'), PF = policy.funds;
  const n13 = { filing: 0, hit: 0, consensus: 0 };
  if (F13 && PF) {
    const FUNDS = F13.funds || {}, skipKind = new Set(PF.excludeKinds || []);
    const tracked = id => !!FUNDS[id] && !skipKind.has(FUNDS[id].kind);
    const events = (F13.events || []).filter(e => e && tracked(e.fund));
    const eventOf = new Map(events.map(e => [`${e.fund}|${e.period}`, e]));
    const isBackfill = (fund, period) => { const e = eventOf.get(`${fund}|${period}`); return !e || e.bootstrap === true; };
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dm = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${+m[3]} ${MON[+m[2] - 1]}` : '?'; };
    const big = n => { const a = Math.abs(n || 0), s = (n || 0) < 0 ? '−' : ''; return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}bn` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : `${s}${usd(a)}`; };
    const sgn = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n || 0)).toLocaleString();
    const SNAP = 'a quarter-end snapshot filed weeks later, not a trade today';
    for (const e of events) {
      const id = `13f:${e.fund}:${e.period}`;
      if (existing.has(id)) continue;
      const hits = (e.bookHits || []).map(h => tagOf(h.ticker)), tag = hits.includes('in-book') ? 'in-book' : hits.includes('watchlist') ? 'watchlist' : 'market-wide';
      const f = FUNDS[e.fund] || {}, L = f.latest && f.latest.period === e.period ? f.latest : null;
      push({ id, what: 'filing', fund: e.fund, period: e.period, quarter: e.quarter, date: e.filed, severity: PF.newQuarter.severity, family: 'fund', ticker: null, issuer: e.name,
        tags: [tag, 'SC 13F', ...(e.bootstrap ? ['backfill'] : [])],
        headline: `${e.name} · 13F ${e.quarter} · ${Number(e.positions || 0).toLocaleString()} positions · ${e.new} new, ${e.added} added, ${e.reduced} reduced, ${e.exited} exited`,
        detail: [`${big(e.valueUSD)} reported`, `filed ${dm(e.filed)}`, e.via === 'notice' ? `via 13F-NT notice → CIK ${e.cik}` : null, L && L.units === 'thousands' ? 'filer reports in thousands (×1000 applied)' : null,
          (e.bookHits || []).length ? `book/watch: ${e.bookHits.slice(0, 6).map(h => `${h.ticker} ${h.action}`).join(', ')}${e.bookHits.length > 6 ? ` +${e.bookHits.length - 6}` : ''}` : 'no book or watchlist names',
          e.bootstrap ? 'backfill — first ingest by the 13F scan, not a new filing' : null].filter(Boolean).join(' · '),
        url: e.url || null, clearsWhen: 'read' });
      n13.filing++;
    }
    const BH = PF.bookHit;
    for (const h of (F13.bookHits || [])) {
      if (!h || !h.ticker || !tracked(h.fund) || !BH) continue;
      const pc = h.pctChg == null ? null : Math.abs(h.pctChg);
      if (!((BH.actions || []).includes(h.action) || (pc != null && pc >= BH.minPctChg))) continue;
      // policy.funds.bookHit.excludeKinds: a fund of that kind is logged but never escalated (Bridgewater,
      // kind 'macro', rebalances ~1,000 lines a quarter and moved 11 of Q2's 14 watchlist names).
      const live = tagOf(h.ticker), tag = live !== 'market-wide' ? live : (h.tag || 'market-wide'), old = isBackfill(h.fund, h.period),
        macroScale = (BH.excludeKinds || []).includes((FUNDS[h.fund] || {}).kind);
      const verb = h.action === 'New' ? 'opened a position' : h.action === 'Exited' ? 'exited' : `${h.action === 'Added' ? 'added' : 'reduced'} ${pc == null ? '' : pc + '% '}`.trim();
      const id = `13f:${h.fund}:${h.period}:${h.key || h.ticker}:${h.action}`;
      if (existing.has(id)) continue;
      push({ id, what: 'book-hit', fund: h.fund, period: h.period, quarter: h.quarter, usd: Math.round(Math.abs(h.valueChgUSD || 0)), date: h.filed, severity: old ? ((PF.backfill && PF.backfill.severity) || 'Log') : macroScale ? 'Log' : BH.severity, family: 'fund', ticker: h.ticker,
        issuer: h.name, tags: [tag, 'SC 13F', ...(old ? ['backfill'] : []), ...(macroScale ? ['macro-scale'] : [])],
        headline: `${h.ticker} · ${h.name} ${verb}${h.putCall ? ` (${h.putCall} options)` : ''} · 13F ${h.quarter}`,
        detail: [`${sgn(h.sharesChg)} sh`, `position now ${big(h.valueUSD)} (${h.valueChgUSD >= 0 ? '+' : ''}${big(h.valueChgUSD)})`, `filed ${dm(h.filed)}`, SNAP, old ? 'backfill — first ingest by the 13F scan' : null].filter(Boolean).join(' · '),
        url: h.url || null, clearsWhen: 'read' });
      n13.hit++;
    }
    const C = F13.consensus, CS = PF.consensus;
    if (C && CS) for (const r of (C.New || [])) {
      if (!r || (r.count || 0) < CS.minFunds) continue;
      const id = `13f:consensus:${C.period}:${r.key}:New`;
      if (existing.has(id)) continue;
      const filed = (r.funds || []).map(x => FUNDS[x] && FUNDS[x].latest && FUNDS[x].latest.period === C.period ? FUNDS[x].latest.filed : null).filter(Boolean).sort().pop() || null;
      push({ id, what: 'consensus', period: C.period, quarter: C.quarter, usd: Math.round(Math.abs(r.valueUSD || 0)), date: filed, severity: CS.severity, family: 'fund', ticker: r.ticker || null, issuer: r.name,
        tags: [tagOf(r.ticker), 'SC 13F'],
        headline: `${r.ticker || r.key}${r.putCall ? ` ${r.putCall}` : ''} · ${r.count} of ${C.funds} tracked funds opened new positions · 13F ${C.quarter}`,
        detail: `${(r.names || r.funds || []).join(', ')} · ${big(r.valueUSD)} combined · ${SNAP}`, url: null, clearsWhen: 'read' });
      n13.consensus++;
    }
  }
  // ── write, append-only ────────────────────────────────────────────────────
  const alerts = out.concat(prior.alerts).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.at || '').localeCompare(a.at || '')).slice(0, policy.retention.alertsMax);
  fs.writeFileSync(D('alerts.json'), JSON.stringify({ generatedAt: new Date().toISOString(), policyVersion: policy.version, meta: { evaluated: [...evaluated].slice(-8000) }, alerts }, null, 1) + '\n');
  const n = out.filter(a => a.severity === 'Notable');
  console.log(`alerts.json: +${out.length} (${n.length} Notable) · ${alerts.length} total · evaluated ${evaluated.size} filings`);
  n.slice(0, 8).forEach(a => console.log(`  ! ${a.date} ${a.headline} [${a.tags.join(' ')}]`));
  if (F13 && PF) console.log(`  13F: +${n13.filing} filing · +${n13.hit} book/watch hit · +${n13.consensus} consensus (scan checked ${(F13.scan && F13.scan.checkedAt) || 'never'})`);
})();
