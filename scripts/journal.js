#!/usr/bin/env node
/*
 * journal.js — reads the owner's email replies to the brief out of Mail.app and turns them into
 * data (phase 4, 12 Sep 2026). Runs at 07:02 from research-headless.sh (before alerts.js, so a
 * WATCH lands in the same morning's alerts) and again from daily-brief.js (--quiet) before the
 * 08:15 compose, so a reply sent overnight is in THIS morning's brief and one-action.js sees it.
 *
 * Why it looks the way it does:
 *  - The brief is sent FROM the Gmail account (EMAIL_FROM) TO the iCloud address (EMAIL_TO), so a
 *    reply lands in the Gmail account inside Mail.app — INBOX or "Spam" (Gmail's junk name; iCloud
 *    would say "Junk"). Those mailboxes are only reachable by iterating `every mailbox` (a direct
 *    `mailbox "Spam" of acct` reference errors -1728 — verified 12 Sep).
 *  - Mail COLD-START is the historical failure mode from launchd: launch, poll `get name of account 1`
 *    up to 20×3 s, then work. The JS spawnSync timeout MUST exceed the AppleScript budget or osascript
 *    is killed before it can say why (daily-brief.js, 30 Jul).
 *  - `date "2026-09-12"` in AppleScript silently coerces to 19 March 2018. The bound is built
 *    arithmetically from three integer argv items and echoed back as «class isot»; the batch is
 *    refused (exit 2) if the echo is not the date we asked for. Mail's isot strings carry no zone,
 *    so `time to GMT` rides in the header and reply-grammar stamps the offset.
 *  - The INBOX holds ~96k messages: `whose date received > d` ALONE walks it (130 s, -1712) and index
 *    slices cost ~0.6 s per message; `whose date received > d and subject contains "Portfolio Morning
 *    Brief"` answers in ~1 s (measured 12 Sep 2026). So the query always carries the subject marker;
 *    the sender and the reply prefix are checked here, in JS.
 *  - Records are ASCII RS/US-delimited (built with `ASCII character 30/31`, stripped from every field)
 *    so subjects and bodies can carry anything. `text 1 thru 6000 of c` throws on shorter text — guarded.
 *  - A reply quotes the brief (NAV, leverage, margin-call price): the journal is as private as book.json.
 *    data/journal.ndjson (append-only, deduped by messageId) and data/journal.json ({asOf, count,
 *    entries: last 200} for encrypt-publish → journal.enc) are gitignored. Log lines carry counts and
 *    verbs only — the research log is plaintext.
 *  - Side effects are the smallest possible: WATCH/UNWATCH edit data/watchlist.json (names from the
 *    SEC company_tickers map cached 30 days in data/.tickers.json); DECIDE writes ONLY
 *    policy.json.decisions[n] = {status, at, via} (the text stays in the encrypted journal — policy.json
 *    is public); LOAN goes through scripts/edit-book.js so book.json and index.html cannot drift;
 *    everything else is journal-only. Untrusted senders are recorded (domain only) and never applied.
 *  - Cursor ~/.claude/journal-cursor.json {lastRunAt, lastAlarmDate, seen:{mailId: receivedAt}} is
 *    written after EACH applied message via temp+rename; the query window is always today−7 (rolling)
 *    and `seen` is pruned to 14 days. The alarm (ntfy) fires at most once a day; --quiet mutes it.
 *
 * Usage: node scripts/journal.js [--quiet] [--dry-run] [--since YYYY-MM-DD]
 * Exit 0 = replies read (possibly none); 2 = could not read them (one line, alarm) — never fatal to the caller.
 */
const fs = require('fs'), path = require('path'), https = require('https'), { spawnSync } = require('child_process');
const G = require('./lib/reply-grammar.js');

const ROOT = path.join(__dirname, '..'), D = f => path.join(ROOT, 'data', f);
const argv = process.argv.slice(2), DRY = argv.includes('--dry-run'), QUIET = argv.includes('--quiet');
const SINCE_ARG = (() => { const i = argv.indexOf('--since'); return i >= 0 ? argv[i + 1] : (argv.find(a => /^--since=/.test(a)) || '').slice(8) || null; })();
const MAILBOXES = 3;
const MARK = /Portfolio Morning Brief|NO RESEARCH|\[ACTION\]/;

function readEnv() {
  const out = {};
  try {
    fs.readFileSync(path.join(process.env.HOME, '.claude', 'portfolio-brief.env'), 'utf8')
      .split('\n').forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) out[m[1]] = m[2].trim(); });
  } catch (e) {}
  return out;
}
const todaySGT = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const sgtDate = iso => { const p = G.sgtParts(iso); return p ? p.date : null; };
const rd = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const ndj = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const writeJson = (f, obj) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n'); fs.renameSync(tmp, f); };
const fail = (msg, code) => { console.error('journal: ' + msg); process.exit(code == null ? 2 : code); };
const isRealDate = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false; const t = Date.parse(s + 'T00:00:00Z'); return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; };

// ── the AppleScript (argv: account address, Y, M, D) ─────────────────────────
// One batched event per mailbox where the mailbox is small enough for `whose` to answer inside the
// timeout; a newest-first slice walk otherwise. Content (and the RFC message id) only for subject
// matches, each in its own try + timeout. Output: H·isot·gmtOffset, then R rows, then one M row per
// mailbox visited: name·n(in window)·k(subject matches)·mode·partial·errNum·oldest isot.
const AS = `on run argv
  set acctAddr to item 1 of argv
  set Y to (item 2 of argv) as integer
  set MM to (item 3 of argv) as integer
  set DD to (item 4 of argv) as integer
  set d to current date
  set time of d to 0
  set day of d to 1
  set year of d to Y
  set month of d to MM
  set day of d to DD
  set RS to (ASCII character 30)
  set US to (ASCII character 31)
  set out to "H" & US & ((d as «class isot») as string) & US & (time to GMT) & RS
  tell application "Mail" to launch
  set ready to false
  repeat 20 times
    try
      tell application "Mail" to get name of account 1
      set ready to true
      exit repeat
    on error
      delay 3
    end try
  end repeat
  if not ready then error "Mail did not become ready" number 1001
  delay 2
  tell application "Mail"
    set acct to missing value
    repeat with a in accounts
      if (name of a is acctAddr) or ((email addresses of a) contains acctAddr) then
        set acct to a
        exit repeat
      end if
    end repeat
    if acct is missing value then error "no Mail account named or holding the EMAIL_FROM address" number 1002
    repeat with mb in (every mailbox of acct)
      set mbName to name of mb
      if mbName is "INBOX" or mbName is "Spam" or mbName is "Junk" then
        set errNum to 0
        set n to 0
        set k to 0
        set total to -1
        try
          with timeout of 30 seconds
            set total to count of messages of mb
          end timeout
        end try
        -- One \`whose\` per marker: a date bound ALONE walks the whole 96k-message INBOX (130 s, -1712);
        -- with a subject predicate Mail answers in ~1 s (measured 12 Sep 2026).
        repeat with marker in {"Portfolio Morning Brief", "NO RESEARCH"}
          set ms to {}
          try
            with timeout of 45 seconds
              set ms to (messages of mb whose date received > d and subject contains marker)
            end timeout
          on error e number num
            set errNum to num
          end try
          repeat with m in ms
            set n to n + 1
            set s to ""
            set snd to ""
            set rcv to ""
            try
              with timeout of 20 seconds
                set s to subject of m
                set snd to sender of m
                set rcv to ((date received of m) as «class isot») as string
              end timeout
            end try
            if s is missing value then set s to ""
            if snd is missing value then set snd to ""
            if (s begins with "re:") then
              set k to k + 1
              set c to ""
              set mid to ""
              set cErr to ""
              try
                with timeout of 45 seconds
                  set mid to message id of m
                  set c to content of m
                end timeout
                if c is missing value then set c to ""
                set c to c as string
                if (length of c) > 6000 then set c to text 1 thru 6000 of c
              on error e number num
                set cErr to num as string
              end try
              set out to out & "R" & US & (id of m) & US & my clean(mid) & US & my clean(s) & US & my clean(snd) & US & rcv & US & my clean(c) & US & cErr & RS
            end if
          end repeat
        end repeat
        set out to out & "M" & US & mbName & US & n & US & k & US & "whose" & US & "0" & US & errNum & US & "" & US & total & RS
      end if
    end repeat
  end tell
  return out
end run

on clean(t)
  if t is missing value then return ""
  set AppleScript's text item delimiters to {(ASCII character 30), (ASCII character 31)}
  set parts to text items of (t as string)
  set AppleScript's text item delimiters to ""
  return parts as string
end clean`;

const AS_ERR = { 1001: 'Mail did not become ready', 1002: 'account not found', 1003: 'message moved during the walk', '-1712': 'AppleEvent timed out', '-1743': 'not authorised (Automation/TCC)', '-1728': 'object not found', '-600': 'Mail not running', '-10000': 'AppleEvent handler failed' };
const asReason = (r) => {
  const err = (r.stderr || '').trim(), num = (/\((-?\d+)\)\s*$/.exec(err) || [])[1];
  if (r.error && r.error.code === 'ENOENT') return 'osascript not found';
  if (r.signal) return `killed by ${r.signal} (spawn timeout)`;
  return `osascript exit ${r.status}${num ? `, AppleScript error ${num}: ${AS_ERR[num] || err.split(':').pop().trim().slice(0, 80)}` : err ? ': ' + err.replace(/^.*execution error:\s*/, '').slice(0, 100) : ''}`;
};

// ── SEC ticker → name map (30-day TTL, gitignored) ───────────────────────────
function fetchTickerMap(env) {
  const f = D('.tickers.json'), cached = rd(f);
  if (cached && cached.byTicker && Date.now() - Date.parse(cached.at) < 30 * 864e5) return Promise.resolve({ fresh: true, byTicker: cached.byTicker });
  const UA = process.env.SEC_UA || env.SEC_UA || (env.EMAIL_FROM ? `Dominic Zhao portfolio-dashboard ${env.EMAIL_FROM}` : null);
  if (!UA) return Promise.resolve({ fresh: false, byTicker: (cached && cached.byTicker) || {} });
  return new Promise(res => {
    const req = https.get('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': UA }, timeout: 15000 }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); });
    req.on('error', () => res('')); req.on('timeout', () => { req.destroy(); res(''); });
  }).then(body => {
    const byTicker = {}; try { Object.values(JSON.parse(body)).forEach(x => { if (x && x.ticker) byTicker[String(x.ticker).toUpperCase()] = { cik: x.cik_str, n: x.title }; }); } catch (_) {}
    if (!Object.keys(byTicker).length) return { fresh: false, byTicker: (cached && cached.byTicker) || {} };
    if (!DRY) writeJson(f, { at: new Date().toISOString(), byTicker });
    return { fresh: true, byTicker };
  });
}

async function main() {
  if (SINCE_ARG != null && !isRealDate(SINCE_ARG)) fail(`--since must be a real calendar date, YYYY-MM-DD (got ${JSON.stringify(SINCE_ARG)})`);
  const env = readEnv();
  if (!env.EMAIL_FROM) fail('EMAIL_FROM is not set in ~/.claude/portfolio-brief.env — no Mail account to read');
  const since = SINCE_ARG || addDays(todaySGT, -7);
  const trusted = new Set([env.EMAIL_TO, env.EMAIL_FROM].filter(Boolean).map(s => s.toLowerCase()));
  const CURSOR = path.join(process.env.HOME || '', '.claude', 'journal-cursor.json');
  const cursor = Object.assign({ lastRunAt: null, lastAlarmDate: null, seen: {} }, rd(CURSOR) || {});
  if (!cursor.seen || typeof cursor.seen !== 'object' || Array.isArray(cursor.seen)) cursor.seen = {};
  const saveCursor = () => { if (!DRY) writeJson(CURSOR, cursor); };
  const alarm = reason => {
    if (QUIET || !env.NTFY_TOPIC || cursor.lastAlarmDate === todaySGT) return;
    const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Title: Portfolio journal', '-H', 'Tags: warning', '-H', 'Priority: high',
      '-d', `journal: could not read replies (${reason})`, `https://ntfy.sh/${env.NTFY_TOPIC}`], { encoding: 'utf8', timeout: 20000 });
    if ((r.stdout || '').trim() === '200') { cursor.lastAlarmDate = todaySGT; saveCursor(); }
  };
  const failRead = reason => { alarm(reason); fail(`could not read replies (${reason})`); };

  // ── Mail ────────────────────────────────────────────────────────────────
  const [Y, M, DD] = since.split('-').map(Number);
  const timeout = Math.max(300, 60 + 2 + 45 * (MAILBOXES + 2) + 30) * 1000;
  const r = spawnSync('osascript', ['-', env.EMAIL_FROM, String(Y), String(M), String(DD)], { input: AS, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.signal || r.status !== 0) failRead(asReason(r));
  const recs = (r.stdout || '').split('').filter(x => x.trim()).map(x => x.split(''));
  const H = recs.find(x => x[0] === 'H');
  if (!H) failRead('no header from AppleScript');
  const isot = H[1], gmt = +H[2];
  if (isot !== since + 'T00:00:00') failRead(`date bound mismatch — asked ${since}, Mail built ${isot}`);
  const boxes = recs.filter(x => x[0] === 'M').map(x => ({ name: x[1], n: +x[2] || 0, k: +x[3] || 0, mode: x[4], partial: x[5] === '1', err: +x[6] || 0, oldest: x[7] || '', total: +x[8] }));
  const boxLine = boxes.map(b => `${b.name} ${b.n} in window (${b.mode}${b.partial ? ', partial back to ' + (b.oldest || '?') : ''}${b.err ? ', err ' + b.err : ''})`).join(' · ') || 'no INBOX/Spam/Junk mailbox found';
  const hdr = `journal: date bound ${isot} (time to GMT ${gmt >= 0 ? '+' : ''}${gmt}s) · ${boxLine}`;
  if (!boxes.length) { console.log(hdr); failRead('account has no INBOX/Spam/Junk mailbox'); }

  // ── candidates: subject + sender filtered here (authoritative), sorted by receivedAt ──
  const rows = recs.filter(x => x[0] === 'R').map(x => {
    const receivedAt = G.isotToISO(x[5], gmt), sender = x[4] || '', addr = ((/<([^>]+)>/.exec(sender) || [null, sender])[1] || '').trim().toLowerCase();
    return { id: x[1], mailId: x[2] || `mail:${x[5]}:${x[1]}`, subject: x[3] || '', addr, domain: addr.split('@').pop() || '?', receivedAt, content: x[6] || '', contentErr: x[7] || '' };
  }).filter(x => /^\s*re\s*:/i.test(x.subject) && MARK.test(x.subject)).sort((a, b) => a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0);

  const JF = D('journal.ndjson'), existing = ndj(JF), have = new Set(existing.map(e => e.messageId)), haveMail = new Set(existing.map(e => e.mailId || e.messageId));
  const actHist = ndj(D('.oneaction-history.ndjson'));
  const counts = { replies: 0, applied: 0, seen: 0, untrusted: 0, unreadable: 0, verbs: {} }, now = new Date().toISOString();
  const newRows = [];
  const append = row => { if (have.has(row.messageId)) return; have.add(row.messageId); newRows.push(row); if (!DRY) fs.appendFileSync(JF, JSON.stringify(row) + '\n'); };
  let tickerMap = null;
  const tmap = async () => tickerMap || (tickerMap = await fetchTickerMap(env));

  for (const x of rows) {
    if (cursor.seen[x.mailId] || haveMail.has(x.mailId)) { counts.seen++; continue; }
    if (x.contentErr) { counts.unreadable++; continue; }                       // not marked seen: retried next run
    counts.replies++;
    if (!trusted.has(x.addr)) {
      counts.untrusted++;
      append({ at: now, briefDate: null, receivedAt: x.receivedAt, messageId: x.mailId, mailId: x.mailId, verb: 'UNTRUSTED', arg: '', key: null, raw: '', trusted: false, domain: x.domain });
      cursor.seen[x.mailId] = x.receivedAt; saveCursor(); continue;
    }
    const pr = G.parseReply({ subject: x.subject, body: x.content, receivedAt: x.receivedAt, history: actHist });
    const bound = actHist.filter(h => h.date === pr.briefDate).pop(), boundKey = bound ? bound.key : 'none', rdate = sgtDate(x.receivedAt) || todaySGT;
    for (let ci = 0; ci < pr.commands.length; ci++) {
      const c = pr.commands[ci];
      const row = { at: now, briefDate: pr.briefDate, receivedAt: x.receivedAt, messageId: ci ? `${x.mailId}#${ci + 1}` : x.mailId, mailId: x.mailId, verb: c.verb, arg: c.arg, key: c.key || boundKey, raw: c.raw };
      if (c.reason) row.reason = c.reason;
      counts.verbs[c.verb] = (counts.verbs[c.verb] || 0) + 1;
      try {
        if (c.verb === 'WATCH' || c.verb === 'UNWATCH') {
          const wf = D('watchlist.json'), wl = rd(wf) || { us: [] }; if (!Array.isArray(wl.us)) wl.us = [];
          const T = c.ticker, i = wl.us.findIndex(w => String(w.t || '').toUpperCase() === T);
          row.ticker = T;
          if (c.verb === 'UNWATCH') {
            if (i < 0) { row.applied = false; row.note = 'not on the watchlist'; }
            else { wl.us.splice(i, 1); wl.asOf = todaySGT; row.applied = true; if (!DRY) writeJson(wf, wl); }
          } else if (i >= 0) { row.applied = true; row.note = 'already on the watchlist'; }
          else {
            const m = await tmap(), hit = m.byTicker[T];
            if (m.fresh && !hit) { row.applied = false; row.note = 'unresolved ticker'; }
            else { wl.us.push({ t: T, n: hit ? hit.n : null, why: `WATCH reply ${rdate}` }); wl.asOf = todaySGT; row.applied = true; if (!hit) row.note = 'name pending'; if (!DRY) writeJson(wf, wl); }
          }
        } else if (c.verb === 'DECIDE') {
          const pf = D('policy.json'), pol = rd(pf);
          if (!pol) { row.applied = false; row.note = 'policy.json unreadable'; }
          else { pol.decisions = pol.decisions || {}; pol.decisions[c.n] = { status: 'decided', at: now, via: 'email reply' }; row.applied = true; row.n = c.n; if (!DRY) writeJson(pf, pol); }
        } else if (c.verb === 'LOAN') {
          const book = rd(D('book.json')), loanId = book && book.ibkr && book.ibkr.loanId;
          row.amount = c.amount;
          if (!loanId) { row.applied = false; row.note = 'book.json has no ibkr.loanId'; }
          else if (DRY) { row.applied = false; row.note = 'dry-run: not applied'; }
          else {
            let eb = null;
            try { eb = require('./edit-book.js'); } catch (e) { row.applied = false; row.note = 'edit-book.js not available'; }
            if (eb) {
              if (typeof eb.editBook !== 'function') { row.applied = false; row.note = 'edit-book.js exports no editBook()'; }
              else { const res = eb.editBook({ id: loanId, value: -Math.abs(c.amount), source: `email reply ${rdate}` }); row.applied = res && res.ok !== false; row.markAsOf = res && res.markAsOf || todaySGT; if (!row.applied) row.note = 'edit-book refused'; }
            }
          }
        } else row.applied = c.verb !== 'UNPARSED';                                  // DONE / DEFER / NOTE: journal only
      } catch (e) { row.applied = false; row.note = String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 120); }
      if (row.applied) counts.applied++;
      append(row);
    }
    cursor.seen[x.mailId] = x.receivedAt; saveCursor();
  }

  // ── cursor housekeeping, journal.json, log ──────────────────────────────
  const keep = addDays(todaySGT, -14);
  for (const [id, at] of Object.entries(cursor.seen)) if (!at || (sgtDate(at) || '') < keep) delete cursor.seen[id];
  cursor.lastRunAt = now; saveCursor();
  if (!DRY) {
    const all = (() => { const s = new Set(); return ndj(JF).filter(e => { if (!e.messageId || s.has(e.messageId)) return false; s.add(e.messageId); return true; }); })();
    const last = all.map(e => e.receivedAt || e.at).filter(Boolean).sort().pop();
    writeJson(D('journal.json'), { asOf: last ? sgtDate(last) || todaySGT : todaySGT, count: all.length, entries: all.slice(-200) });
  }
  const verbs = Object.entries(counts.verbs).map(([v, n]) => `${v} ${n}`).join(', ');
  console.log(hdr);
  console.log(`journal: ${counts.replies} new repl${counts.replies === 1 ? 'y' : 'ies'} · applied ${counts.applied}${verbs ? ` (${verbs})` : ''} · ignored ${counts.untrusted} untrusted · ${counts.seen} already seen${counts.unreadable ? ` · ${counts.unreadable} unreadable (retry next run)` : ''}${DRY ? ' · dry-run, nothing written' : ` · ${newRows.length} row(s) appended`}`);
  // a mailbox that errored and returned nothing may hide yesterday's replies → alarm (once a day)
  const short = boxes.filter(b => b.err && !b.n);
  if (short.length) failRead(short.map(b => `${b.name} unreadable (error ${b.err})`).join('; '));
  if (counts.unreadable) failRead(`${counts.unreadable} reply content(s) unreadable`);
}

main().catch(e => { console.error('journal: FAILED — ' + (e && e.message || e)); process.exit(1); });
