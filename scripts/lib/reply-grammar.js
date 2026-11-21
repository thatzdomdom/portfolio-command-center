#!/usr/bin/env node
/*
 * reply-grammar.js — the pure grammar of the owner's email replies (phase 4, 12 Sep 2026).
 *
 * The brief asks for exactly one thing and the only way the owner answers is by replying to the
 * email from his phone. Everything that touches Mail.app lives in journal.js; this file is the part
 * that can be unit-tested without a mailbox: strip the quoted brief (which carries NAV, leverage and
 * the margin-call price — never to be stored as "the reply"), find the command lines, and bind the
 * reply to the brief it answers by its subject date. No network, no files, no dates other than the
 * ones handed in. Offset-less timestamps (Mail's «class isot» is local time without a zone) are
 * Asia/Singapore by definition — the Mac and the owner both live there.
 *
 * Grammar (one command per line, case-insensitive verb, trailing punctuation/emoji ignored):
 *   DONE [key] [note] · DEFER <reason> · WATCH <T> · UNWATCH <T> · DECIDE <n 1..7> <text> ·
 *   NOTE <text> · LOAN <amount SGD>
 * A line is a command only if it starts with a verb; non-verb lines after a command fold into its
 * arg. A reply with no verb line at all is UNPARSED (raw = first 120 chars) so the brief can print
 * the grammar line once. "Done — not yet, tomorrow" is NOT done: a negating note makes it UNPARSED
 * with a reason, so the brief asks again instead of clearing the ask.
 *
 * API: parseReply({subject, body, receivedAt, history}) → {briefDate, commands:[{verb, arg, raw, …}]}
 *      stripQuoted(body) → string · parseCommands(text) → commands · parseBriefDate(subject, receivedAtISO, {history})
 *      isotToISO(isot, offsetSeconds) · sgtParts(iso) → {date, time}
 * `node scripts/lib/reply-grammar.js --selftest` runs the fixture-13 cases and prints PASS/FAIL per case.
 */
'use strict';

const VERB_RE = /^\s*(done|defer|watch|unwatch|decide|note|loan)\b[\s:,\-–—]*/i;
const NEG_RE = /\b(not|n't|later|tomorrow|wait|haven|didn)\b/i;
const KEY_RE = /^[\w+\-]+(\.[\w+\-]+)+$/; // silver.rule1 · trend.reunderwrite.D05 · cluster.trim.GDX+SILJ
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;
const QUOTE_MARK = /Portfolio Morning Brief|PORTFOLIO MORNING BRIEF|NO RESEARCH TODAY|Portfolio Brief/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const SGT = 'Asia/Singapore';

// ── time helpers ────────────────────────────────────────────────────────────
const offsetStr = sec => { const s = sec == null || isNaN(sec) ? 28800 : +sec, a = Math.abs(s); return (s < 0 ? '-' : '+') + String(Math.floor(a / 3600)).padStart(2, '0') + ':' + String(Math.floor((a % 3600) / 60)).padStart(2, '0'); };
// Mail's `(date received as «class isot») as string` is local time with NO zone ("2026-09-11T08:15:25");
// stamp it with the offset Mail reported via `time to GMT` (seconds; +08:00 here). Zoned input passes through.
function isotToISO(s, offsetSec) {
  const t = String(s || '').trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(t)) return t;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(t)) return (t.length === 16 ? t + ':00' : t) + offsetStr(offsetSec);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t + 'T00:00:00' + offsetStr(offsetSec);
  return t;
}
function sgtParts(iso) {
  const t = Date.parse(iso); if (isNaN(t)) return null;
  const d = new Date(t);
  return { date: d.toLocaleDateString('en-CA', { timeZone: SGT }), time: d.toLocaleTimeString('en-GB', { timeZone: SGT, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
}
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// ── quoted-text stripping ───────────────────────────────────────────────────
// Everything from the first quote/signature marker on is the brief (or boilerplate), not the reply.
function stripQuoted(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n'), out = [];
  const nextText = i => { for (let j = i + 1; j < lines.length && j <= i + 2; j++) if (lines[j].trim()) return lines[j].trim(); return ''; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], t = l.trim();
    if (/^On .+wrote:\s*$/.test(t)) break;                                   // Apple Mail / Gmail, one line
    if (/^On\s/.test(t) && /wrote:\s*$/.test(nextText(i))) break;            // …wrapped onto two lines
    if (/^-{2,}\s*Original Message/i.test(t) || /^From:\s/.test(t)) break;   // Outlook
    if (/^>/.test(t) || QUOTE_MARK.test(l)) break;                           // quoted lines / the brief itself
    if (/^--\s*$/.test(l) || /^Sent from my i(Phone|Pad)/i.test(t)) break;   // signatures
    out.push(l);
  }
  return out.join('\n').trim();
}

// ── commands ────────────────────────────────────────────────────────────────
const tidy = s => String(s || '').replace(/\s+/g, ' ').trim();
// trailing punctuation and emoji are noise ("DONE!", "Done 👍", "DEFER: FOMC…")
const trimTail = s => { let x = tidy(s), y; do { y = x; x = x.replace(/[\s.!?,;:…\-–—]+$/u, '').replace(/[\p{Extended_Pictographic}️‍\s]+$/u, ''); } while (x !== y); return x; };
const unparsed = (raw, reason) => ({ verb: 'UNPARSED', arg: '', raw: tidy(raw).slice(0, 120), reason });

function finish(c) {
  const raw = tidy(c.rawLines.join(' ')).slice(0, 240), arg = trimTail(c.parts.join(' ')), verb = c.verb;
  const toks = arg ? arg.split(/\s+/) : [];
  if (verb === 'DONE') {
    const key = toks[0] && KEY_RE.test(toks[0]) ? toks[0] : null, note = trimTail(key ? toks.slice(1).join(' ') : arg);
    if (NEG_RE.test(note)) return unparsed(raw, 'DONE with a negating note');
    return Object.assign({ verb, arg: note, raw }, key ? { key } : {});
  }
  if (verb === 'DEFER' || verb === 'NOTE') return { verb, arg, raw };
  if (verb === 'WATCH' || verb === 'UNWATCH') {
    const t = trimTail((toks[0] || '').replace(/^\$/, '')).toUpperCase();
    if (!TICKER_RE.test(t)) return unparsed(raw, verb + ' needs a ticker');
    return { verb, arg: [t, ...toks.slice(1)].join(' '), raw, ticker: t };
  }
  if (verb === 'DECIDE') {
    const m = /^(\d+)\b[\s:,\-–—]*([\s\S]*)$/.exec(arg), n = m ? +m[1] : NaN;
    if (!(n >= 1 && n <= 7)) return unparsed(raw, 'DECIDE needs a number 1-7');
    const text = trimTail(m[2]);
    return { verb, arg: (n + ' ' + text).trim(), raw, n, text };
  }
  if (verb === 'LOAN') {
    const m = /(-?\d+(?:\.\d+)?)\s*([kKmM])?\b/.exec(arg.replace(/S\$|SGD|\$|,/gi, ''));
    if (!m) return unparsed(raw, 'LOAN needs an amount');
    const amount = Math.abs(parseFloat(m[1])) * (/k/i.test(m[2] || '') ? 1e3 : /m/i.test(m[2] || '') ? 1e6 : 1);
    if (!(amount > 0)) return unparsed(raw, 'LOAN needs an amount');
    return { verb, arg, raw, amount: Math.round(amount) };
  }
  return unparsed(raw, 'unknown verb');
}

function parseCommands(text) {
  const src = String(text || ''), lines = src.replace(/\r\n?/g, '\n').split('\n'), cmds = [];
  let cur = null;
  for (const l of lines) {
    const m = VERB_RE.exec(l);
    if (m) { cur = { verb: m[1].toUpperCase(), parts: [l.slice(m[0].length)], rawLines: [l] }; cmds.push(cur); }
    else if (cur && l.trim()) { cur.parts.push(l.trim()); cur.rawLines.push(l); }
  }
  if (!cmds.length) return [unparsed(src, src.trim() ? 'no command verb' : 'empty reply')];
  return cmds.map(finish);
}

// ── brief-date binding ──────────────────────────────────────────────────────
function parseDateText(s) {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s); if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = /(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s); if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()] || MONTHS[m[2].toLowerCase().slice(0, 3)]; if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
}
// Fresh subjects end "… — Sat, 12 Sept 2026" (en-SG: 'Sept', comma); degraded ones "…, not Sat, 12 Sept 2026".
// Unparseable → the brief that was on the wire when the reply arrived: the latest one-action-history
// row dated ≤ the SGT receive date, and the previous row when the reply came before 08:30 SGT on
// that same date (the brief goes out at 08:15; a 07:50 reply answers yesterday's). With no history
// the same rule falls back to the calendar.
function parseBriefDate(subject, receivedAtISO, opts) {
  const o = opts || {};
  let s = String(subject || '').trim().replace(/^(\s*(re|fw|fwd|aw|sv)\s*:\s*)+/i, '');
  const iNot = s.indexOf(', not '), iDash = s.lastIndexOf(' — ');
  const part = iNot >= 0 ? s.slice(iNot + 6) : iDash >= 0 ? s.slice(iDash + 3) : null;
  const d = part && parseDateText(part); if (d) return d;
  const p = sgtParts(receivedAtISO); if (!p) return null;
  const early = p.time < '08:30:00';
  const hist = (o.history || []).map(r => r && r.date).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x || '') && x <= p.date).sort();
  if (hist.length) { const last = hist[hist.length - 1]; return last === p.date && early ? (hist[hist.length - 2] || addDays(p.date, -1)) : last; }
  return early ? addDays(p.date, -1) : p.date;
}

function parseReply(r) {
  const x = r || {};
  return { briefDate: parseBriefDate(x.subject, x.receivedAt, { history: x.history }), commands: parseCommands(stripQuoted(x.body)) };
}

module.exports = { parseReply, stripQuoted, parseCommands, parseBriefDate, isotToISO, sgtParts, VERB_RE };

// ── self-test (fixture 13 cases + the v2 additions) ─────────────────────────
if (require.main === module && process.argv.includes('--selftest')) {
  const T = [], eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cmd = (name, body, expect) => T.push([name, () => { const c = parseCommands(stripQuoted(body)); return c.length === expect.length && expect.every((e, i) => Object.keys(e).every(k => eq(c[i][k], e[k]))) ? null : JSON.stringify(c); }]);
  const subj = (name, s, recv, expect, history) => T.push([name, () => { const d = parseBriefDate(s, recv, { history }); return d === expect ? null : d; }]);
  cmd('apple-mail quote', 'DONE\n\nOn 12 Sept 2026, at 08:15, Portfolio Command Center <x@example.invalid> wrote:\n\n> NAV S$10.4M · leverage 1.62x\n> ACTION: repay', [{ verb: 'DONE', arg: '' }]);
  cmd('outlook quote', 'DEFER waiting for FOMC\n\n-----Original Message-----\nFrom: Portfolio Command Center\nSent: Saturday\nSubject: RE: brief\nNAV S$10.4M', [{ verb: 'DEFER', arg: 'waiting for FOMC' }]);
  cmd('gmail app, wrapped wrote:', 'Watch dell\n\nOn Sat, 12 Sept 2026 at 08:15, Portfolio Command Center\n<x@example.invalid> wrote:\n> leverage 1.62x', [{ verb: 'WATCH', ticker: 'DELL', arg: 'DELL' }]);
  cmd('multi-command', 'DONE\nWATCH DELL\nNOTE checking IBKR rates tomorrow', [{ verb: 'DONE', arg: '' }, { verb: 'WATCH', ticker: 'DELL' }, { verb: 'NOTE', arg: 'checking IBKR rates tomorrow' }]);
  cmd('DEFER without reason', 'DEFER', [{ verb: 'DEFER', arg: '' }]);
  cmd('WATCH lowercase ticker', 'watch dell', [{ verb: 'WATCH', ticker: 'DELL' }]);
  cmd('DECIDE 1 text', 'DECIDE 1 Rule 1 alone at 1.4x', [{ verb: 'DECIDE', n: 1, text: 'Rule 1 alone at 1.4x', arg: '1 Rule 1 alone at 1.4x' }]);
  cmd('gibberish', 'thanks for the update, looks good to me and I will read it properly on the train later this morning, cheers', [{ verb: 'UNPARSED', raw: 'thanks for the update, looks good to me and I will read it properly on the train later this morning, cheers'.slice(0, 120) }]);
  cmd('Done + thanks (folded note)', 'Done\nthanks', [{ verb: 'DONE', arg: 'thanks' }]);
  cmd('Done — not yet, tomorrow (negating)', 'Done — not yet, tomorrow', [{ verb: 'UNPARSED', reason: 'DONE with a negating note' }]);
  cmd('DEFER: FOMC', 'DEFER: FOMC', [{ verb: 'DEFER', arg: 'FOMC' }]);
  cmd('LOAN line', 'LOAN 52,340', [{ verb: 'LOAN', amount: 52340 }]);
  cmd('LOAN S$48.5k', 'loan S$48.5k', [{ verb: 'LOAN', amount: 48500 }]);
  cmd('DONE <key> note', 'DONE silver.rule1 repaid 4k', [{ verb: 'DONE', key: 'silver.rule1', arg: 'repaid 4k' }]);
  cmd('signature + iPhone', 'DONE\n-- \nDom\nSent from my iPhone', [{ verb: 'DONE', arg: '' }]);
  cmd('trailing punctuation/emoji', 'Done! 👍', [{ verb: 'DONE', arg: '' }]);
  cmd('DECIDE out of range', 'DECIDE 9 nope', [{ verb: 'UNPARSED', reason: 'DECIDE needs a number 1-7' }]);
  cmd('empty reply', '   \n> quoted only', [{ verb: 'UNPARSED', reason: 'empty reply' }]);
  subj('subject fresh Sept', 'Re: 📊 Portfolio Morning Brief — Sat, 12 Sept 2026', '2026-09-12T09:00:00+08:00', '2026-09-12');
  subj('subject degraded', 'Re: [DEGRADED] 🔴 NO RESEARCH — day 1 — brief is 2026-09-11 data, not Sat, 12 Sept 2026', '2026-09-12T09:00:00+08:00', '2026-09-12');
  subj('subject RE: Re:', 'RE: Re: 📊 Portfolio Morning Brief — Fri, 11 Sept 2026', '2026-09-12T09:00:00+08:00', '2026-09-11');
  subj('subject [ACTION] prefix', 'Re: [ACTION] 📊 Portfolio Morning Brief — Sat, 12 Sept 2026', '2026-09-12T09:00:00+08:00', '2026-09-12');
  subj('two same-day subjects (--force resend)', 'Re: 📊 Portfolio Morning Brief — Sat, 12 Sept 2026', '2026-09-12T10:20:00+08:00', '2026-09-12');
  subj('unparseable → received before 08:30 SGT', 'Re: hello', '2026-09-12T07:50:00+08:00', '2026-09-11');
  subj('unparseable → received after 08:30 SGT', 'Re: hello', '2026-09-12T09:10:00+08:00', '2026-09-12');
  subj('unparseable + history, before 08:30 → previous row', 'Re: hello', '2026-09-12T07:50:00+08:00', '2026-09-10', [{ date: '2026-09-10' }, { date: '2026-09-12' }]);
  subj('unparseable + history, after 08:30 → latest row', 'Re: hello', '2026-09-12T09:10:00+08:00', '2026-09-12', [{ date: '2026-09-10' }, { date: '2026-09-12' }]);
  T.push(['offset-less isot → +08:00', () => { const iso = isotToISO('2026-09-11T08:15:25', 28800), p = sgtParts(iso); return iso === '2026-09-11T08:15:25+08:00' && p.date === '2026-09-11' && p.time === '08:15:25' ? null : iso + ' ' + JSON.stringify(p); }]);
  T.push(['parseReply end-to-end', () => { const r = parseReply({ subject: 'Re: 📊 Portfolio Morning Brief — Sat, 12 Sept 2026', body: 'DEFER: FOMC\n\nOn 12 Sept 2026, at 08:15, X wrote:\n> brief', receivedAt: '2026-09-12T09:00:00+08:00' }); return r.briefDate === '2026-09-12' && r.commands.length === 1 && r.commands[0].verb === 'DEFER' && r.commands[0].arg === 'FOMC' ? null : JSON.stringify(r); }]);
  let fail = 0;
  for (const [name, fn] of T) { let got; try { got = fn(); } catch (e) { got = 'threw ' + e.message; } if (got == null) console.log('PASS ' + name); else { fail++; console.log('FAIL ' + name + ' — got ' + got); } }
  console.log(`reply-grammar selftest: ${T.length - fail}/${T.length} passed`);
  process.exit(fail ? 1 : 0);
}
