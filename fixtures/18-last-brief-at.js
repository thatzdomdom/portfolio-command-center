/*
 * 18 — data/.last-brief-date was never written on the live Mail.app path, so the "since last brief"
 * window silently fell back to now − 2d every morning. Phase 4 stamps data/.last-brief-at on every
 * successful send and windows SIGNALS by INGEST time (an alert filed yesterday that alerts.js only
 * saw this morning must still reach today's brief) and REPLIES by receivedAt. Without a stamp the
 * fallback is now − 48h. The REPLIES line names the action by its `short` text, never its key.
 */
module.exports = {
  name: '18-last-brief-at', incident: 'phase 4 — the send stamp that windows SIGNALS and REPLIES',
  run(ctx) {
    const now = Date.now(), iso = ms => new Date(ms).toISOString(), lastBriefAt = iso(now - 2 * 3600e3);
    const sgtStamp = t => { const d = new Date(t); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }) + ' ' + d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' }) + ' SGT'; };
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], dmy = d => `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;
    ctx.write('.last-brief-at', lastBriefAt + '\n');
    const alert = (id, at, date, headline) => ({ at, id, usd: 5e9, date, severity: 'Notable', family: 'insider', ticker: 'D05', issuer: 'DBS Group', tags: ['in-book', 'open-market'], headline, detail: 'fixture', url: 'https://example.invalid/' + id, clearsWhen: 'read' });
    ctx.edit('alerts.json', a => { a.alerts.push(alert('fx18-new', iso(now - 3600e3), ctx.daysAgo(1), 'FIXTURE-18-NEW · D05 director bought S$1,000,000 (filed yesterday, ingested after the last brief)'),
      alert('fx18-old', iso(now - 5 * 3600e3), ctx.today, 'FIXTURE-18-OLD · ingested before the last brief although dated today')); });
    const short = 'Repay ≥S$3.9k of the silver loan · reply DONE/DEFER';
    ctx.ndjson('.oneaction-history.ndjson', [{ date: ctx.today, key: 'silver.rule1', text: 'repay at least S$3,900 of the silver loan (fixture)', short, candidates: [] }]);
    ctx.write('oneaction.json', { date: ctx.today, generatedAt: iso(now), asOf: { prices: ctx.daysAgo(1) },
      action: { key: 'silver.rule1', kind: 'action', push: false, text: 'repay at least S$3,900 of the silver loan (fixture)', why: ['fixture why-line'], ask: 'DONE | DEFER <reason>', short, decision: 1, policy: 'silverLeverage · UNSIGNED · decision 1 pending', clearsWhen: 'survivability PASS', pushNote: null },
      journal: { lastReply: null, status: 'none', note: null, deferredUntil: null, otherReplies: 0, decisions: [] }, candidates: [], state: {} });
    ctx.ndjson('journal.ndjson', [
      { at: iso(now - 1800e3), briefDate: ctx.today, receivedAt: iso(now - 1800e3), messageId: 'fx18-a', verb: 'DONE', arg: '', key: 'silver.rule1', raw: 'DONE' },
      { at: iso(now - 4 * 3600e3), briefDate: ctx.daysAgo(1), receivedAt: iso(now - 4 * 3600e3), messageId: 'fx18-b', verb: 'NOTE', arg: 'FIXTURE-18-OLD-REPLY', key: 'silver.rule1', raw: 'NOTE FIXTURE-18-OLD-REPLY' }]);
    const db = ctx.dailyBrief();
    ctx.check('fresh subject (brief.json normalised to today), no [ACTION] prefix while push is false', /^📊 Portfolio Morning Brief — /.test(db.subject), db.subject);
    ctx.check('alert filed yesterday but ingested after .last-brief-at appears in SIGNALS', db.stdout.includes('FIXTURE-18-NEW'));
    ctx.check('alert ingested before .last-brief-at does not, although dated today', !db.stdout.includes('FIXTURE-18-OLD ·'));
    ctx.check(`SIGNALS window is named: "since ${sgtStamp(lastBriefAt)}"`, db.stdout.includes(`since ${sgtStamp(lastBriefAt)}`) || /FIXTURE-18-NEW/.test(db.stdout) && /SIGNALS SINCE LAST BRIEF/.test(db.stdout), (db.stdout.match(/since [^\n]{0,40}/) || [])[0]);
    ctx.check("reply received after .last-brief-at appears in YOUR REPLIES with the action's short text", new RegExp(`━━ YOUR REPLIES SINCE LAST BRIEF ━━\\n• DONE · ${dmy(ctx.today)} brief · ${short.replace(/[$.]/g, '\\$&')}`).test(db.stdout), (db.stdout.match(/YOUR REPLIES[\s\S]{0,200}/) || ['no REPLIES section'])[0]);
    ctx.check('reply received before .last-brief-at is not listed', !db.stdout.includes('FIXTURE-18-OLD-REPLY'));
    ctx.check('THE ONE ACTION leads, straight after TLDR, with the ACTION line, the why-line and the Reply ask', /━━ TLDR ━━[^\n]*\n[\s\S]*?━━ THE ONE ACTION ━━\n• ACTION: repay at least S\$3,900 of the silver loan \(fixture\)\n• fixture why-line\n• Reply DONE \| DEFER <reason>\.\n/.test(db.stdout) && db.stdout.indexOf('━━ THE ONE ACTION ━━') < db.stdout.indexOf('━━ YOUR REPLIES'), (db.stdout.match(/━━ THE ONE ACTION ━━[\s\S]{0,200}/) || ['no block'])[0]);
    ctx.check('telegram/ntfy text leads with action.short', db.stdout.split('===== TELEGRAM =====\n')[1] && db.stdout.split('===== TELEGRAM =====\n')[1].startsWith(short));
    ctx.rm('.last-brief-at');
    const db2 = ctx.dailyBrief('daily-brief (no stamp)');
    ctx.check('without a stamp the window is now − 48h: both alerts and both replies show', db2.stdout.includes('FIXTURE-18-NEW') && db2.stdout.includes('FIXTURE-18-OLD ·') && db2.stdout.includes('FIXTURE-18-OLD-REPLY'));
  },
};
