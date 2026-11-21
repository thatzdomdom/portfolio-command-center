#!/usr/bin/env node
/*
 * themes.js — the theme radar: EDGAR filings COUNTED, so a trend claim has a number under it.
 *
 * Phase 8 of the 11 Sep 2026 redesign, and the objective the audit found missing entirely
 * ("trade ideas or new trend identification, e.g. Physical AI"). Until now every theme sentence
 * in the brief was an LLM writing prose about a mood. This asks EDGAR full-text search how many
 * companies said the phrase in their own filings, quarter by quarter, and writes the FACTS to
 * data/themes.json. It makes no judgment about money: it moves a theme between stages and names
 * the filings that moved it. It never sizes, never recommends and never enters The One Action.
 *
 * Three traps it exists to survive, each measured live on 20 Sep 2026:
 *  - the `entity_filter` aggregation LIES. It truncates at 30 buckets, so it said 30 filers for
 *    "physical AI" in 2026 Q2 while paging the 96 hits found 50. Distinct filers are counted by
 *    paging the hits and taking `_source.ciks[]`; the aggregation's number is kept beside it as
 *    `filersAgg` only so the gap stays visible. from=200 returns nothing, so 200 hits is the
 *    practical ceiling and a quarter past it is marked `truncated` rather than guessed at;
 *  - 485APOS is a PROPOSED amendment and 485BPOS is the one that went EFFECTIVE. An ETF trend
 *    counted by filings rather than by effect is three prospectuses nobody can buy, so Crowded
 *    counts 485BPOS only — and counts DISTINCT TRUSTS, because WisdomTree amending one prospectus
 *    eight times is one ETF family, the same overcount as Berkshire's 89 rows for 29 positions;
 *  - Form 4 facts carry no SIC (0 of 1,490 in data/signals.json), so the insider link is made on
 *    filer CIK identity — the theme's EFTS filer CIKs intersected with signals.json issuer CIKs.
 *    Exact, no extra fetch, and stricter than matching an industry bucket.
 *
 * The price leg is the one that must never be faked. Priced needs co-movement across the theme's
 * own names, and data/closes.json holds the book's 66 instruments, not the market. When fewer than
 * three of a theme's filer tickers are priced here the stage STAYS Evidenced and why[] says how
 * many were found. A number that cannot be computed is null with its reason, never an estimate.
 *
 * Keyless: EFTS needs no key, only the identifying User-Agent SEC requires. SEC_UA comes from the
 * environment (on the Mac ~/.claude/portfolio-brief.env; on Actions a secret) — never hardcoded,
 * never printed. Requests ≥350 ms apart, one retry on 5xx/429.
 *
 * Weekly, not daily: filing counts move on a quarterly clock. A daily run would spend requests
 * watching a number that cannot move.
 *
 * Flags:  --dry-run        fetch and print, write nothing
 *         --term "<phrase>"  one theme; the others are kept from the previous file
 *         --quarters N     complete quarters of history (default 8; the open one is always added)
 *         --local          write data/themes.json from this machine (Actions writes it otherwise)
 * Exit:   0 ok · 1 hard failure (one line) · 78 no SEC_UA. One term or one quarter failing is
 *         recorded in scan.errors[] with its reason and leaves that count null; the rest continue.
 *
 * scan.checkedAt/ok/errors refresh every run — a real check, which is what validate-all ages. The
 * rest of the file is rewritten only when its content changed, so generatedAt describes the run
 * that produced the current content.
 */
const fs = require('fs'), path = require('path'), https = require('https');
const ROOT = path.join(__dirname, '..');
const D = f => path.join(ROOT, 'data', f);
const PAGE_CAP = 200;              // from=200 returned 0 hits on 20 Sep 2026 — the practical ceiling
const GAP_MS = 350;
const ETF_FORMS = '485APOS,485BPOS,N-1A';
const FILING_FORMS = '10-K,10-Q,8-K';
const ETF_MONTHS = 24, ETF_RECENT_MONTHS = 12, CROWDED_EFFECTIVE = 3, INITIATION_WAVE = 3;
const CORR_WINDOW = 60;            // sessions per half of the co-movement comparison
const GUIDANCE = 'Consider entry only at the Evidenced→Priced transition, and never initiate at Crowded. The radar counts filings; it does not size or recommend.';

const sgtDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

// ── pure: quarters ───────────────────────────────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
function quarterBounds(y, q) {
  const startM = (q - 1) * 3 + 1, endM = startM + 2;
  const endDay = new Date(Date.UTC(y, endM, 0)).getUTCDate();
  return { from: `${y}-${pad2(startM)}-01`, to: `${y}-${pad2(endM)}-${pad2(endDay)}` };
}
// The last `complete` finished quarters, oldest first, then the open one capped at `today`.
function quarterSeries(today, complete = 8) {
  const [y, m] = String(today).split('-').map(Number);
  const q = Math.ceil(m / 3), out = [];
  for (let i = complete; i >= 1; i--) {
    let yy = y, qq = q - i;
    while (qq <= 0) { qq += 4; yy -= 1; }
    const b = quarterBounds(yy, qq);
    out.push({ q: `${yy} Q${qq}`, from: b.from, to: b.to, partial: false });
  }
  const cur = quarterBounds(y, q);
  out.push({ q: `${y} Q${q}`, from: cur.from, to: today < cur.to ? today : cur.to, partial: today < cur.to });
  return out;
}
function monthsBefore(ymd, months) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 - months, d));
  return t.toISOString().slice(0, 10);
}

// ── pure: EFTS shapes ────────────────────────────────────────────────────────────────────────
// "Faraday Future Intelligent Electric Inc.  (FFAI, FFAIW)  (CIK 0001805521)" → name, cik, tickers.
function parseDisplayName(s) {
  const str = String(s || '').trim();
  const cikM = /\(CIK\s+(\d{6,10})\)\s*$/.exec(str);
  const cik = cikM ? String(Number(cikM[1])) : null;
  let head = (cikM ? str.slice(0, cikM.index) : str).trim();
  const tickers = [];
  const tM = /\(([A-Z0-9.\-]{1,10}(?:\s*,\s*[A-Z0-9.\-]{1,10})*)\)\s*$/.exec(head);
  if (tM) {
    head = head.slice(0, tM.index).trim();
    tM[1].split(',').map(x => x.trim()).filter(Boolean).forEach(t => tickers.push(t));
  }
  return { name: head.replace(/\s{2,}/g, ' ').replace(/[,\s]+$/, ''), cik, tickers };
}
// One row per distinct filer CIK across paged hits, newest filing first within a filer.
function filersOf(docs) {
  const by = new Map();
  for (const d of docs || []) {
    const names = d.display_names || [], ciks = d.ciks || [];
    for (let i = 0; i < ciks.length; i++) {
      const cik = String(Number(ciks[i]));
      if (!Number.isFinite(Number(cik)) || cik === 'NaN') continue;
      const p = parseDisplayName(names[i] || '');
      let h = by.get(cik);
      if (!h) by.set(cik, h = { cik, name: p.name || null, ticker: (p.tickers[0] || null), tickers: p.tickers.slice(), filings: 0, latest: null });
      h.filings++;
      if (!h.name && p.name) h.name = p.name;
      if (!h.ticker && p.tickers[0]) { h.ticker = p.tickers[0]; h.tickers = p.tickers.slice(); }
      if (!h.latest || String(d.file_date || '') > h.latest) h.latest = d.file_date || h.latest;
    }
  }
  return [...by.values()].sort((a, b) => b.filings - a.filings || a.cik.localeCompare(b.cik));
}
// 485BPOS is the one that went effective; 485APOS is a proposal. Deduped by accession.
function etfRows(docs) {
  const by = new Map();
  for (const d of docs || []) {
    const adsh = d.adsh || null;
    if (!adsh || by.has(adsh)) continue;
    const p = parseDisplayName((d.display_names || [])[0] || '');
    const cik = String(Number((d.ciks || [])[0] || p.cik || 0)) || null;
    const form = String(d.form || (d.root_forms || [])[0] || '').toUpperCase();
    by.set(adsh, {
      trust: p.name || null, cik: cik === '0' ? null : cik, form, date: d.file_date || null, adsh,
      url: cik && cik !== '0' ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${adsh}-index.htm` : null,
      effective: form === '485BPOS',
    });
  }
  return [...by.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.adsh.localeCompare(b.adsh));
}
function sicRows(aggs) {
  const b = (aggs && aggs.sic_filter && aggs.sic_filter.buckets) || [];
  return b.map(x => ({ code: String(x.key), count: x.doc_count })).sort((a, b2) => b2.count - a.count || a.code.localeCompare(b2.code));
}

// ── pure: insider link (CIK identity; Form 4 facts carry no SIC) ─────────────────────────────
const ymd = s => { const t = String(s || ''); return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t; };
// Applies the same cluster definition alerts.js applies (policy.insider.cluster): N distinct
// insiders buying on the open market, no 10b5-1 plans, inside a window.
function insiderOverlap(filerCiks, signals, rule) {
  const want = new Set([...(filerCiks || [])].map(c => String(Number(c))));
  const facts = ((signals && signals.form4) || []).filter(f => want.has(String(Number((f.issuer && f.issuer.cik) || f.indexCik || 0))));
  const by = new Map();
  for (const f of facts) {
    const cik = String(Number((f.issuer && f.issuer.cik) || f.indexCik));
    let h = by.get(cik);
    if (!h) by.set(cik, h = { cik, ticker: (f.issuer && f.issuer.ticker) || null, name: (f.issuer && f.issuer.name) || f.indexName || null, filings: 0, buys: 0, sells: 0, latest: null, side: null, cluster: false, clusterOn: null, facts: [] });
    h.filings++;
    const codes = new Set((f.txns || []).map(x => x.code));
    if (codes.has('P')) h.buys++;
    if (codes.has('S')) h.sells++;
    const d = ymd(f.filed);
    if (!h.latest || d > h.latest) h.latest = d;
    h.facts.push(f);
  }
  const minInsiders = (rule && rule.minDistinctInsiders) || 3;
  const winDays = (rule && rule.windowDays) || 30;
  const non10b5 = !rule || rule.requireNon10b5 !== false;
  for (const h of by.values()) {
    h.side = h.buys && h.sells ? 'both' : h.buys ? 'buy' : h.sells ? 'sell' : null;
    const buys = h.facts.filter(f => (!non10b5 || !f.aff10b5) && (f.txns || []).some(x => x.code === 'P'))
      .sort((a, b) => ymd(a.filed).localeCompare(ymd(b.filed)));
    for (let i = 0; i < buys.length; i++) {
      const endT = Date.parse(ymd(buys[i].filed));
      const inWin = buys.filter(f => {
        const t = Date.parse(ymd(f.filed));
        return t >= endT - winDays * 864e5 && t <= endT;
      });
      const owners = new Set(inWin.map(f => (f.owners && f.owners[0] && f.owners[0].name) || f.id));
      if (owners.size >= minInsiders) { h.cluster = true; h.clusterOn = ymd(buys[i].filed); h.insiders = owners.size; break; }
    }
    delete h.facts;
  }
  return [...by.values()].sort((a, b) => (b.cluster ? 1 : 0) - (a.cluster ? 1 : 0) || b.filings - a.filings || a.cik.localeCompare(b.cik));
}

// ── pure: the price leg — computed, or null with its reason ──────────────────────────────────
// policy.trend's gate: close > SMA200 AND 12-1 month momentum > 0. 253 completed closes needed.
function trendGate(closes) {
  const px = (closes || []).filter(v => v != null && Number.isFinite(v));
  if (px.length < 253) return { on: null, why: `only ${px.length} completed closes; the gate needs 253 (200-day average plus 12-1 momentum)` };
  const last = px[px.length - 1];
  const sma200 = px.slice(-200).reduce((s, v) => s + v, 0) / 200;
  const p21 = px[px.length - 1 - 21], p252 = px[px.length - 1 - 252];
  if (!(p252 > 0)) return { on: null, why: 'the close 252 sessions ago is zero or missing, so 12-1 momentum cannot be formed' };
  const mom = p21 / p252 - 1;
  return { on: last > sma200 && mom > 0, close: +last.toFixed(4), sma200: +sma200.toFixed(4), mom121: +mom.toFixed(4) };
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (!(da > 0) || !(db > 0)) return null;
  return num / Math.sqrt(da * db);
}
// series: { TICKER: {dates:[], closes:[]} }. Aligns on the dates every name shares — the book's
// names sit on four exchange calendars, so index alignment would silently compare different days.
function coMovement(series, window = CORR_WINDOW) {
  const names = Object.keys(series || {});
  if (names.length < 2) return { rising: null, why: `co-movement needs at least 2 priced names, ${names.length} given` };
  const maps = names.map(t => {
    const m = new Map();
    const s = series[t];
    for (let i = 0; i < s.dates.length; i++) if (s.closes[i] != null && Number.isFinite(s.closes[i])) m.set(s.dates[i], s.closes[i]);
    return m;
  });
  let common = [...maps[0].keys()];
  for (let i = 1; i < maps.length; i++) common = common.filter(d => maps[i].has(d));
  common.sort();
  const need = 2 * window + 1;
  if (common.length < need) return { rising: null, why: `only ${common.length} sessions are shared by all ${names.length} names; ${need} are needed for two ${window}-session windows` };
  const tail = common.slice(-need);
  const rets = maps.map(m => {
    const r = [];
    for (let i = 1; i < tail.length; i++) {
      const p0 = m.get(tail[i - 1]), p1 = m.get(tail[i]);
      r.push(p0 > 0 ? Math.log(p1 / p0) : 0);
    }
    return r;
  });
  const meanCorr = slice => {
    const vals = [];
    for (let i = 0; i < rets.length; i++) for (let j = i + 1; j < rets.length; j++) {
      const c = pearson(rets[i].slice(slice[0], slice[1]), rets[j].slice(slice[0], slice[1]));
      if (c != null) vals.push(c);
    }
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const prior = meanCorr([0, window]), recent = meanCorr([window, 2 * window]);
  if (prior == null || recent == null) return { rising: null, why: 'a name has no variance in one of the two windows, so correlation is undefined' };
  return { rising: recent > prior, prior: +prior.toFixed(3), recent: +recent.toFixed(3), window, sessions: tail.length, names };
}

// ── pure: the stage ladder, each rung carrying the evidence that granted it ───────────────────
// Order: Candidate → Evidenced → Priced, then Crowded last. Crowded is not a higher rung of the
// same ladder — three effective ETFs means the idea is already packaged and sold, which is true
// whether or not the filer count doubled, so it is tested independently and wins.
function stageFor(t) {
  const asOf = t.asOf || null;
  const quarters = t.quarters || [];
  const etfs = t.etfs || [], overlap = t.insiderOverlap || [], priced = t.pricedNames || [];
  const why = [];

  // Only COMPLETE quarters are scored. The open one is reported and never compared: on the first day
  // of a calendar quarter it holds a few days of filings, so scoring it would collapse every theme to
  // Watching four times a year. And a quarter that hit the paging ceiling carries a FLOOR, not a
  // count — the ratio of two floors is not a measurement, so such a pair is set aside, not scored.
  const complete = quarters.filter(q => !q.partial && q.filers != null);
  const openQ = quarters.filter(q => q.partial).pop() || null;
  const lastComplete = quarters.filter(q => !q.partial).pop() || null;
  if (openQ) why.push(`${openQ.q} is still open (counted through ${openQ.to}) — reported but never scored, because a part-quarter count reads as a collapse`);
  if (lastComplete && lastComplete.filers == null) why.push(`${lastComplete.q} has no filer count (its search failed), so the rung below rests on older quarters and may be stale`);

  // Discovery is a historical event. A theme that has EVER doubled its distinct filers from a base
  // above ten stays a Candidate from that quarter on. Re-deriving the rung from only the latest pair
  // called physical AI "Watching" in September while six ETFs naming it were already trading.
  let cand = null;
  for (let i = 1; i < complete.length; i++) {
    const a = complete[i - 1], b = complete[i];
    if (a.truncated || b.truncated) {
      why.push(`${a.q}→${b.q} not scored: ${[a, b].filter(x => x.truncated).map(x => x.q).join(' and ')} hit the ${PAGE_CAP}-hit paging ceiling, so the filer count there is a floor`);
      continue;
    }
    if (!(a.filers > 10)) continue;
    if (b.filers >= 2 * a.filers) cand = { from: a.q, to: b.q, prior: a.filers, filers: b.filers, on: b.to };
  }
  let stage = 'Watching';
  // The date the current rung was REACHED, which is not the date the radar first looked at it.
  // physical AI became a Candidate on 2026-03-31; stamping a first reading with today would put
  // "changed today" next to a why[] line reading "Candidate since 2026 Q1".
  let attainedOn = null;
  const later = (x, y) => (!x ? y : !y ? x : (String(x) > String(y) ? x : y));
  if (cand) {
    stage = 'Candidate';
    attainedOn = cand.on;
    why.push(`Candidate since ${cand.to}: distinct filers went ${cand.prior} → ${cand.filers} between ${cand.from} and ${cand.to}, at least 2× from a base above 10`);
  } else if (complete.length >= 2) {
    const a = complete[complete.length - 2], b = complete[complete.length - 1];
    why.push(`not a Candidate: no complete quarter has doubled its distinct filers from a base above 10 (latest ${a.q} ${a.filers} → ${b.q} ${b.filers})`);
  } else why.push('fewer than two complete quarters carry a filer count, so the doubling test cannot run');

  const clustered = overlap.filter(o => o.cluster);
  const cutoff = asOf ? monthsBefore(asOf, ETF_RECENT_MONTHS) : null;
  const recentEtfs = etfs.filter(e => !cutoff || String(e.date || '') >= cutoff);
  if (stage === 'Candidate') {
    if (clustered.length) {
      stage = 'Evidenced';
      attainedOn = later(attainedOn, clustered.map(c => c.clusterOn).filter(Boolean).sort().pop() || null);
      why.push(`Evidenced by insiders: ${clustered.map(c => `${c.ticker || c.cik} (${c.insiders || '?'} insiders bought by ${c.clusterOn})`).join(', ')} — a cluster among the theme's own filers`);
    } else if (recentEtfs.length) {
      const e = recentEtfs[0];
      stage = 'Evidenced';
      attainedOn = later(attainedOn, e.date || null);
      why.push(`Evidenced by product: ${recentEtfs.length} ETF filing${recentEtfs.length > 1 ? 's' : ''} in the last ${ETF_RECENT_MONTHS} months, latest ${e.trust || e.cik} ${e.form} ${e.date}`);
    } else why.push(`no insider cluster among the theme's filers and no ETF filing since ${cutoff || 'the window start'}, so it stays Candidate`);
  }

  if (stage === 'Evidenced') {
    if (priced.length < 3) {
      why.push(`only ${priced.length} of the theme's names are priced here${priced.length ? ` (${priced.join(', ')})` : ''}, so co-movement cannot be measured — the rung stays Evidenced and the price leg is not invented`);
    } else {
      const leg = t.priceLeg || {}, cm = leg.coMovement || {}, gate = leg.gate || {};
      if (cm.rising == null) why.push(`co-movement is null: ${cm.why || 'not computed'} — the rung stays Evidenced`);
      else if (gate.on == null) why.push(`the trend gate is null: ${gate.why || 'not computed'} — the rung stays Evidenced`);
      else if (cm.rising && gate.on) {
        stage = 'Priced';
        // Co-movement is measured over windows ending now, so the price leg is reached as of this scan.
        attainedOn = asOf;
        why.push(`Priced: mean pairwise correlation across ${priced.length} names rose ${cm.prior}→${cm.recent} over ${cm.window}-session windows, and ${gate.onCount}/${gate.total} names are above their 200-day with positive 12-1 momentum`);
      } else why.push(`price leg fails: co-movement ${cm.rising ? 'rising' : `flat or falling (${cm.prior}→${cm.recent})`}, trend gate ${gate.on ? 'positive' : `negative (${gate.onCount}/${gate.total} names)`} — stays Evidenced`);
    }
  }

  // Crowding is a SEPARATE AXIS, not a higher rung. Three trusts with an effective prospectus means
  // the idea is already packaged and sold, and that is true whether or not the filer count ever
  // doubled — physical AI is exactly that case. Folding it into the ladder produced a file that said
  // "Crowded" while carrying, three lines above, the sentence explaining why it was not a Candidate.
  const effective = etfs.filter(e => e.effective);
  const effTrusts = [...new Set(effective.map(e => e.cik || e.trust).filter(Boolean))];
  const proposedOnly = etfs.filter(e => !e.effective);
  const initiations = (t.newsInitiations && t.newsInitiations.count) || 0;
  const byTrust = new Map();
  for (const e of effective) if (!byTrust.has(e.cik || e.trust)) byTrust.set(e.cik || e.trust, e);
  const crowding = {
    level: (effTrusts.length >= CROWDED_EFFECTIVE || initiations >= INITIATION_WAVE) ? 'crowded'
      : effTrusts.length ? 'packaged' : proposedOnly.length ? 'proposed' : 'none',
    effectiveTrusts: effTrusts.length, effectiveFilings: effective.length,
    proposedFilings: proposedOnly.length, initiations,
    trusts: [...byTrust.values()].slice(0, 6).map(e => ({ trust: e.trust || e.cik, date: e.date, form: e.form })),
  };
  if (crowding.level === 'crowded') {
    why.push(effTrusts.length >= CROWDED_EFFECTIVE
      ? `Crowded: ${effTrusts.length} distinct trusts have an EFFECTIVE (485BPOS) filing naming the theme, across ${effective.length} filings — ${crowding.trusts.slice(0, 4).map(e => `${e.trust} ${e.date}`).join('; ')}`
      : `Crowded: an initiation wave — ${initiations} fund-launch headlines naming the theme in news.json`);
  } else if (crowding.level === 'packaged') {
    why.push(`${effective.length} effective (485BPOS) filing${effective.length === 1 ? '' : 's'} from ${effTrusts.length} trust${effTrusts.length === 1 ? '' : 's'} — repeat amendments by one trust are one ETF family, so this is packaged but not Crowded`);
  } else if (crowding.level === 'proposed') {
    why.push(`${proposedOnly.length} ETF filing${proposedOnly.length === 1 ? '' : 's'} but none effective — crowding counts prospectuses that went effective, not ones that were proposed`);
  }

  // The window the proposal names: the Evidenced→Priced transition, and never once the idea is
  // already packaged and sold. A fact about today, not an instruction.
  const entryWindow = stage === 'Priced' && crowding.level !== 'crowded';
  return { stage, why, candidateOn: cand ? cand.on : null, attainedOn, crowding, entryWindow };
}

// A fund-launch headline naming the theme. Counted, never inferred: zero is a normal answer.
function newsInitiations(news, term, sinceYmd) {
  const items = ((news && news.items) || []).filter(n => {
    const txt = `${n.headline || ''} ${n.summary || ''}`.toLowerCase();
    if (!txt.includes(String(term).toLowerCase())) return false;
    if (sinceYmd && String(n.date || '') < sinceYmd) return false;
    return /\b(etf|fund)\b/.test(txt) && /\b(launch|launche[sd]|debut|list(s|ed|ing)?|initiat\w+|file[sd]? for)\b/.test(txt);
  });
  return { count: items.length, items: items.map(n => ({ date: n.date || null, headline: n.headline || null })) };
}

// The paging loop, given anything that answers a `from=` offset with an EFTS response object. It
// takes a fetcher rather than a URL so a fixture can drive the ceiling case — a term with more hits
// than EFTS will page — from stored pages, without the network and without waiting for a real term
// to cross 200 hits in a quarter.
async function pageHits(fetchPage, cap = PAGE_CAP) {
  const docs = [];
  let total = null, aggs = null, offset = 0;
  while (offset < cap) {
    const j = await fetchPage(offset);
    if (total == null) { total = (j && j.hits && j.hits.total && j.hits.total.value) || 0; aggs = (j && j.aggregations) || null; }
    const hits = (j && j.hits && j.hits.hits) || [];
    if (!hits.length) break;
    for (const h of hits) docs.push(h._source || {});
    offset += hits.length;
    if (offset >= total) break;
  }
  return { docs, total, aggs, pagedDocs: docs.length, truncated: total != null && docs.length < total };
}

module.exports = { quarterBounds, quarterSeries, monthsBefore, parseDisplayName, filersOf, etfRows, sicRows,
  insiderOverlap, trendGate, pearson, coMovement, stageFor, newsInitiations, pageHits, PAGE_CAP };

// ════════════════════════════════════════════════════════════════════════════════════════════
// I/O — only when run directly.
// ════════════════════════════════════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpGet(url, ua, timeout = 60e3) {
  return new Promise(res => {
    const u = new URL(url);
    const req = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': ua, 'Accept-Encoding': 'identity', 'Accept': 'application/json' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return httpGet(new URL(r.headers.location, url).toString(), ua, timeout).then(res); }
      let d = '';
      r.setEncoding('utf8');
      r.on('data', c => d += c);
      r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', e => res({ status: 0, body: e.message }));
    req.end();
  });
}
function atomicWrite(file, text) { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };

function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const has = k => args.includes(k);
  const ONLY = opt('--term'), QUARTERS = Math.max(1, Math.min(20, +(opt('--quarters') || 8) || 8));
  // The Mac READS data/themes.json; GitHub Actions WRITES it (themes.yml, 06:20 SGT Monday). If both
  // could write, an Actions commit and a local edit of the same tracked file would make the 07:02
  // `git pull` refuse and turn the publish red. Off Actions this is a dry run unless --local says so.
  const READER = !process.env.GITHUB_ACTIONS && !has('--local');
  const DRY = has('--dry-run') || READER;
  if (READER && !has('--dry-run')) console.log('themes: not on GitHub Actions — running as a dry run; pass --local to write data/themes.json from this machine');

  const env = (() => {
    const o = {};
    try {
      fs.readFileSync(path.join(process.env.HOME || '', '.claude', 'portfolio-brief.env'), 'utf8')
        .split('\n').forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].trim(); });
    } catch (_) {}
    return o;
  })();
  const UA = process.env.SEC_UA || env.SEC_UA;
  if (!UA) { console.error('themes: no SEC_UA — SEC requires an identifying User-Agent. Refusing.'); process.exit(78); }

  let requests = 0, last = 0;
  const errors = [];
  async function efts(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = GAP_MS - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      last = Date.now(); requests++;
      const r = await httpGet(url, UA);
      if (r.status === 200) {
        try { return JSON.parse(r.body); } catch (_) { throw new Error('EFTS returned a body that is not JSON'); }
      }
      if (attempt === 0 && (r.status === 0 || r.status === 429 || r.status >= 500)) { await sleep(2500); continue; }
      throw new Error(`EFTS HTTP ${r.status}`);
    }
    throw new Error('EFTS unreachable after one retry');
  }
  const eftsUrl = (term, forms, from, to, offset) =>
    `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"' + term + '"')}&forms=${encodeURIComponent(forms)}&dateRange=custom&startdt=${from}&enddt=${to}&from=${offset}`;
  // EFTS returns 100 hits a page and nothing past from=200, so a window bigger than 200 hits can
  // only ever be counted to a floor. That is what `truncated` says.
  const pageAll = (term, forms, from, to) => pageHits(off => efts(eftsUrl(term, forms, from, to, off)));

  return (async () => {
    const today = sgtDate(), nowIso = new Date().toISOString();
    const watch = readJSON(D('watchlist.json')) || {};
    const seeds = (watch.themes || []).filter(t => t && t.term);
    if (!seeds.length) { console.error('themes: watchlist.json has no themes[] — nothing to scan.'); process.exit(1); }
    // A --term typo must never look like a healthy run. It would scan nothing, make zero requests and
    // still stamp a fresh scan.checkedAt, so the staleness guard downstream could never fire and the
    // radar would sit silently dead behind a green tick.
    if (ONLY && !seeds.some(x => x.term === ONLY)) {
      console.error(`themes: --term "${ONLY}" matches no seeded theme. Seeded: ${seeds.map(x => x.term).join(', ')}`);
      process.exit(1);
    }
    const prev = readJSON(D('themes.json'));
    const signals = readJSON(D('signals.json'));
    const news = readJSON(D('news.json'));
    const closes = readJSON(D('closes.json'));
    const policy = readJSON(D('policy.json'));
    const clusterRule = (policy && policy.insider && policy.insider.cluster) || null;
    if (!clusterRule) errors.push({ stage: 'policy', why: 'policy.insider.cluster unreadable — the cluster test fell back to 3 insiders / 30 days / non-10b5-1' });
    if (!signals || !Array.isArray(signals.form4)) errors.push({ stage: 'insider', why: 'signals.json has no form4[] — the insider overlap is empty, not zero-by-evidence' });

    const series = quarterSeries(today, QUARTERS);
    const etfFrom = monthsBefore(today, ETF_MONTHS);
    const themes = [];

    for (const seed of seeds) {
      const term = seed.term;
      const keep = prev && (prev.themes || []).find(x => x.term === term);
      if (ONLY && term !== ONLY) {
        if (keep) themes.push(keep);
        continue;
      }
      const quarters = [], filerSets = [];
      for (let i = 0; i < series.length; i++) {
        const s = series[i];
        const row = { q: s.q, from: s.from, to: s.to, filings: null, filingsDistinct: null, filers: null, filersAgg: null, pagedDocs: null, truncated: false, partial: s.partial };
        try {
          const r = await pageAll(term, FILING_FORMS, s.from, s.to);
          const fl = filersOf(r.docs);
          // `filings` is what EFTS counts: matching DOCUMENTS. A single 8-K whose exhibit and body
          // both say the phrase is two hits. filingsDistinct counts accession numbers among the
          // docs actually paged, so the overcount is visible instead of silently inflating a trend.
          row.filings = r.total;
          row.filingsDistinct = new Set(r.docs.map(d => d.adsh).filter(Boolean)).size;
          row.filers = fl.length;
          row.pagedDocs = r.pagedDocs;
          row.truncated = r.truncated;
          const ef = (r.aggs && r.aggs.entity_filter && r.aggs.entity_filter.buckets) || [];
          row.filersAgg = ef.length || null;
          if (i >= series.length - 2) filerSets.push({ q: s.q, filers: fl, sic: sicRows(r.aggs) });
        } catch (e) {
          row.why = `count unavailable: ${String((e && e.message) || e)}`;
          errors.push({ stage: 'quarter', term, q: s.q, why: row.why });
          // A CLOSED quarter's filing count is a historical fact: the quarter is over, the filings
          // are in, the number cannot move. So a failed request must not erase it — carry the last
          // measured value forward and say so. Without this, one transient EDGAR failure drops the
          // quarter out of scoring, the ladder is re-derived without it, and a theme can be demoted
          // and alerted as a collapse when nothing happened but an HTTP error. The OPEN quarter is
          // never carried: its count is still rising, so a stale value there would be a wrong number
          // rather than a preserved one, and it is never scored anyway.
          const had = !s.partial && keep && (keep.quarters || []).find(q => q.q === s.q && !q.partial && q.filers != null);
          if (had) {
            row.filings = had.filings; row.filingsDistinct = had.filingsDistinct;
            row.filers = had.filers; row.filersAgg = had.filersAgg;
            row.pagedDocs = had.pagedDocs; row.truncated = had.truncated;
            row.carriedFrom = had.carriedFrom || (prev && prev.asOf) || null;
            row.why = `${row.why} — carried the count last measured ${row.carriedFrom || 'earlier'}, because a closed quarter's count cannot change`;
          }
        }
        quarters.push(row);
      }
      let newestSet = filerSets[filerSets.length - 1] || { filers: [], sic: [] };
      const allFilers = new Map();
      for (const fs2 of filerSets) for (const f of fs2.filers) if (!allFilers.has(f.cik)) allFilers.set(f.cik, f);

      // The filer SET, not just the counts, has to survive a failed fetch. It drives the insider
      // overlap, the priced names and book.html's "you hold a filer on this theme" drawer. When the
      // newest quarter's paging fails, an empty set does not read as "we could not look" — it reads
      // as "no company filed on this theme and no insider bought", which are both false statements
      // made in the confident voice of a count. Carry the last known filers and recompute the
      // overlap against today's signals.json, which is local and did not fail.
      let filersCarried = null;
      if (!allFilers.size && keep && Array.isArray(keep.filersNewest) && keep.filersNewest.length) {
        filersCarried = (prev && prev.asOf) || null;
        for (const f of keep.filersNewest) if (f && f.cik && !allFilers.has(f.cik)) allFilers.set(f.cik, f);
        newestSet = { filers: keep.filersNewest, sic: keep.sic || [] };
        errors.push({ stage: 'filers', term, why: `the newest quarter's filer paging failed — carried the ${keep.filersNewest.length} filers last measured ${filersCarried || 'earlier'} rather than publishing an empty set` });
      }

      let etfs = [];
      try {
        const r = await pageAll(term, ETF_FORMS, etfFrom, today);
        etfs = etfRows(r.docs);
        if (r.truncated) errors.push({ stage: 'etf', term, why: `ETF search found ${r.total} filings but only ${r.pagedDocs} could be paged` });
      } catch (e) {
        errors.push({ stage: 'etf', term, why: `ETF search failed: ${String((e && e.message) || e)}` });
        etfs = keep && keep.etfs ? keep.etfs : [];
      }

      const overlap = insiderOverlap([...allFilers.keys()], signals, clusterRule);
      const inst = (closes && closes.instruments) || {}, exch = (closes && closes.exchanges) || {};
      const pricedNames = [], priceSeries = {};
      for (const f of allFilers.values()) for (const t2 of (f.tickers && f.tickers.length ? f.tickers : [f.ticker])) {
        if (!t2 || pricedNames.includes(t2) || !inst[t2]) continue;
        pricedNames.push(t2);
        priceSeries[t2] = { dates: exch[inst[t2].ex] || [], closes: inst[t2].c || [] };
      }
      let priceLeg = null;
      if (pricedNames.length >= 3) {
        const gates = pricedNames.map(t2 => ({ ticker: t2, ...trendGate(priceSeries[t2].closes) }));
        const known = gates.filter(g => g.on != null);
        const onCount = known.filter(g => g.on).length;
        priceLeg = {
          coMovement: coMovement(priceSeries),
          gate: known.length ? { on: onCount * 2 > known.length, onCount, total: known.length, names: gates } : { on: null, why: `no name has the 253 closes the gate needs (${gates.map(g => g.ticker).join(', ')})`, names: gates },
        };
      } else priceLeg = { coMovement: { rising: null, why: `only ${pricedNames.length} of the theme's names are in closes.json; 3 are needed` }, gate: { on: null, why: 'not attempted — too few priced names' } };

      const inits = newsInitiations(news, term, monthsBefore(today, 12));
      const st = stageFor({ asOf: today, quarters, etfs, insiderOverlap: overlap, pricedNames, priceLeg, newsInitiations: inits });
      themes.push({
        term, seeded: seed.seeded || null, note: seed.note || null,
        // stagePrev/changedOn describe the LAST TRANSITION and are carried forward untouched while
        // the stage holds — "Crowded → Crowded today" would be a lie the Monday block would print.
        stage: st.stage,
        stagePrev: keep ? (keep.stage === st.stage ? (keep.stagePrev || null) : keep.stage) : null,
        changedOn: keep
          ? (keep.stage === st.stage ? (keep.changedOn || today) : today)
          : (st.attainedOn || today),
        why: st.why, candidateOn: st.candidateOn, crowding: st.crowding, entryWindow: st.entryWindow, quarters,
        filersNewest: newestSet.filers.map(f => ({ cik: f.cik, name: f.name, ticker: f.ticker, filings: f.filings })),
        etfs, sic: newestSet.sic, insiderOverlap: overlap, pricedNames, priceLeg, newsInitiations: inits,
        filersCarriedFrom: filersCarried,
      });
    }

    const history = ((prev && prev.history) || []).slice();
    for (const t of themes) {
      const before = prev && (prev.themes || []).find(x => x.term === t.term);
      const from = before ? before.stage : null;
      if (before && from === t.stage) continue;
      const id = `${t.term}|${from}|${t.stage}|${t.changedOn}`;
      if (history.some(h => `${h.term}|${h.from}|${h.to}|${String(h.at).slice(0, 10)}` === id)) continue;
      // The WHOLE why[], not a head of it: the line that granted the stage is not always the first,
      // and a history row is what alerts.js and the Monday block quote months later.
      history.push({ at: t.changedOn, term: t.term, from, to: t.stage, why: t.why.slice(), ...(before ? {} : { bootstrap: true }) });
    }
    history.sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.term.localeCompare(b.term));

    const out = {
      asOf: today, generatedAt: nowIso,
      source: 'SEC EDGAR full-text search (efts.sec.gov, keyless); distinct filers counted by paging hits, never from the entity_filter aggregation; insider link on filer CIK identity against data/signals.json',
      scan: { checkedAt: nowIso, ok: !errors.length, requests, errors },
      guidance: GUIDANCE,
      themes, history,
    };
    const body = o => JSON.stringify({ ...o, generatedAt: null, scan: null });
    const changed = !prev || body(prev) !== body(out);
    const final = changed ? out : { ...prev, scan: { ...prev.scan, checkedAt: nowIso, ok: out.scan.ok, requests, errors } };
    const text = JSON.stringify(final, null, 1) + '\n';

    for (const t of themes) {
      const q = t.quarters.map(x => `${x.q} ${x.filings == null ? '?' : x.filings}h/${x.filingsDistinct == null ? '?' : x.filingsDistinct}f/${x.filers == null ? '?' : x.filers}c${x.truncated ? '+' : ''}${x.partial ? '*' : ''}`).join(' · ');
      console.log(`\n${t.term}: ${t.stagePrev && t.stagePrev !== t.stage ? `${t.stagePrev} → ` : ''}${t.stage}  (changedOn ${t.changedOn})`);
      console.log(`  ${q}`);
      console.log(`  ETFs ${t.etfs.length} (${t.etfs.filter(e => e.effective).length} effective) · insider overlap ${t.insiderOverlap.length} (${t.insiderOverlap.filter(o => o.cluster).length} cluster) · priced names ${t.pricedNames.length}`);
      t.why.forEach(w => console.log(`  · ${w}`));
    }
    console.log(`\nscan: ${requests} EFTS request(s) · errors ${errors.length}${errors.length ? ' — ' + errors.map(e => e.why).join(' | ') : ''}`);
    if (DRY) { console.log(`--dry-run: nothing written (themes.json would be ${changed ? 'rewritten' : 'stamped only'}, ${text.length} bytes)`); return; }
    atomicWrite(D('themes.json'), text);
    console.log(`themes.json: ${changed ? 'content changed, rewritten' : 'unchanged, checkedAt stamped'} · ${text.length} bytes`);
  })();
}

if (require.main === module) {
  main().catch(e => { console.error(`themes: ${String((e && e.message) || e).split('\n')[0]}`); process.exit(1); });
}
