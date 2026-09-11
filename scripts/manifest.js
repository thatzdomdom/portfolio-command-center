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
  'silver-backtest.json': { as: j => j.asOf, cadence: 'weekly', count: j => (j.delevers || []).length, source: 'silver-backtest.js (SLV full history)' },
  '.validation.json': { as: j => j.checkedOn,          cadence: 'daily',   count: j => (j.problems || []).length, source: 'validate-all.js (count = problems)' },
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
