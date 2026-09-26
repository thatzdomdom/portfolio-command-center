#!/usr/bin/env node
/*
 * one-action.js — THE ONE ACTION, chosen by code from the files on disk, every morning at 07:02
 * (after alerts.js) and again at 08:15 (from daily-brief.js, after journal.js has read the replies).
 *
 * Phase 4 of the 11 Sep 2026 redesign. Until now the brief carried state lines ("survivability
 * FAIL — reduce the loan") that repeated daily and asked for nothing in particular; the owner had
 * no single thing to do and no way to say "done" that the system would hear. This file picks
 * exactly one action, deterministically, with every number wearing its as-of, and binds the
 * owner's email replies (data/journal.ndjson, written by journal.js) to it BY KEY — a DONE on
 * yesterday's silver ask never clears today's re-underwrite ask, and vice versa.
 *
 * Rules that are not obvious from the code:
 *  - Standing conditions repeat daily as the lead until the DATA clears them (a repaid loan shows
 *    up as a lower book.json mark, not as a reply). `push` fires only on CROSSINGS — the boolean
 *    flipped against the previous row of data/.state-history.ndjson — or while the stressed margin
 *    call is under 25% away. First day: no history, no push.
 *  - While policy.silverLeverage is UNSIGNED (decision 1 pending) the ask is the data-derived
 *    repayment that satisfies Rule 1, never an unsigned leverage target; Rule 2 (gate OFF → 1.0x)
 *    becomes an ask only when the status is hand-edited to start with 'SIGNED'.
 *  - Cluster trims exist only after the 90-day shadow (policy.sizing) — no action during shadow.
 *  - NAV drawdown is never an action, only a why-line; it is null until nav-history has 20 rows.
 *  - Re-underwrite asks (13D on a held/watched name; a top-10 position whose gate turned off) are
 *    candidates while a silver ask leads, and pre-empt it once that silver ask is deferred or
 *    reported done — a deferred ask is state, not a nag.
 * Writes data/oneaction.json (private, gitignored; encrypted for the page by encrypt-publish) and
 * upserts today's row (re-runs rewrite it) in data/.state-history.ndjson and
 * data/.oneaction-history.ndjson — the latter is how journal.js binds a reply to a key.
 * --dry-run prints the JSON and writes nothing. Exits 1 with one line on a missing hard input.
 */
const fs = require('fs'), path = require('path');
const D = f => path.join(__dirname, '..', 'data', f);
const DRY = process.argv.includes('--dry-run');
const rd = f => { try { return JSON.parse(fs.readFileSync(D(f), 'utf8')); } catch (_) { return null; } };
const ndj = f => { try { return fs.readFileSync(D(f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const sgtDate = iso => { const t = Date.parse(iso); return isNaN(t) ? null : new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// SGT business days = weekdays; no holiday calendar (the deadline is a nudge, not a contract).
const addBiz = (d, n) => { let x = d, k = 0; while (k < n) { x = addDays(x, 1); const w = new Date(x + 'T00:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) k++; } return x; };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const sgd = n => 'S$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const kfmt = n => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(n));
const pct = x => Math.round(x * 100);
const recvOf = r => r.receivedAt || r.at || '';
const byRecv = (a, b) => recvOf(a) < recvOf(b) ? -1 : recvOf(a) > recvOf(b) ? 1 : 0;
const ASK = 'DONE | DEFER <reason>';

function main() {
  const v = rd('valuation.json'), T = rd('technicals.json'), BK = rd('book.json'), POL = rd('policy.json');
  if (!v || !v.silver) throw new Error('valuation.json absent or without a silver block — scripts/valuate.js did not run');
  if (!T || !T.instruments) throw new Error('technicals.json absent — scripts/technicals.js did not run');
  if (!BK || !BK.holdings) throw new Error('book.json absent — scripts/extract-book.js did not run');
  if (!POL) throw new Error('policy.json absent');
  const TG = rd('targets.json') || {}, AL = rd('alerts.json') || { alerts: [] }, CAL = rd('.calendar.json') || {}, SB = rd('silver-backtest.json') || {};
  rd('watchlist.json'); // read for completeness; alerts.json already carries the in-book / watchlist tag
  // journal rows: {at, briefDate, receivedAt, messageId, verb, arg, key, raw} — deduped by messageId, oldest first
  const journal = (() => { const seen = new Set(); return ndj('journal.ndjson').filter(r => { const id = r.messageId || recvOf(r) + '|' + r.verb + '|' + r.key; if (seen.has(id)) return false; seen.add(id); return true; }).sort(byRecv); })();
  const stateHist = ndj('.state-history.ndjson'), actHist = ndj('.oneaction-history.ndjson'), navHist = ndj('nav-history.ndjson');
  const prev = stateHist.filter(r => r.date && r.date < today).sort((a, b) => a.date < b.date ? -1 : 1).pop() || null;
  const flipped = (field, from, to, now) => !!prev && prev[field] === from && now === to;

  // ── silver state ─────────────────────────────────────────────────────────
  const s = v.silver, slv = T.instruments.SLV || T.instruments['SI=F'] || {}, gate = slv.gate || {};
  const gateOn = gate.on === true ? true : gate.on === false ? false : null;
  const gateAsOf = slv.asOf || T.asOf, lastCross = gate.lastCross || {};
  const HYST = (POL.trend && POL.trend.offAfterConsecutiveClosesBelow) || 5;
  const ibkr = BK.ibkr || {};
  const silverH = BK.holdings.find(h => h.id === ibkr.silverId) || BK.holdings.find(h => h.t === 'XAG') || {};
  const loanH = BK.holdings.find(h => h.id === ibkr.loanId) || BK.holdings.find(h => h.t === 'LOAN') || {};
  const loanMark = loanH.mark || {}, loanMarkAsOf = loanMark.asOf || ((v.lines || []).find(l => l.id === loanH.id) || {}).markAsOf || null;
  const series = silverH.yf || 'SI=F', lowTrust = s.priceTrust === 'low';
  const priceTag = `${series}, ${s.priceAsOf}${lowTrust ? ', low-trust' : ''}`;
  const p = s.priceUSD, mS = s.maintenanceRateStressed, pass = s.survivability ? s.survivability.pass : null;
  const sigStatus = String((POL.silverLeverage || {}).status || 'UNSIGNED'), sigShort = sigStatus.split(' — ')[0].split(/[\s(]/)[0] || 'UNSIGNED';
  const signed = /^SIGNED/.test(sigStatus), rule2InForce = signed && (POL.silverLeverage || {}).rule2InForce !== false;
  // decision 1 (12 Sep 2026): a signed ceiling sizes the ask — Rule 1's bare minimum is only the floor
  const maxLev = signed && (POL.silverLeverage || {}).maxLeverage > 1 ? +(POL.silverLeverage.maxLeverage) : null;
  // Rule 1 closed form: after a −35% leg the account survives iff loan ≤ 0.65 × (1 − mS) × value.
  const L1 = 0.65 * (1 - mS) * s.valueSGD, xRule1 = Math.max(0, s.loanSGD - L1);
  const Lmax = maxLev ? s.valueSGD * (1 - 1 / maxLev) : null, xLev = Lmax != null ? Math.max(0, s.loanSGD - Lmax) : 0;
  const xRaw = Math.max(xRule1, xLev), x = xRaw > 0 ? Math.ceil(xRaw / 100) * 100 : 0, Lcap = s.loanSGD - x;
  const x1 = xRule1 > 0 ? Math.ceil(xRule1 / 100) * 100 : 0;

  const decisions = POL.decisions || {};
  const decisionText = n => { const r = journal.filter(r => String(r.verb).toUpperCase() === 'DECIDE' && String(r.arg || '').trim().split(/\s+/)[0] === String(n)).pop(); return r ? String(r.arg).trim().replace(/^\d+\s*/, '').slice(0, 160) : null; };
  const decided = n => decisions[n] && decisions[n].status === 'decided' ? decisions[n] : null;
  const decisionLine = n => decided(n)
    ? `decision ${n} decided ${sgtDate(decided(n).at) || '?'}${decisionText(n) ? ` ("${decisionText(n)}")` : ''} — ${signed ? `policy SIGNED ${(POL.silverLeverage || {}).asOf || ''}`.trim() : `policy still ${sigShort} until edited by hand`}`
    : `decision ${n} pending — CIO's unsigned recommendation is Rule 1 alone at 1.0–1.4x; reply DECIDE ${n} <text> to sign or amend`;
  const policyStr = `silverLeverage · ${sigShort} · ${decided(1) ? 'decision 1 decided ' + (sgtDate(decided(1).at) || '?') : 'decision 1 pending'}`;

  // why-lines shared by the silver asks — every number with its as-of
  const why35 = `−35% from $${p.toFixed(2)} = $${(p * 0.65).toFixed(2)}, ${p * 0.65 < s.callPriceUSDStressed ? 'below' : 'above'} the stressed call price $${s.callPriceUSDStressed} (${priceTag})`;
  const whyLev = `leverage ${s.leverage}x now (price ${s.priceAsOf}, loan mark ${loanMarkAsOf || '?'}); the arithmetic ceiling at strike is ${SB.rule1 ? SB.rule1.binding + 'x' : 'n/a'}${SB.asOf ? ` (silver-backtest as of ${SB.asOf})` : ''}`;
  const whyDec = decided(1) ? decisionLine(1) : signed ? `policy silverLeverage ${sigShort} (as of ${(POL.silverLeverage || {}).asOf || '?'})` : decisionLine(1);
  const whyGate = gateOn === false && s.leverage > 1.05
    ? (signed && !rule2InForce
      ? `trend gate OFF since ${lastCross.date || '?'} (${gate.belowStreak ?? '?'} sessions below the 200-day, SLV as of ${gateAsOf}) — a position signal; Rule 2 was struck by decision 1, so it does not size the loan`
      : `Rule 2 (${signed ? 'signed' : 'unsigned'}) would go further, to 1.0x: gate OFF since ${lastCross.date || '?'} (${gate.belowStreak ?? '?'} sessions below the 200-day, SLV as of ${gateAsOf})`) : null;
  const assumed = ['maintenanceRate', 'loanRate'].some(k => ibkr[k] && /^ASSUMED/.test(String(ibkr[k].source || '')));
  const whyRates = assumed ? `maintenance ${pct(s.maintenanceRate)}% and loan ${s.carry ? s.carry.loanRatePct : '?'}% are assumed — confirm on IBKR` : null;
  let navDD = null, navNote = null;
  if (navHist.length >= 20) { const pk = Math.max(...navHist.map(r => r.nav)); navDD = +(((v.navSGD / pk) - 1) * 100).toFixed(1); } else navNote = `nav-history has ${navHist.length} rows (needs 20)`;
  const whyDD = navDD != null && navDD <= -10 ? `NAV drawdown ${navDD}% from its high (${navHist.length}d of history, prices ${v.asOf}) — over 10%, never an action by itself` : null;
  const soon = (CAL.upcoming || []).filter(e => e.relevance && /Fed|FOMC|inflation|China/i.test(e.relevance) && (Date.parse(e.whenISO) - Date.now()) > 0 && (Date.parse(e.whenISO) - Date.now()) < 48 * 3600e3);
  const whyEv = soon.length && s.leverage > 1 ? `${soon.slice(0, 2).map(e => e.country + ' ' + e.title + ' ' + String(e.whenSGT).slice(5, 16)).join(' · ')} within 48h with leverage ${s.leverage}x (calendar ${String(CAL.generated || '?').slice(0, 10)})` : null;
  const silverWhy = extra => [...extra, whyLev, whyDec, whyGate, whyRates, whyDD, whyEv].filter(Boolean);

  // ── the asks, in priority order (first non-candidate wins) ───────────────
  const asks = [];
  if (s.distanceToCallPctStressed != null && s.distanceToCallPctStressed < 25) asks.push({
    key: 'silver.margin-distance', kind: 'action', push: true,
    text: `reduce the silver loan or add collateral now: the stressed margin call $${s.callPriceUSDStressed} is only ${s.distanceToCallPctStressed}% below $${p.toFixed(2)} (${priceTag})${x > 0 ? `; Rule 1 needs repayment of at least ${sgd(x)} (loan ≤ ${sgd(Lcap)})` : ''}.`,
    why: silverWhy([why35]), ask: ASK, short: `Silver ${s.distanceToCallPctStressed}% from the stressed call · reduce the loan or add collateral`,
    decision: signed ? null : 1, policy: policyStr, clearsWhen: 'distance to the stressed margin call ≥ 25%' });
  if (pass === false) asks.push({
    key: 'silver.rule1', kind: 'action', push: flipped('survivability', true, false, false),
    text: x > 0 && maxLev && xLev > xRule1 ? `repay at least ${sgd(x)} of the silver loan (loan ≤ ${sgd(Lcap)}) to bring leverage to the signed ${maxLev}x ceiling; Rule 1's bare minimum is ${sgd(x1)}.`
      : x > 0 ? `repay at least ${sgd(x)} of the silver loan (loan ≤ ${sgd(Lcap)}) so the account survives a two-week −35% at the ${pct(mS)}% stressed maintenance rate.`
      : `reduce the silver loan until the account survives a two-week −35% at the ${pct(mS)}% stressed maintenance rate.`,
    why: silverWhy([why35]), ask: ASK, short: x > 0 ? `Repay ≥S$${kfmt(x)} of the silver loan · reply DONE/DEFER` : 'Reduce the silver loan · reply DONE/DEFER',
    decision: signed ? null : 1, policy: policyStr, clearsWhen: maxLev ? `leverage ≤ ${maxLev}x and survivability PASS at the stressed rate` : 'survivability PASS at the stressed rate' });
  // a signed ceiling is also an ask on its own when survivability already passes but leverage sits above it
  if (pass === true && maxLev && s.leverage > maxLev + 0.02 && xLev > 0) asks.push({
    key: 'silver.ceiling', kind: 'action', push: false,
    text: `repay at least ${sgd(x)} of the silver loan (loan ≤ ${sgd(Lcap)}) to bring leverage ${s.leverage}x back under the signed ${maxLev}x ceiling.`,
    why: silverWhy([]), ask: ASK, short: `Repay ≥S$${kfmt(x)} of the silver loan (over the ${maxLev}x ceiling) · reply DONE/DEFER`,
    decision: null, policy: policyStr, clearsWhen: `leverage ≤ ${maxLev}x` });
  // unsigned → a candidate and a why-line; signed with rule 2 in force → the ask; signed with rule 2 struck → nothing
  const rule2Cond = gateOn === false && s.leverage > 1.05 && pass === true && (!signed || rule2InForce);
  if (rule2Cond) asks.push({
    key: 'silver.rule2', kind: 'action', candidateOnly: !rule2InForce,
    push: signed && (gate.belowStreak === HYST || flipped('silverGate', true, false, false)),
    text: `reduce the silver loan to 1.0x: the trend gate is OFF (${gate.belowStreak ?? '?'} closes below the 200-day since ${lastCross.date || '?'}, SLV as of ${gateAsOf}) and leverage is ${s.leverage}x — policy rule 2, ${sigShort}${signed ? '' : ' (why-line only until signed)'}.`,
    why: silverWhy([]), ask: ASK, short: 'Reduce the silver loan to 1.0x (gate OFF) · reply DONE/DEFER',
    decision: signed ? null : 1, policy: policyStr, clearsWhen: 'leverage ≤ 1.05x or gate ON' });

  // Re-underwrite asks: DONE for the key on/after the trigger date clears them (they are dated events).
  const doneAfter = (key, date) => journal.some(r => String(r.verb).toUpperCase() === 'DONE' && r.key === key && (sgtDate(recvOf(r)) || '') >= (date || ''));
  const rank = a => (a.tags || []).includes('in-book') ? 0 : 1;
  const seenT = new Set();
  (AL.alerts || []).filter(a => a.family === 'ownership' && a.ticker && a.date && (a.tags || []).some(t => t === 'in-book' || t === 'watchlist')
    && /until re-underwritten/i.test(a.clearsWhen || '') && daysBetween(a.date, today) <= 30)
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0) || rank(a) - rank(b))
    .forEach(a => {
      const key = `ownership.reunderwrite.${a.ticker}`; if (seenT.has(a.ticker) || doneAfter(key, a.date)) return; seenT.add(a.ticker);
      const dl = addBiz(a.date, 10);
      asks.push({ key, kind: 'action', push: false, text: `Re-underwrite ${a.ticker} by ${dl}: ${a.headline} (filed ${a.date}).`,
        why: [a.detail ? `${a.detail}${a.url ? ' · ' + a.url : ''}` : null, `${rank(a) === 0 ? 'held' : 'on the watchlist'} · alerts.json as of ${String(AL.generatedAt || '?').slice(0, 10)}`].filter(Boolean),
        ask: ASK, short: `Re-underwrite ${a.ticker} by ${dl} · reply DONE/DEFER`, decision: null, policy: null, clearsWhen: `DONE ${key}, or 30 days after ${a.date}` });
    });
  const byId = new Map(BK.holdings.map(h => [h.id, h]));
  const firstAsked = key => actHist.filter(r => r.key === key || (r.candidates || []).includes(key)).map(r => r.date).sort()[0] || null;
  (v.lines || []).filter(l => l.source === 'live' && l.id !== ibkr.silverId).sort((a, b) => b.valueSGD - a.valueSGD).slice(0, 10).forEach((l, i) => {
    const h = byId.get(l.id), ins = h && h.yf && T.instruments[h.yf]; if (!ins || !ins.gate || ins.gate.on !== false) return;
    const key = `trend.reunderwrite.${h.t}`, bs = ins.gate.belowStreak || 0, fa = firstAsked(key), dl = addBiz(fa || today, 10);
    const freshOff = bs >= HYST && bs <= HYST + 2, open = !!fa && today <= dl;
    if (!(freshOff || open) || doneAfter(key, (ins.gate.lastCross || {}).date || fa || today)) return;
    asks.push({ key, kind: 'action', push: false, text: `Re-underwrite ${h.t} by ${dl}: gate OFF since ${(ins.gate.lastCross || {}).date || '?'} (${ins.distPct200}% vs 200-day, ${h.yf} as of ${ins.asOf || T.asOf}).`,
      why: [`${h.n}: ${sgd(l.valueSGD)} (#${i + 1} of the top-10 live positions, prices ${l.priceAsOf})`, `${bs} closes below the 200-day; the gate turns OFF after ${HYST}`],
      ask: ASK, short: `Re-underwrite ${h.t} by ${dl} (below its 200-day) · reply DONE/DEFER`, decision: null, policy: null, clearsWhen: `DONE ${key}, gate ON, or ${dl}` });
  });
  const shadowEnd = POL.sizing && POL.sizing.shadowStart ? addDays(POL.sizing.shadowStart, POL.sizing.shadowDays || 90) : null;
  const afterShadow = !!shadowEnd && today >= shadowEnd, cap = pct((POL.sizing && POL.sizing.maxCluster) || 0.2);
  const c0 = TG.clusters && TG.clusters[0] || null;
  if (afterShadow && c0 && c0.overCapActual) {
    const mem = (c0.members || []).map(m => (v.lines || []).find(l => l.t === m)).filter(Boolean).sort((a, b) => b.valueSGD - a.valueSGD)[0];
    asks.push({ key: `cluster.trim.${c0.name}`, kind: 'action', push: flipped('clusterTopOver', false, true, true),
      text: `Trim ${mem ? mem.t : (c0.members || [])[0]} or add a named hedge: ${c0.name} is ${pct(c0.actualRiskShare)}% of quoted-sleeve risk against a ${cap}% cap (targets as of ${TG.asOf}).`,
      why: [`cluster weight ${pct(c0.actualWeight)}% · portfolio vol ${TG.portfolioVolActualPct}% vs target ${TG.portfolioVolTargetPct}% · shadow ended ${shadowEnd}`, whyDD].filter(Boolean),
      ask: ASK, short: `Trim ${mem ? mem.t : c0.name}: ${c0.name} is ${pct(c0.actualRiskShare)}% of quoted-sleeve risk`, decision: null, policy: null, clearsWhen: `${c0.name} risk share ≤ ${cap}%` });
  }
  const none = { key: 'none', kind: 'none', push: false,
    text: `No action. Silver gate ${gateOn === true ? 'ON' : gateOn === false ? 'OFF' : '?'} · ${s.distanceToCallPctStressed}% to the stressed margin call · survivability ${pass ? 'PASS' : 'FAIL'} · leverage ${s.leverage}x · top cluster ${c0 ? pct(c0.actualRiskShare) + '%' : 'n/a'} (cap ${cap}%${afterShadow ? '' : ', shadow'}).`,
    why: [`silver ${priceTag} · gate SLV as of ${gateAsOf} · targets as of ${TG.asOf || 'n/a'}`, whyGate, whyRates, whyDD].filter(Boolean),
    ask: null, short: `No action · silver gate ${gateOn === false ? 'OFF' : 'ON'} · survivability ${pass ? 'PASS' : 'FAIL'} · leverage ${s.leverage}x`, decision: null, policy: null, clearsWhen: null };

  // ── keyed journal status (computed at run time; replies to other keys never change it) ──
  const journalFor = key => {
    const mine = journal.filter(r => r.key === key), last = mine[mine.length - 1] || null;
    const out = { lastReply: null, status: journal.length ? 'open' : 'none', note: null, deferredUntil: null,
      otherReplies: journal.filter(r => r.key !== key && daysBetween(sgtDate(recvOf(r)) || today, today) <= 10).length };
    if (!last) return out;
    const rdate = sgtDate(recvOf(last)) || last.briefDate || today, verb = String(last.verb || '').toUpperCase();
    out.lastReply = { verb, arg: last.arg == null ? '' : String(last.arg), briefDate: last.briefDate || null, at: last.at || null, receivedAt: last.receivedAt || null, key };
    if (verb === 'DEFER') { const until = addBiz(rdate, 5); if (today <= until) { out.status = 'deferred'; out.deferredUntil = until; } }
    else if (verb === 'DONE' && daysBetween(rdate, today) <= 10) {
      out.status = 'reported-done';
      out.note = /^silver\./.test(key)
        ? (loanMarkAsOf && loanMarkAsOf < rdate ? `but the loan mark (${sgd(loanMark.value != null ? loanMark.value : s.loanSGD)}, as of ${loanMarkAsOf}) predates your reply — reply LOAN <new balance> to update it`
          : `re-triggered by price: $${p.toFixed(2)} on ${s.priceAsOf} (mark updated ${loanMarkAsOf || '?'})`)
        : `the condition still holds in data (technicals ${T.asOf}, targets ${TG.asOf || 'n/a'})`;
    }
    return out;
  };

  // ── selection ────────────────────────────────────────────────────────────
  let lead = asks.find(a => !a.candidateOnly) || none;
  const reund = asks.find(a => /^(ownership|trend)\.reunderwrite\./.test(a.key));
  if (/^silver\./.test(lead.key) && !lead.push && reund) { const st = journalFor(lead.key).status; if (st === 'deferred' || st === 'reported-done') lead = reund; }
  const jr = journalFor(lead.key);
  const candidates = asks.filter(a => a !== lead).map(a => ({ key: a.key, text: a.text, short: a.short }));
  const action = { key: lead.key, kind: lead.kind, push: !!lead.push, text: lead.text, why: lead.why, ask: lead.ask, short: lead.short, decision: lead.decision, policy: lead.policy, clearsWhen: lead.clearsWhen,
    pushNote: prev ? null : 'first day — no crossing history' };
  const decisionList = Object.keys(decisions).map(n => ({ n: +n, status: decisions[n].status, at: decisions[n].at || null, text: decisionText(n) })).filter(d => d.n >= 1 && d.n <= 7);
  const out = {
    date: today, generatedAt: new Date().toISOString(),
    asOf: { prices: v.asOf, fx: v.fxAsOf || null, technicals: T.asOf, targets: TG.asOf || null, alerts: AL.generatedAt ? String(AL.generatedAt).slice(0, 10) : null, loanMark: loanMarkAsOf, book: BK.asOf || null, policy: POL.version || null },
    action,
    journal: { lastReply: jr.lastReply, status: jr.status, note: jr.note, deferredUntil: jr.deferredUntil, otherReplies: jr.otherReplies, decisions: decisionList },
    candidates,
    state: { silverGate: gateOn, silverGateAsOf: gateAsOf, belowStreak: gate.belowStreak ?? null, gateOffSince: lastCross.dir === 'below' ? lastCross.date : null,
      leverage: s.leverage, leverageAsOf: { price: s.priceAsOf, loanMark: loanMarkAsOf }, survivability: pass, distStressedPct: s.distanceToCallPctStressed,
      silverAsOf: s.priceAsOf, priceTrust: s.priceTrust || null, series, loanSGD: s.loanSGD, rule1LoanCapSGD: Math.round(L1), rule1RepaySGD: x,
      clusterTop: c0 ? { name: c0.name, riskShare: c0.actualRiskShare, over: !!c0.overCapActual, asOf: TG.asOf || null, shadow: !afterShadow, shadowEnds: shadowEnd } : null,
      navSGD: v.navSGD, navAsOf: v.asOf, navDrawdownPct: navDD, navNote, prevStateDate: prev ? prev.date : null }
  };
  if (DRY) { console.log(JSON.stringify(out, null, 1)); return; }
  const upsert = (f, row) => { const rows = ndj(f).filter(r => r.date !== today); rows.push(row); const tmp = D(f) + '.tmp'; fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); fs.renameSync(tmp, D(f)); };
  upsert('.state-history.ndjson', { date: today, key: lead.key, silverGate: gateOn, belowStreak: gate.belowStreak ?? null, leverage: s.leverage, survivability: pass,
    distStressedPct: s.distanceToCallPctStressed, clusterTopRiskShare: c0 ? c0.actualRiskShare : null, clusterTopOver: c0 ? !!c0.overCapActual : null, navSGD: v.navSGD,
    asOf: { silver: s.priceAsOf, gate: gateAsOf, targets: TG.asOf || null, loanMark: loanMarkAsOf, nav: v.asOf } });
  upsert('.oneaction-history.ndjson', { date: today, key: lead.key, text: lead.text, short: lead.short, candidates: candidates.map(c => c.key) });
  const tmp = D('oneaction.json') + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(out, null, 1)); fs.renameSync(tmp, D('oneaction.json'));
  console.log(`one-action: ${lead.key} · push ${action.push} · journal ${jr.status} · ${candidates.length} candidate(s) · wrote data/oneaction.json`);
}

try { main(); } catch (e) { console.error('one-action: FAILED — ' + e.message); process.exit(1); }
