#!/usr/bin/env node
/*
 * cutover-check.js — the seven-clean-day clock for retiring index.html's Yahoo path.
 *
 * Phase 4 of the 11 Sep 2026 redesign. The proposal said "delete all eight Yahoo call sites after
 * seven clean parallel days" — but no ledger of green/red publishes existed, so the clock could
 * never have been read, and the first day through publish.js is 12 Sep. This file reads the
 * ledger publish.js now writes (data/.publish-history.ndjson, local) and answers ONE question
 * every morning: is the code path (valuate.js → valuation.enc) proven equal to the page's own
 * arithmetic on enough consecutive days that the page can switch to it?
 *
 * A CLEAN DAY is an SGT weekday whose LAST non-dry-run ledger row is green AND that run's
 * data/.validation.json `passed` carries the book↔index.html parity line. A red weekday RESETS the
 * streak (a day the gates refused to publish is not parallel-running, it is broken); weekends
 * are skipped, not counted; a past weekday with no row at all (Mac off) also resets. Today with
 * no row yet is pending, never judged. Dry-run rows are ignored entirely, so a manual --dry-run
 * before 07:25 (brief.json still yesterday's → validate-all red) can never touch the clock.
 *
 * The parity line is per-run and .validation.json is overwritten by every run, so this file
 * records each day's verdict into .cutover.json.days as it goes (the run right after publish.js
 * sees that run's report) and carries earlier days forward. A day whose report was never seen
 * has parityOk:null and is not clean.
 *
 * PAGE PARITY is a separate precondition: an eyeball of the live page's NAV against
 * valuation.navSGD, recorded with `--page-nav <SGD as shown on the page>`. Same holdings, same
 * marks — the two may differ only by FX source and bar timing (valuation.fxSourceSensitivity
 * quantifies the FX leg). |diff| ≤ 0.5% confirms. `ready` needs BOTH the streak and the parity.
 *
 * Output data/.cutover.json (gitignored; daily-brief.js prints the clock line from it):
 *   { asOf, at, since:'2026-09-12', needed:7, cleanDays, streak:[dates], earliestReady, ready,
 *     lastDay:{date,status,step,validateAllExit,parityOk,parityDiffPct} | null,
 *     pageParity:{checkedOn,pageNavSGD,codeNavSGD,diffPct} | null,
 *     days:{ 'YYYY-MM-DD': {status,step,validateAllExit,parityOk,at} }, rule }
 * --dry-run prints and writes nothing. Exit 1 with one line on a malformed ledger/valuation.
 *
 * ═══ CUTOVER EDIT LIST (index.html, build 61 — line numbers from the 12 Sep map; apply in phase 5
 * once this file prints ready:true; E5 and every yfFetch caller E7/E8/E12–E17 land in ONE commit
 * or the page throws ReferenceError at first use) ═══════════════════════════════════════════════
 *  E1  L7: vendor lightweight-charts@4.1.3 locally (1-line edit, +1 file ~300 KB) or delete both
 *      chart renderers (renderNav area chart L909-947, setChartPeriod candlesticks L1202-1213).
 *  E2  insert <script src="common.js"></script> before L505 (+1): PCC.loadEncrypted prompts for the
 *      passphrase once per device; renderAll must guard H.length===0 (cancelled prompt).
 *  E3  delete the 83-line H literal L521-603; `let H=[]` + async boot from
 *      PCC.loadEncrypted('data/book.enc') then re-tag SECTOR (L606, stays in HTML or moves to
 *      book.json) (+6). extract-book.js / validate-all parity retire with it (book.json is the
 *      source of truth; edit-book.js stamps mark.asOf).
 *  E4  L609-610 FX seeds → data/fx.json rates (SGD per unit, +4); delete fxArrow L678-687 (-10) or
 *      return '' until fx-history.ndjson has ≥2 rows.
 *  E5  delete L614-632 PROXIES / yfFetch / sleep (-19).
 *  E6  rewrite loadAll L634-665 (-32/+30): Promise.all(fx.json, .prices.json, technicals.json,
 *      PCC.loadEncrypted('data/valuation.enc')); pd[t] = {price: line.price, priceAsOf,
 *      prevClose: bars[n-2].c, r1d: bars[n-1].pct/100, r1w from bars[n-6], high52/low52 from
 *      technicals, history: the 12 bars}; setStatus via PCC.stampHTML(valuation.asOf,'daily');
 *      assert |page NAV − valuation.navSGD| ≤ 0.5%.
 *  E7  delete resolveName L851 + wikiSummary L856 (L842-858, -17); fillAbout keeps only the
 *      gatherWhy() half (intel/investors). The modal loses the Wikipedia blurb.
 *  E8  rewrite openTicker L882-902 (-21/+15): spine symbols from .prices.json bars + technicals
 *      52w/sma; anything else shows a "not in the price spine" card.
 *  E9  renderActionAlerts L2441-2464 → technicals.json.instruments[h.yf] {close, sma200, sma50,
 *      distPct200, dd52wPct, gate} — same rule on the previous completed close (~8 lines).
 *  E10 delete navCurve/navPeriods L779-807 (-30); trim renderNav L909-947 (-20): #nav-val /
 *      #nav-day / #nav-1d from valuation.navSGD / dayChgSGD / dayChgPct; 1M/3M/YTD/1Y NAV cells
 *      and the NAV chart go unless owner decision D1 publishes a closes history; #nav-chart L250
 *      removed or repurposed.
 *  E11 renderAll L949-982, period grid L255-262, holdRow pills L990-1009, class/region tables
 *      L1036-1063, attribution L1084-1096, heatmaps L1117-1139, modal period buttons L490-494:
 *      1M/3M/YTD/1Y → '—' or removed; heatmap key → r1w or technicals.mom12_1Pct; period row →
 *      '12d'; Refresh button L186 re-worded (it re-fetches same-origin JSON published at 07:02).
 *  E12 delete fetchModelOne L1951-1960 (-10) and MODEL_UNIVERSE L1822-1878 + buildModel
 *      L1894-1950 (~-115, dead since phase 0). KEEP L1882-1888 (clip, normCdf, STANCE_TILT,
 *      buildMacroTilt, macroTiltFor) — scoreHolding L2184 and renderOffside L2235 use them.
 *  E13 delete computeLiveBreadth L1977-1999 (-23) and its call at L2027; the baked
 *      market.json.breadth rows keep rendering via renderBreadth L2068-2080.
 *  E14 delete fetchFearGreedLive L2029-2053 (-25) and its call at L2027; market.json.fearGreed
 *      (value, rating, prev*, crypto, components) is the full substitute; '● live' → dated stamp.
 *  E15 delete loadRiskFactors L2123-2128 (+FACTORS L2096) and its call at L2194. computeRisk
 *      L2129-2170 then has no >40-bar input: hide the Risk tab (nav L201, panel L305-319) and
 *      render valuation.silver + targets.json + silver-backtest.json instead, unless D1.
 *  E16 delete quantScoreSym L2293-2306 (-14) and its call at L2333; re-derive the quant chip from
 *      technicals.json for spine symbols only (+3), drop it for others.
 *  E17 delete the ApeWisdom Reddit block L2327-2331 (-5) and the Reddit section in openConsDetail
 *      L2340; then bump BUILD (L1230) and data/version.json TOGETHER so checkBuild L1231-1247
 *      forces cached clients to reload.
 * ═══ OWNER DECISIONS the list needs before phase 5 ═════════════════════════════════════════════
 *  D1  Publish a closes-only multi-month history (e.g. data/.closes-1y.json ≈ 0.7 MB, 66
 *      instruments × ~250 closes — contradicts .prices-2y.json's current 'sensitive' class) so the
 *      NAV curve, 1M/3M/YTD/1Y returns, heatmaps and the Risk tab's VaR/beta/scenarios survive —
 *      or accept losing them (only 12 bars per instrument are published today).
 *  D2  Vendor lightweight-charts@4.1.3 into the repo, or remove both chart renderers.
 *  D3  Passphrase persistence: common.js stores it in plaintext localStorage ('pcc.passphrase')
 *      on a page whose password gate is disabled (GATE_ON=false L513) — keep, or switch to
 *      sessionStorage / re-prompt per session.
 */
const fs = require('fs'), path = require('path');
const D = f => path.join(__dirname, '..', 'data', f);
const J = f => { try { return JSON.parse(fs.readFileSync(D(f), 'utf8')); } catch (_) { return null; } };
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const SINCE = '2026-09-12', NEEDED = 7, PARITY_TOL_PCT = 0.5;
const PARITY_RE = /^book: \d+ holdings match index\.html exactly/;
const LEDGER = D('.publish-history.ndjson'), OUT = D('.cutover.json');
const RULE = `a clean day = SGT weekday whose last non-dry-run publish row is green AND that run's .validation.json passed includes the book↔index.html parity line; a red weekday resets the streak, weekends are skipped; ready also needs page parity confirmed via --page-nav within ${PARITY_TOL_PCT}%`;
const die = m => { console.error(`cutover-check: ${m}`); process.exit(1); };

const isWeekday = d => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w >= 1 && w <= 5; };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const nextWeekday = d => { while (!isWeekday(d)) d = addDays(d, 1); return d; };
const nthWeekday = (from, n) => { let d = nextWeekday(from); for (let c = 1; c < n; c++) d = nextWeekday(addDays(d, 1)); return d; };
const nice = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// ── ledger → last non-dry row per date ────────────────────────────────────
const rows = [];
if (fs.existsSync(LEDGER)) fs.readFileSync(LEDGER, 'utf8').split('\n').forEach((l, i) => {
  if (!l.trim()) return;
  let r; try { r = JSON.parse(l); } catch (_) { die(`data/.publish-history.ndjson line ${i + 1} is not JSON — fix or delete that line`); }
  if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) || !r.status) die(`data/.publish-history.ndjson line ${i + 1} lacks date/status`);
  rows.push(r);
});
rows.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
const byDate = {};
rows.filter(r => r.status !== 'dry-run').forEach(r => { byDate[r.date] = r; });

// ── per-day verdicts: today's report is live, earlier days are carried forward ───────────────
const prev = J('.cutover.json') || {};
const days = { ...(prev.days || {}) };
const val = J('.validation.json');
const live = val && /^\d{4}-\d{2}-\d{2}$/.test(String(val.checkedOn)) ? { date: val.checkedOn, ok: (val.passed || []).some(p => PARITY_RE.test(p)) } : null;
for (const [d, r] of Object.entries(byDate)) {
  const parityOk = live && live.date === d ? live.ok : (days[d] && typeof days[d].parityOk === 'boolean' ? days[d].parityOk : null);
  days[d] = { status: r.status, step: r.step || null, validateAllExit: r.validateAllExit ?? null, parityOk, at: r.at || null };
}

// ── the streak ────────────────────────────────────────────────────────────
const streak = []; let pending = false;
for (let d = SINCE; d <= today; d = addDays(d, 1)) {
  if (!isWeekday(d)) continue;
  const day = days[d];
  if (!day) { if (d === today) pending = true; else streak.length = 0; continue; }
  if (day.status === 'green' && day.parityOk === true) streak.push(d); else streak.length = 0;
}
const cleanDays = streak.length;
const startsAt = cleanDays ? streak[0] : (pending ? today : nextWeekday(addDays(today, 1)));
const earliestReady = nthWeekday(startsAt, NEEDED);

// ── page parity precondition ──────────────────────────────────────────────
let pageParity = prev.pageParity && typeof prev.pageParity.diffPct === 'number' ? prev.pageParity : null;
const pi = args.indexOf('--page-nav');
if (pi >= 0) {
  const page = Number(String(args[pi + 1] || '').replace(/[,\s]/g, ''));
  if (!(page > 0)) die('--page-nav needs the NAV in SGD as shown on the live page, e.g. --page-nav 10346203.85');
  const v = J('valuation.json');
  if (!v || !(v.navSGD > 0)) die('data/valuation.json has no navSGD — run scripts/valuate.js first');
  pageParity = { checkedOn: today, pageNavSGD: page, codeNavSGD: v.navSGD, diffPct: +(((page / v.navSGD) - 1) * 100).toFixed(3), codeAsOf: v.asOf || null };
}
const pageParityOk = !!pageParity && Math.abs(pageParity.diffPct) <= PARITY_TOL_PCT;
const ready = cleanDays >= NEEDED && pageParityOk;

const lastDate = Object.keys(byDate).sort().pop() || null;
const lastDay = lastDate ? { date: lastDate, status: days[lastDate].status, step: days[lastDate].step, validateAllExit: days[lastDate].validateAllExit,
  parityOk: days[lastDate].parityOk, parityDiffPct: pageParity ? pageParity.diffPct : null } : null;

const out = { asOf: today, at: new Date().toISOString(), since: SINCE, needed: NEEDED, cleanDays, streak, earliestReady, ready, lastDay, pageParity, days, rule: RULE };
if (!DRY) { const t = OUT + '.tmp'; fs.writeFileSync(t, JSON.stringify(out, null, 2) + '\n'); fs.renameSync(t, OUT); }

console.log(`cutover-check — ${today}: ${cleanDays}/${NEEDED} clean parallel days (since ${nice(SINCE)}) · earliest ready ${nice(earliestReady)} · ready: ${ready}${DRY ? ' (dry-run — nothing written)' : ''}`);
console.log(`  streak: ${cleanDays ? streak.join(', ') : 'none'}${pending ? ' · today pending (no publish row yet)' : ''}`);
console.log(lastDay ? `  last publish: ${lastDay.date} ${lastDay.status} at ${lastDay.step} · validate-all exit ${lastDay.validateAllExit} · book↔index parity ${lastDay.parityOk === null ? 'not seen' : lastDay.parityOk ? 'ok' : 'FAILED'}`
  : '  last publish: none yet — the ledger starts with the first publish.js run');
console.log(pageParity ? `  page parity: ${pageParityOk ? 'confirmed' : 'NOT within tolerance'} ${pageParity.checkedOn} (${pageParity.diffPct >= 0 ? '+' : ''}${pageParity.diffPct}% page vs valuation.navSGD)`
  : '  page parity: not yet confirmed — eyeball the live page\'s NAV and run: node scripts/cutover-check.js --page-nav <SGD>');
