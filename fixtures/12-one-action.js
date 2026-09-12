/*
 * 12 — THE ONE ACTION is chosen by code, one at a time, every number with its as-of, and replies
 * bind to it BY KEY. Sub-cases start from a fresh copy and neutralise what legitimately changes day
 * to day (ownership alerts, fresh gate-offs elsewhere, the history files) so the state is known:
 *   (a) real data — data-conditional (12 Sep state: survivability FAIL → silver.rule1)
 *   (b) survivability PASS, 40% from the stressed call, gate ON → none
 *   (c) gate OFF + leverage 1.3 + PASS → UNSIGNED: a candidate + why-line only; SIGNED: silver.rule2,
 *       push only on the crossing day (belowStreak == HYST)
 *   (d) SC 13D on a held name → ownership.reunderwrite.D05; a DONE for that key clears it
 *   (e) DEFER on silver.rule1 → 'deferred'   (f) DONE on another key → 'open', never 'reported-done'
 *   (g) D05.SI gate freshly OFF (yf join) pre-empts a DEFERRED silver ask; otherwise it is a candidate
 *   (h) DONE on silver.rule1 with a stale loan mark → 'reported-done' + the LOAN nudge
 *   (i) DECIDE 1 → policy carries status/at only; the text comes from the journal
 * --dry-run must print and write nothing.
 */
module.exports = {
  name: '12-one-action', incident: 'phase 4 — one action, keyed replies, as-of on every number',
  run(ctx) {
    const HYST = ((ctx.read('policy.json') || {}).trend || {}).offAfterConsecutiveClosesBelow || 5;
    const yd = ctx.daysAgo(1), at = `${yd}T09:00:00+08:00`;
    const row = (verb, key, arg = '', id = verb + key) => ({ at, briefDate: yd, receivedAt: at, messageId: `fx12-${id}`, verb, arg, key, raw: `${verb} ${arg}`.trim() });
    const base = () => {
      ctx.resetData();
      ctx.edit('alerts.json', a => { a.alerts = (a.alerts || []).filter(x => x.family !== 'ownership'); });
      ctx.edit('technicals.json', T => { for (const [k, i] of Object.entries(T.instruments)) if (k !== 'SLV' && i.gate && i.gate.on === false && i.gate.belowStreak >= HYST && i.gate.belowStreak <= HYST + 2) i.gate.belowStreak = 30; });
      ctx.edit('policy.json', p => { delete p.decisions; });
      for (const f of ['journal.ndjson', '.oneaction-history.ndjson', '.state-history.ndjson']) ctx.rm(f);
    };
    const silver = ({ pass, dist, lev }) => ctx.edit('valuation.json', v => { v.silver.survivability.pass = pass; if (dist != null) v.silver.distanceToCallPctStressed = dist; if (lev != null) v.silver.leverage = lev; });
    const gate = (sym, on, extra) => ctx.edit('technicals.json', T => { const g = T.instruments[sym].gate; g.on = on; Object.assign(g, extra || {}); });
    const alert13d = () => ctx.edit('alerts.json', a => { a.alerts.push({ at: `${ctx.daysAgo(3)}T00:10:00.000Z`, id: 'fx12-13d', date: ctx.daysAgo(3), severity: 'Notable', family: 'ownership', ticker: 'D05', issuer: 'DBS Group',
      tags: ['in-book', 'sc13d'], headline: 'D05 · SC 13D filed by Fixture Capital (5.1%, intent to influence)', detail: 'fixture — a 5% holder with intent, in a name you own', url: 'https://www.sec.gov/fixture', clearsWhen: 'until re-underwritten' }); });
    const act = label => { const r = ctx.oneAction(label); return r.json || { action: {}, journal: {}, candidates: [], state: {} }; };
    const keys = j => (j.candidates || []).map(c => c.key);

    // (a) real data — the copy as it is this morning
    let j = act('(a) real data');
    const st = j.state || {};
    ctx.check('(a) date today · kind action|none · as-of on prices, gate, leverage, nav', j.date === ctx.today && ['action', 'none'].includes(j.action.kind) && !!(j.asOf && j.asOf.prices) && !!st.silverGateAsOf && !!(st.leverageAsOf && st.leverageAsOf.price) && !!st.navAsOf, JSON.stringify({ date: j.date, kind: j.action.kind, asOf: j.asOf }));
    const rule1 = st.survivability === false && st.distStressedPct >= 25;
    ctx.check(rule1 ? '(a) survivability FAIL ≥25% from the stressed call → silver.rule1 with the data-derived repayment and a DONE|DEFER ask' : `(a) real data no longer in the 12 Sep state (survivability ${st.survivability}, ${st.distStressedPct}% from the call) — key is data-derived: ${j.action.key}`,
      !rule1 || (j.action.key === 'silver.rule1' && j.action.kind === 'action' && /^DONE \| DEFER/.test(j.action.ask || '') && /^repay at least S\$[\d,]+ of the silver loan \(loan ≤ S\$[\d,]+\) so the account survives a two-week −35% at the 45% stressed maintenance rate\.$/.test(j.action.text)), `${j.action.key} · ${j.action.text}`);
    ctx.check('(a) short ≤ 80 chars with one number', String(j.action.short || '').length <= 80, j.action.short);
    ctx.check('(a) push only on a crossing: first day ⇔ pushNote "first day — no crossing history"', (st.prevStateDate == null) === /first day/.test(j.action.pushNote || '') && j.action.push === false, `prevStateDate ${st.prevStateDate} · push ${j.action.push} · ${j.action.pushNote}`);
    ctx.check('(a) every silver why-line names its series/as-of; assumed rates get their line', (j.action.why || []).some(w => /\(SI=F, \d{4}-\d{2}-\d{2}(, low-trust)?\)/.test(w)) && (j.action.why || []).some(w => /are assumed — confirm on IBKR/.test(w)), (j.action.why || []).join(' ‖ '));
    ctx.check('(a) nav drawdown is null with the row-count note until 20 rows exist', st.navDrawdownPct === null ? /nav-history has \d+ rows \(needs 20\)/.test(st.navNote || '') : typeof st.navDrawdownPct === 'number', `${st.navDrawdownPct} · ${st.navNote}`);
    // --dry-run writes nothing
    const oaBefore = ctx.text('oneaction.json'), shBefore = ctx.text('.state-history.ndjson'), ahBefore = ctx.text('.oneaction-history.ndjson');
    ctx.check('(a) --dry-run wrote nothing (oneaction.json and both history files unchanged)', ctx.text('oneaction.json') === oaBefore && ctx.text('.state-history.ndjson') === shBefore && ctx.text('.oneaction-history.ndjson') === ahBefore);

    // (b) everything clear
    base(); silver({ pass: true, dist: 40 }); gate('SLV', true, { belowStreak: 0, aboveStreak: 3 });
    j = act('(b) PASS, 40%, gate ON');
    ctx.check("(b) → key 'none', kind none, no ask", j.action.key === 'none' && j.action.kind === 'none' && j.action.ask === null && /^No action\. Silver gate ON · 40% to the stressed margin call · survivability PASS · leverage [\d.]+x · top cluster \d+% \(cap 20%, shadow\)\.$/.test(j.action.text) && keys(j).length === 0, `${j.action.key} · ${j.action.text} · candidates ${keys(j)}`);
    ctx.check('(b) state.silverGate true with its as-of', j.state.silverGate === true && !!j.state.silverGateAsOf);

    // (c) rule 2 — a why-line until the policy is SIGNED by hand
    base(); silver({ pass: true, dist: 40, lev: 1.3 }); gate('SLV', false, { belowStreak: 60 });
    j = act('(c1) gate OFF, leverage 1.3, PASS, UNSIGNED');
    ctx.check("(c1) UNSIGNED → key 'none', silver.rule2 is a candidate and a why-line", j.action.key === 'none' && keys(j).includes('silver.rule2') && (j.action.why || []).some(w => /^Rule 2 \(unsigned\) would go further, to 1\.0x: gate OFF since \d{4}-\d{2}-\d{2} \(60 sessions below the 200-day, SLV as of \d{4}-\d{2}-\d{2}\)/.test(w)), `${j.action.key} · ${keys(j)} · ${(j.action.why || []).join(' ‖ ')}`);
    ctx.edit('policy.json', p => { p.silverLeverage.status = 'SIGNED — fixture 12(c2)'; });
    j = act('(c2) SIGNED');
    ctx.check("(c2) SIGNED → key 'silver.rule2', push false (streak 60 is not the crossing day)", j.action.key === 'silver.rule2' && j.action.kind === 'action' && j.action.push === false && /^reduce the silver loan to 1\.0x: the trend gate is OFF \(60 closes below the 200-day since/.test(j.action.text) && j.action.decision === null, `${j.action.key} · push ${j.action.push} · ${j.action.text}`);
    gate('SLV', false, { belowStreak: HYST });
    j = act('(c3) SIGNED, crossing day');
    ctx.check(`(c3) belowStreak == HYST (${HYST}) → push true on the crossing day`, j.action.key === 'silver.rule2' && j.action.push === true, `push ${j.action.push}`);

    // (d) SC 13D on a held name; DONE for its key clears it
    base(); silver({ pass: true, dist: 40 }); gate('SLV', true, { belowStreak: 0 }); alert13d();
    j = act('(d) SC 13D on D05');
    ctx.check("(d) → key 'ownership.reunderwrite.D05' with a 10-business-day deadline, push false", j.action.key === 'ownership.reunderwrite.D05' && j.action.push === false && /^Re-underwrite D05 by (\d{4}-\d{2}-\d{2}): D05 · SC 13D filed by Fixture Capital .* \(filed \d{4}-\d{2}-\d{2}\)\.$/.test(j.action.text) && (/by (\d{4}-\d{2}-\d{2})/.exec(j.action.text) || [])[1] > ctx.today, `${j.action.key} · ${j.action.text}`);
    ctx.check('(d) held · alerts.json as-of in the why-lines', (j.action.why || []).some(w => /^held · alerts\.json as of \d{4}-\d{2}-\d{2}/.test(w)), (j.action.why || []).join(' ‖ '));
    ctx.ndjson('journal.ndjson', [row('DONE', 'ownership.reunderwrite.D05')]);
    j = act('(d2) DONE ownership.reunderwrite.D05');
    ctx.check("(d2) DONE for the key on/after the filing clears it → 'none'", j.action.key === 'none', j.action.key);

    // (e) DEFER on the lead
    base(); silver({ pass: false, dist: 30 }); gate('SLV', false, { belowStreak: 60 }); ctx.ndjson('journal.ndjson', [row('DEFER', 'silver.rule1', 'wait for FOMC')]);
    j = act('(e) DEFER yesterday');
    ctx.check("(e) journal.status 'deferred', lastReply DEFER 'wait for FOMC', deferredUntil ≥ today, lead unchanged", j.action.key === 'silver.rule1' && j.journal.status === 'deferred' && j.journal.lastReply && j.journal.lastReply.verb === 'DEFER' && j.journal.lastReply.arg === 'wait for FOMC' && j.journal.deferredUntil >= ctx.today, JSON.stringify(j.journal));

    // (f) a reply to another key never changes this key's status
    base(); silver({ pass: false, dist: 30 }); ctx.ndjson('journal.ndjson', [row('DONE', 'ownership.reunderwrite.ZZZ')]);
    j = act('(f) DONE on another key');
    ctx.check("(f) journal.status 'open', lastReply null, otherReplies 1", j.action.key === 'silver.rule1' && j.journal.status === 'open' && j.journal.lastReply === null && j.journal.otherReplies === 1, JSON.stringify(j.journal));

    // (g) a top-10 position whose gate turned off pre-empts a DEFERRED silver ask, else it is a candidate
    base(); silver({ pass: false, dist: 30 }); gate('SLV', false, { belowStreak: 60 }); gate('D05.SI', false, { belowStreak: HYST, aboveStreak: 0, lastCross: { date: ctx.daysAgo(7), dir: 'below' } });
    j = act('(g1) D05.SI gate OFF, silver open');
    ctx.check("(g1) silver leads; 'trend.reunderwrite.D05' is a candidate (joined through book.json yf)", j.action.key === 'silver.rule1' && keys(j).includes('trend.reunderwrite.D05'), `${j.action.key} · ${keys(j)}`);
    ctx.ndjson('journal.ndjson', [row('DEFER', 'silver.rule1', 'wait for FOMC')]);
    j = act('(g2) …and silver deferred');
    ctx.check("(g2) → key 'trend.reunderwrite.D05', silver.rule1 among the candidates", j.action.key === 'trend.reunderwrite.D05' && keys(j).includes('silver.rule1') && new RegExp(`^Re-underwrite D05 by \\d{4}-\\d{2}-\\d{2}: gate OFF since ${ctx.daysAgo(7)} \\(-?[\\d.]+% vs 200-day, D05\\.SI as of \\d{4}-\\d{2}-\\d{2}\\)\\.$`).test(j.action.text), `${j.action.key} · ${j.action.text} · ${keys(j)}`);

    // (h) reported-done with a loan mark older than the reply
    base(); silver({ pass: false, dist: 30 }); ctx.ndjson('journal.ndjson', [row('DONE', 'silver.rule1')]);
    j = act('(h) DONE yesterday, loan mark stale');
    const mark = (ctx.read('book.json').holdings.find(h => h.t === 'LOAN') || {}).mark || {};
    ctx.check(`(h) 'reported-done' + "loan mark (…, as of ${mark.asOf}) predates your reply — reply LOAN"`, j.journal.status === 'reported-done' && new RegExp(`^but the loan mark \\(S\\$[\\d,]+, as of ${mark.asOf}\\) predates your reply — reply LOAN <new balance> to update it$`).test(j.journal.note || ''), JSON.stringify(j.journal));

    // (i) DECIDE — policy.json carries status/at only, the text lives in the journal
    base(); silver({ pass: false, dist: 30 }); ctx.edit('policy.json', p => { p.decisions = { 1: { status: 'decided', at, via: 'email reply' } }; });
    ctx.ndjson('journal.ndjson', [row('DECIDE', 'silver.rule1', '1 Rule 1 alone at 1.4x')]);
    j = act('(i) DECIDE 1');
    ctx.check(`(i) why-line "decision 1 decided ${yd} ("Rule 1 alone at 1.4x") — policy still UNSIGNED"`, (j.action.why || []).some(w => w === `decision 1 decided ${yd} ("Rule 1 alone at 1.4x") — policy still UNSIGNED until edited by hand`) && /decision 1 decided/.test(j.action.policy || ''), (j.action.why || []).join(' ‖ ') + ' · ' + j.action.policy);
    ctx.check('(i) journal.decisions[0] = {n:1, status:decided, text from the journal}', j.journal.decisions && j.journal.decisions[0] && j.journal.decisions[0].n === 1 && j.journal.decisions[0].status === 'decided' && j.journal.decisions[0].text === 'Rule 1 alone at 1.4x', JSON.stringify(j.journal.decisions));
  },
};
