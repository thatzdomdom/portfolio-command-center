#!/usr/bin/env node
/*
 * manifest.js — one file that says, for every published data file, what DATE its data is (asOf),
 * when it was GENERATED, how often it is meant to refresh, and the fetcher's own counts.
 *
 * The as-of and the generation time are deliberately separate fields. The dashboard once stamped
 * quarter-old 13F data "refreshed yesterday" with a green dot because it read the job's run time.
 * common.js's freshness() reads ONLY asOf against cadence, so a quarterly file cannot look fresh
 * for having been fetched this morning. A count of zero where a count is expected (a Form 4 day
 * that scanned nothing) is a red, not an empty table.
 *
 * Contains no balances, no holdings, no marks — names, dates and counts only. Published plaintext
 * so the GitHub-hosted dead-man can read it without a passphrase.
 */
const fs = require('fs'), path = require('path');
const D = f => path.join(__dirname, '..', 'data', f);
const J = f => { try { return JSON.parse(fs.readFileSync(D(f), 'utf8')); } catch (_) { return null; } };
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

// name → { asOf extractor, cadence, count extractor, source }
const SPEC = {
  'news.json':        { as: j => j.updated,            cadence: 'daily',   count: j => (j.items || []).length, source: 'research agent + adversarial verifier' },
  'model.json':       { as: j => j.macro && j.macro.asOf, cadence: 'daily', count: j => (j.calls || []).length, source: 'research agent (macro); pUp calls unpublished since phase 0' },
  'market.json':      { as: j => j.updated,            cadence: 'daily',   count: null, source: 'research agent' },
  'brief.json':       { as: j => String(j.date || '').slice(0, 10), cadence: 'daily', count: j => (j.tldr || []).length, source: 'research agent' },
  'intel.json':       { as: j => j.updated || j.asOf,  cadence: 'daily',   count: j => ((j.insiders || []).length + (j.congress || []).length), source: 'research agent; price-gated' },
  'investors.json':   { as: j => String(j.updated || '').slice(0, 10), cadence: 'daily-verify', count: j => (j.notableTrades || []).length, source: '13F ingest; quarterly by law' },
  '.prices.json':     { as: j => j.latestByExchange && Object.entries(j.latestByExchange).filter(([k]) => k !== 'CRYPTO').map(([, v]) => v).sort().pop(), cadence: 'daily', count: j => Object.keys(j.instruments || {}).length, source: 'price-spine.js (Yahoo chart, ETF-proxied)' },
  'closes.json':      { as: j => j.asOf, cadence: 'daily', count: j => Object.keys(j.instruments || {}).length, source: 'closes.js (2y daily closes, exchange-indexed, from .prices-2y)' },
  '.calendar.json':   { as: j => String(j.generated || '').slice(0, 10), cadence: 'daily', count: j => ((j.released || []).length + (j.upcoming || []).length), source: 'calendar-spine.js (ForexFactory)' },
  'fx.json':          { as: j => j.asOf,               cadence: 'daily',   count: j => Object.keys(j.rates || {}).length, source: 'fx.js (ECB reference rates)' },
  'book.json':        { as: j => j.asOf,               cadence: 'manual',  count: j => (j.holdings || []).length, source: 'extract-book.js', published: 'book.enc' },
  'valuation.json':   { as: j => j.asOf,               cadence: 'daily',   count: j => (j.lines || []).length, source: 'valuate.js', published: 'valuation.enc' },
  'signals.json':     { as: j => (j.scans || []).slice(-1)[0] && (j.scans.slice(-1)[0].date), cadence: 'daily', count: j => (j.form4 || []).length, source: 'form4-scan.js (EDGAR daily index; GitHub Actions)' },
  'alerts.json':      { as: j => String(j.generatedAt || '').slice(0, 10), cadence: 'daily', count: j => (j.alerts || []).length, source: 'alerts.js (policy.json applied to signals)' },
  'watchlist.json':   { as: j => j.asOf, cadence: 'manual', count: j => (j.us || []).length, source: 'owner' },
  'policy.json':      { as: j => j.version, cadence: 'manual', count: null, source: 'owner-editable thresholds' },
  'technicals.json':  { as: j => j.asOf, cadence: 'daily', count: j => Object.keys(j.instruments || {}).length, source: 'technicals.js (trend gate, vol, drawdown from .prices-2y)' },
  'targets.json':     { as: j => j.asOf, cadence: 'daily', count: j => (j.diff || []).length, source: 'targets.js (SHADOW policy weights)' },
  'silver-backtest.json': { as: j => j.asOf, cadence: 'weekly', count: j => ((j.delevers && j.delevers.gated) || []).length, source: 'silver-backtest.js (SLV full history, margin-account model)' },
  '.validation.json': { as: j => j.checkedOn,          cadence: 'daily',   count: j => (j.problems || []).length, source: 'validate-all.js (count = problems)' },
  // Phase 4 (12 Sep 2026): the write path. Both are private (encrypted at publish); the manifest
  // carries a count only — never the action text or a reply. The publish ledger is local and has
  // no entry here at all.
  'oneaction.json':   { as: j => j.date, cadence: 'daily', count: j => (j.action && j.action.kind === 'action' ? 1 : 0), source: 'one-action.js (count = 1 when an action is open)', published: 'oneaction.enc' },
  'journal.json':     { as: j => j.asOf, cadence: 'manual', count: j => (j.count != null ? j.count : (j.entries || []).length), source: 'journal.js (email replies; count = entries)', published: 'journal.enc' },
  // Phase 6 (13 Sep 2026): 13F from EDGAR, parsed by code. asOf is the newest PERIOD a tracked fund reported,
  // never the scan time — a quarterly table ages as quarterly however often it is re-checked.
  '13f.json':         { as: j => Object.values(j.funds || {}).map(f => f.latest && f.latest.period).filter(Boolean).sort().pop(), cadence: 'quarterly', count: j => Object.values(j.funds || {}).filter(f => f.latest && f.latest.period).length, source: '13f-scan.js (SEC EDGAR 13F filings; GitHub Actions; count = funds with a table)' },
  'funds.json':       { as: j => j.asOf, cadence: 'manual', count: j => (j.funds || []).filter(f => f.track).length, source: 'owner-curated 13F filer list (count = tracked)' },
  // Phase 7 (19 Sep 2026): HKEX disclosure of interests. asOf is the last SUCCESSFUL SCAN, not the
  // newest notice, and this is the one place in this table where that is the honest answer. The HK
  // sleeve files almost nothing — Tencent lodged ONE notice in the 90 days to 19 Sep 2026 — so a
  // daily cadence measured against the newest filing would read STALE on most mornings, turn
  // today.html's pipeline block red and move it to the top of the page for a feed that is working
  // perfectly. What refreshes daily here is the CHECK, so the check is what is stamped, exactly as
  // .validation.json stamps checkedOn. The same rule is why validate-all's PHASE 7 judges liveness
  // on scan.checkedAt and never on filings.length. count is the notices retained, and zero is a
  // normal week, not a red.
  'hkex.json':        { as: j => { const s = (j.scans || []).filter(x => x && !x.error).slice(-1)[0], t = Date.parse((s && s.at) || (j.scan && j.scan.checkedAt) || '');
                          return isNaN(t) ? null : new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); },
                        cadence: 'daily', count: j => (j.filings || []).length,
                        source: 'hkex-di.js (HKEX Disclosure of Interests, keyless; GitHub Actions; asOf = last successful scan, count = notices retained)' },
};

const files = {};
for (const [name, s] of Object.entries(SPEC)) {
  const j = J(name);
  if (!j) { files[name] = { missing: true, cadence: s.cadence, source: s.source }; continue; }
  const asOf = s.as(j) || null;
  files[name] = { asOf, generatedAt: j.generatedAt || j.generated || null, cadence: s.cadence,
    count: s.count ? s.count(j) : null, source: s.source, ...(s.published ? { published: s.published } : {}) };
}
const out = { sgtDate: today, generatedAt: new Date().toISOString(), files };
fs.writeFileSync(D('manifest.json'), JSON.stringify(out, null, 2) + '\n');
const bad = Object.entries(files).filter(([, f]) => f.missing).map(([n]) => n);
console.log(`manifest.json: ${Object.keys(files).length} files · sgtDate ${today}` + (bad.length ? ` · MISSING: ${bad.join(', ')}` : ''));
