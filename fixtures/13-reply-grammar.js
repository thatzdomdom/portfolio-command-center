/*
 * 13 — pure unit test of scripts/lib/reply-grammar.js (Agent A). SKIPPED (missing) until the module
 * lands. API under test: parseReply({subject, body, receivedAt}) → {briefDate, commands:[{verb,arg,raw}]},
 * stripQuoted(body) → string, parseBriefDate(subject, receivedAtISO) → 'YYYY-MM-DD'. Bodies cover the
 * three mail clients' quote styles, multi-command replies, folded notes, a negating DONE, DEFER with
 * and without a reason, WATCH in lower case, DECIDE, LOAN, a signature, gibberish; subjects cover
 * fresh (en-SG "Sept"), degraded, RE: Re:, [ACTION], two same-day subjects, an offset-less isot
 * stamp (Mail local time = SGT) and the unparseable fallback before/after the 08:15 send.
 */
const path = require('path');
module.exports = {
  name: '13-reply-grammar', incident: 'phase 4 — the reply grammar must read what Dom actually types, under every mail client\'s quoting', requires: ['scripts/lib/reply-grammar.js'],
  run(ctx) {
    const G = require(path.join(ctx.root, 'scripts', 'lib', 'reply-grammar.js'));   // the sandbox copy of ../scripts/lib/reply-grammar.js
    const api = ['parseReply', 'stripQuoted', 'parseBriefDate'];
    if (!ctx.check('exports parseReply / stripQuoted / parseBriefDate', api.every(k => typeof G[k] === 'function'), Object.keys(G).join(','))) return;
    const FRESH = 'Re: 📊 Portfolio Morning Brief — Sat, 12 Sept 2026', AT = '2026-09-12T09:00:00+08:00';
    const cmds = (body, subject = FRESH, receivedAt = AT) => { try { return (G.parseReply({ subject, body, receivedAt }) || {}).commands || []; } catch (e) { return [{ verb: 'THREW', arg: e.message }]; } };
    const arg = c => String(c.arg == null ? '' : c.arg).trim();
    const one = (label, body, verb, argRe) => { const c = cmds(body); ctx.check(`${label} → ${verb}${argRe ? ' ' + argRe : ''}`, c.length === 1 && c[0].verb === verb && (!argRe || argRe.test(arg(c[0]))), JSON.stringify(c)); return c; };
    one('Apple Mail quote', 'DONE\n\nOn 12 Sep 2026, at 08:16, Dom <from@example.invalid> wrote:\n\n> 📊 Portfolio Morning Brief\n> ACTION: repay at least S$3,900 of the silver loan\n> Reply DONE | DEFER <reason>.\n', 'DONE', /^$/);
    one('Outlook quote', 'DEFER waiting for CPI\n\n-----Original Message-----\nFrom: Dom <from@example.invalid>\nSent: Saturday, 12 September 2026 08:15\nSubject: Portfolio Morning Brief\n\nACTION: repay at least S$3,900\n', 'DEFER', /^waiting for CPI$/);
    one('Gmail app quote ("On … <addr>" wrapped, "wrote:" on the next line)', 'WATCH DELL\n\nOn Sat, 12 Sept 2026, 08:15 Dom, <from@example.invalid>\nwrote:\n\n> ACTION: repay at least S$3,900 of the silver loan\n', 'WATCH', /^DELL$/i);
    const m = cmds('DONE\nWATCH dell\nNOTE keep an eye on the loan rate');
    ctx.check('multi-command reply → DONE, WATCH dell, NOTE …', m.length === 3 && m.map(c => c.verb).join(',') === 'DONE,WATCH,NOTE' && /^dell$/i.test(arg(m[1])) && arg(m[2]) === 'keep an eye on the loan rate', JSON.stringify(m));
    one('DEFER without a reason (still logged)', 'DEFER', 'DEFER', /^$/);
    one('WATCH lower-case ticker', 'watch dell', 'WATCH', /^dell$/i);
    one('DECIDE 1 text', 'DECIDE 1 Rule 1 alone at 1.4x', 'DECIDE', /^1\s+Rule 1 alone at 1\.4x$/);
    const g = cmds('thanks, looks good');
    ctx.check('gibberish → UNPARSED with raw', g.length === 1 && g[0].verb === 'UNPARSED' && /^thanks, looks good/.test(String(g[0].raw || '')), JSON.stringify(g));
    one('"Done\\nthanks" folds the following line into the note', 'Done\nthanks', 'DONE', /^thanks$/);
    const neg = cmds('Done — not yet, tomorrow');
    ctx.check('"Done — not yet, tomorrow" → UNPARSED (DONE with a negating note)', neg.length === 1 && neg[0].verb === 'UNPARSED' && /negating/i.test(String(neg[0].reason || neg[0].raw || '')), JSON.stringify(neg));
    one('"DEFER: FOMC" (punctuation after the verb)', 'DEFER: FOMC', 'DEFER', /^FOMC$/);
    one('LOAN 52,000', 'LOAN 52,000', 'LOAN', /52,?000/);
    one('signature and "Sent from my iPhone" ignored', 'DONE\n-- \nDom\nSent from my iPhone\n', 'DONE', /^$/);
    const k = cmds('DONE trend.reunderwrite.D05');
    ctx.check('"DONE <key>" binds to that key', k.length === 1 && k[0].verb === 'DONE' && (k[0].key === 'trend.reunderwrite.D05' || arg(k[0]) === 'trend.reunderwrite.D05'), JSON.stringify(k));
    const stripped = String(G.stripQuoted('DONE\n> quoted brief line\nOn 12 Sep 2026, at 08:16, Dom <from@example.invalid> wrote:\nnot a command either\n') || '');
    ctx.check('stripQuoted drops ">" lines and everything from "On … wrote:"', /DONE/.test(stripped) && !/quoted brief line|not a command either/.test(stripped), JSON.stringify(stripped));
    const bd = (s, at) => { try { return G.parseBriefDate(s, at); } catch (e) { return 'THREW ' + e.message; } };
    ctx.check('fresh subject (en-SG "Sept") → 2026-09-12', bd(FRESH, AT) === '2026-09-12', bd(FRESH, AT));
    ctx.check('degraded subject → the "not <date>" part → 2026-09-11', bd('Re: [DEGRADED] 🔴 NO RESEARCH — day 3 — brief is 2026-09-09 data, not Fri, 11 Sept 2026', '2026-09-11T09:00:00+08:00') === '2026-09-11', bd('Re: [DEGRADED] 🔴 NO RESEARCH — day 3 — brief is 2026-09-09 data, not Fri, 11 Sept 2026', '2026-09-11T09:00:00+08:00'));
    ctx.check('"RE: Re:" prefixes → 2026-09-10', bd('RE: Re: 📊 Portfolio Morning Brief — Thu, 10 Sept 2026', '2026-09-10T10:00:00+08:00') === '2026-09-10');
    ctx.check('[ACTION] subject → 2026-09-14', bd('Re: [ACTION] 📊 Portfolio Morning Brief — Mon, 14 Sept 2026', '2026-09-14T09:00:00+08:00') === '2026-09-14');
    ctx.check('two same-day subjects (plain and [ACTION]) → the same date', bd(FRESH, AT) === bd('Re: [ACTION] 📊 Portfolio Morning Brief — Sat, 12 Sept 2026', AT));
    ctx.check('unparseable subject, received 09:00 SGT → the brief of that day', bd('Re: hello', '2026-09-12T09:00:00+08:00') === '2026-09-12', bd('Re: hello', '2026-09-12T09:00:00+08:00'));
    ctx.check('unparseable subject, received 07:30 SGT (before the send) → not that day', bd('Re: hello', '2026-09-12T07:30:00+08:00') !== '2026-09-12', bd('Re: hello', '2026-09-12T07:30:00+08:00'));
    const iso = at => { try { return (G.parseReply({ subject: 'Re: hello', body: 'DONE', receivedAt: at }) || {}).briefDate; } catch (e) { return 'THREW ' + e.message; } };
    ctx.check('offset-less isot "2026-09-12T09:00:00" is Mail local time = SGT → 2026-09-12', iso('2026-09-12T09:00:00') === '2026-09-12', iso('2026-09-12T09:00:00'));
    ctx.check('offset-less "2026-09-12T07:30:00" → not that day (UTC misread would say 15:30 SGT)', iso('2026-09-12T07:30:00') !== '2026-09-12', iso('2026-09-12T07:30:00'));
  },
};
