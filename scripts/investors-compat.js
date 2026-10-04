#!/usr/bin/env node
/*
 * investors-compat.js — the 13F keys of data/investors.json, rewritten from data/13f.json by code.
 *
 * Phase 6 of the 11 Sep 2026 redesign. index.html keeps rendering investors.json through the parallel
 * week, and until now the research agent wrote its 13F tables under a rule that bumped `updated` every
 * morning — the incentive that on 18 Aug put a fresh stamp over a quarter-old table while Q2 had been
 * public for four days. 13f-scan.js (GitHub Actions, 06:15 SGT) now reads the filings themselves; this
 * copies those facts into the shapes index.html already renders, so the old page shows EDGAR's numbers
 * and not the agent's. research-headless.sh runs it AFTER `claude -p` and BEFORE the gates: code wins
 * whatever the agent wrote to these keys, and validate-all judges what will actually ship.
 *
 * Owns exactly: updated · convictionPlays.current / .quarters (appended) / .note / .byQuarter[<the
 * consensus quarter>] · notableTrades · superInvestors.roster / .count. Everything else — profiles,
 * sectorConcentration, earlier quarters, the top-level note — is left BYTE-FOR-BYTE: the file is
 * spliced at the top level, never re-serialised whole, and the splice is re-read before the write.
 * A key outside that list whose bytes moved = refused, nothing written.
 *
 * Text is mechanical: counts, share changes, reported values, filing dates. 13F carries no trade
 * price, so none is invented. `tradeValue` is an ESTIMATE of the trade — shares changed × the
 * quarter-end price — because the change in REPORTED value mixes the trade with the quarter's price move.
 * Options and notes (PRN) have no per-share price here and keep the reported-value change, labelled Δ value.
 *
 * `updated` = the SGT date of scan.checkedAt, the last time code actually checked EDGAR — never
 * today's date for having run. Refuses (exit 1, nothing written) when 13f.json is absent, its last
 * check is more than 7 days old, or it has no consensus: a dead feed must not re-stamp the tables.
 *
 * Usage:  node scripts/investors-compat.js [--dry-run]     --dry-run prints which keys would change
 * Exit:   0 applied or already current · 1 refused (one line on stderr, investors.json untouched)
 */
const fs = require('fs'), path = require('path');
const D = f => path.join(__dirname, '..', 'data', f);
const DRY = process.argv.includes('--dry-run');
const MAX_AGE_DAYS = 7, PLAYS = 5, TRADES = 12;
const ACTIONS = ['New', 'Added', 'Reduced', 'Exited'];
const OWNED = ['updated', 'convictionPlays', 'notableTrades', 'superInvestors'];
const NO_PRICE = 'n/a — 13F carries no trade price';
const VERB = { New: ['opened a new position', 'opened new positions'], Added: ['added to a position', 'added to positions'],
  Reduced: ['reduced a position', 'reduced positions'], Exited: ['exited a position', 'exited positions'] };
const sgtDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
function refuse(msg) { console.error(`investors-compat: REFUSED — ${msg}; data/investors.json not written`); process.exit(1); }
function readJSON(f) {
  const p = D(f);
  if (!fs.existsSync(p)) return { absent: true };
  try { const text = fs.readFileSync(p, 'utf8'); return { text, json: JSON.parse(text) }; } catch (e) { return { error: String(e.message || e) }; }
}
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// ── the top-level splice ─────────────────────────────────────────────────────────────────────
// Where each top-level member's key and value sit in the ORIGINAL text. Just enough of a JSON scanner
// (strings with escapes, nested objects/arrays, bare literals) to find value boundaries; JSON.parse
// has already vouched that the text is valid.
function topLevel(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const str = () => { const s = i++; while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1; if (i >= src.length) throw new Error('unterminated string'); i++; return src.slice(s, i); };
  const value = () => {
    ws(); const s = i, c = src[i];
    if (c === '"') { str(); return [s, i]; }
    if (c === '{' || c === '[') {
      let depth = 0;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '"') { str(); continue; }
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { i++; return [s, i]; } }
        i++;
      }
      throw new Error('unbalanced brackets');
    }
    while (i < src.length && !/[\s,}\]]/.test(src[i])) i++;
    return [s, i];
  };
  const members = [];
  ws(); if (src[i] !== '{') throw new Error('top level is not an object'); i++; ws();
  if (src[i] === '}') return { members, close: i };
  for (;;) {
    ws(); if (src[i] !== '"') throw new Error(`expected a key at offset ${i}`);
    const keyStart = i, key = JSON.parse(str()); ws();
    if (src[i] !== ':') throw new Error(`expected ':' after "${key}"`); i++;
    const [valStart, valEnd] = value(); members.push({ key, keyStart, valStart, valEnd }); ws();
    if (src[i] === ',') { i++; continue; }
    if (src[i] === '}') return { members, close: i };
    throw new Error(`expected ',' or '}' at offset ${i}`);
  }
}
// Replace the owned members' values in place, append the absent ones, keep every other byte.
function splice(text, NEW) {
  const { members, close } = topLevel(text);
  const keys = members.map(m => m.key);
  if (new Set(keys).size !== keys.length) throw new Error('investors.json repeats a top-level key');
  const unit = (/^\{\r?\n([ \t]+)"/.exec(text) || [])[1] || '';            // the file's own indent (1 space today)
  const nl = unit ? '\n' : '', colon = unit ? ': ' : ':';
  const ser = v => unit ? JSON.stringify(v, null, unit).replace(/\n/g, '\n' + unit) : JSON.stringify(v);
  let out = '', cur = 0;
  for (const m of members) if (Object.prototype.hasOwnProperty.call(NEW, m.key)) { out += text.slice(cur, m.valStart) + ser(NEW[m.key]); cur = m.valEnd; }
  const missing = Object.keys(NEW).filter(k => !keys.includes(k));
  if (missing.length) {
    const at = members.length ? members[members.length - 1].valEnd : close;
    out += text.slice(cur, at) + missing.map((k, n) => (members.length || n ? ',' : '') + nl + unit + JSON.stringify(k) + colon + ser(NEW[k])).join('') + (members.length ? '' : nl);
    cur = at;
  }
  out += text.slice(cur);
  return { out, members };
}

// ── inputs ───────────────────────────────────────────────────────────────────────────────────
const f13 = readJSON('13f.json');
if (f13.absent) refuse('data/13f.json is absent (13f-scan.js has not run)');
if (f13.error) refuse(`data/13f.json is unparseable (${f13.error.slice(0, 80)})`);
const F = f13.json, checkedAt = F && F.scan && F.scan.checkedAt, checkedMs = Date.parse(checkedAt);
if (!checkedAt || isNaN(checkedMs)) refuse('data/13f.json has no scan.checkedAt — no evidence EDGAR was ever checked');
const ageDays = (Date.now() - checkedMs) / 864e5;
if (ageDays > MAX_AGE_DAYS) refuse(`data/13f.json last checked EDGAR on ${sgtDate(checkedMs)}, ${Math.floor(ageDays)} days ago (limit ${MAX_AGE_DAYS}) — a dead feed must not re-stamp the tables`);
const C = F.consensus;
if (!isObj(C) || !C.quarter || !C.period || !(C.funds > 0) || !ACTIONS.every(a => Array.isArray(C[a]))) refuse('data/13f.json has no consensus (fewer than half the active tracked funds have a table)');
const funds = isObj(F.funds) ? F.funds : {};

const inv = readJSON('investors.json');
if (inv.absent) refuse('data/investors.json is absent — there is no file to preserve');
if (inv.error) refuse(`data/investors.json is unparseable (${inv.error.slice(0, 80)})`);
const I = inv.json, text = inv.text;
if (!isObj(I)) refuse('data/investors.json is not a JSON object');
let cusips = {};
try { cusips = JSON.parse(fs.readFileSync(D('.cusips.json'), 'utf8')) || {}; } catch (_) { /* no cache: ETFs read as Stock */ }

// ── formatting (mechanical) ──────────────────────────────────────────────────────────────────
function money(v, signed) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '-' : (signed && v > 0 ? '+' : '');
  const body = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'K' : String(Math.round(a));
  return `${s}$${body}`;
}
const count = (v, signed) => (signed && v > 0 ? '+' : '') + Math.round(v || 0).toLocaleString('en-US');
const sharesText = d => d.type === 'PRN' ? `${money(d.sharesChg, true)} principal` : count(d.sharesChg, true);
// Berkshire 'Reduced' Bank of America shows +$2.50B of reported value because BAC rose 17% in the
// quarter; the shares it sold were worth about $1.72B. Shares changed × the quarter-end price is the
// honest estimate, and it is labelled as one. 13F carries no trade price, so nothing better exists.
const estTrade = d => {
  if (d.type === 'PRN' || d.putCall || !Number.isFinite(d.sharesChg) || !d.sharesChg) return null;
  const px = d.sharesLatest > 0 && Number.isFinite(d.valueUSD) ? d.valueUSD / d.sharesLatest
    : d.sharesPrior > 0 && Number.isFinite(d.valuePriorUSD) ? d.valuePriorUSD / d.sharesPrior : null;
  return px ? d.sharesChg * px : null;
};
const tradeSize = d => { const e = estTrade(d); return e != null ? e : d.valueChgUSD; };
const tradeText = d => { const e = estTrade(d); return e != null ? `≈${money(e, true)} (shares × quarter-end price)` : `${money(d.valueChgUSD, true)} Δ value`; };
function typeOf(d) {
  if (d.putCall === 'PUT') return 'Option (Put)';
  if (d.putCall === 'CALL') return 'Option (Call)';
  if (d.type === 'PRN') return 'Notes (principal)';
  const c = cusips[d.cusip];
  return c && /^ETP$/i.test(String(c.type || '')) ? 'ETF' : 'Stock';
}

// ── convictionPlays: the consensus quarter, top 5 per action ─────────────────────────────────
const N = C.funds;
function play(c, action) {
  const ids = c.funds || [];
  const investors = ids.map(id => {
    const f = funds[id] || {}, d = (f.diff || []).find(x => x.key === c.key && x.action === action) || null;
    return { name: f.name || id, manager: f.manager || '', type: d ? typeOf(d) : 'Stock',
      sharesChanged: d ? sharesText(d) : '—', tradeValue: d ? tradeText(d) : '—', positionValue: d ? money(d.valueUSD) : '—',
      buyPrice: NO_PRICE, filed: (f.latest && f.latest.filed) || null, quarter: C.quarter };
  });
  const filedBy = ids.map(id => funds[id] && funds[id].latest && funds[id].latest.filed).filter(Boolean).sort().pop()
    || (F.deadlines && F.deadlines[C.quarter]) || 'the deadline';
  // ticker = the 13f.json key: the ticker, or the CUSIP when OpenFIGI has no US line, plus :PUT/:CALL —
  // so a put bought never scores on index.html as the stock bought.
  return { ticker: c.key, name: c.name || c.ticker || c.key, count: c.count, action,
    summary: `${c.count} of ${N} tracked funds ${VERB[action][c.count === 1 ? 0 : 1]}`,
    context: `13F holdings reported to EDGAR for ${C.quarter}, filed by ${filedBy}`,
    investors };
}
const table = {};
ACTIONS.forEach(a => { table[a] = C[a].slice(0, PLAYS).map(c => play(c, a)); });
const CP = isObj(I.convictionPlays) ? I.convictionPlays : {};
const quarters = Array.isArray(CP.quarters) ? CP.quarters.slice() : [];
if (!quarters.includes(C.quarter)) { quarters.push(C.quarter); quarters.sort(); }
const NOTE = `Computed by code from ${N} tracked funds' 13F filings on EDGAR. Earlier quarters are the research agent's broader counts and are not comparable.`;
const byQuarter = { ...(isObj(CP.byQuarter) ? CP.byQuarter : {}), [C.quarter]: table };

// ── notableTrades: the 12 largest ESTIMATED trades (shares × quarter-end price) across the counted funds
const counted = (C.fundIds || Object.keys(funds)).filter(id => funds[id] && funds[id].latest && funds[id].latest.period === C.period);
const trades = counted.flatMap(id => (funds[id].diff || []).filter(d => Number.isFinite(d.valueChgUSD)).map(d => ({ id, d })))
  .sort((a, b) => Math.abs(tradeSize(b.d)) - Math.abs(tradeSize(a.d)) || a.id.localeCompare(b.id) || String(a.d.key).localeCompare(String(b.d.key)))
  .slice(0, TRADES)
  .map(({ id, d }) => { const f = funds[id]; return { fund: f.name || id, manager: f.manager || '', ticker: d.key, name: d.name || d.ticker || d.key,
    action: d.action, shares: sharesText(d), price: NO_PRICE, tradeValue: tradeText(d), filed: f.latest.filed || null, source: f.latest.url || null }; });

// ── superInvestors: every existing name kept; tracked funds not already on it appended ────────
// Names differ between the agent's roster and funds.json ("Pershing Square Capital Management" vs
// "Pershing Square"), so a fund is "on it" when every significant word of the shorter name appears
// in the longer one.
const STOP = new Set(['the', 'and', 'co', 'company', 'inc', 'llc', 'lp', 'ltd', 'management', 'capital', 'associates', 'group',
  'fund', 'funds', 'trust', 'foundation', 'partners', 'investors', 'investments', 'advisors', 'advisers', 'asset', 'family', 'office', 'holdings']);
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !STOP.has(w));
function sameFund(a, b) {
  const x = words(a), y = words(b); if (!x.length || !y.length) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.every(w => l.includes(w));
}
const SI = isObj(I.superInvestors) ? I.superInvestors : {};
const roster = Array.isArray(SI.roster) ? SI.roster.slice() : [], added = [];
for (const [id, f] of Object.entries(funds)) {
  const nm = f.name || id;
  if (!roster.some(r => r && sameFund(r.name, nm))) { roster.push({ name: nm, manager: f.manager || '' }); added.push(nm); }
}

// ── apply ────────────────────────────────────────────────────────────────────────────────────
const NEW = {
  updated: sgtDate(checkedMs),
  convictionPlays: { ...CP, note: NOTE, current: C.quarter, quarters, byQuarter },
  notableTrades: trades,
  superInvestors: { ...SI, count: roster.length, roster },
};
let out, members;
try { ({ out, members } = splice(text, NEW)); } catch (e) { refuse(`could not locate the top-level keys (${String(e.message || e).slice(0, 80)})`); }
// Re-read what would be written: it must parse, the owned keys must hold exactly the new values, and
// every other top-level member must be the same bytes as before.
try {
  const after = JSON.parse(out), again = topLevel(out).members;
  for (const k of OWNED) if (JSON.stringify(after[k]) !== JSON.stringify(NEW[k])) throw new Error(`${k} did not land`);
  for (const m of members) {
    if (OWNED.includes(m.key)) continue;
    const n = again.find(x => x.key === m.key);
    if (!n || out.slice(n.keyStart, n.valEnd) !== text.slice(m.keyStart, m.valEnd)) throw new Error(`"${m.key}" would change`);
  }
  if (again.length !== new Set([...members.map(m => m.key), ...OWNED]).size) throw new Error('top-level key count moved');
} catch (e) { refuse(`splice self-check failed: ${String(e.message || e).slice(0, 100)}`); }

const js = v => JSON.stringify(v);
const changes = [];
if (js(I.updated) !== js(NEW.updated)) changes.push(`updated ${I.updated ?? '(absent)'} → ${NEW.updated}`);
if (js(CP.current) !== js(C.quarter)) changes.push(`convictionPlays.current ${CP.current ?? '(absent)'} → ${C.quarter}`);
if (js(CP.quarters) !== js(quarters)) changes.push(`convictionPlays.quarters + ${C.quarter}`);
if (js(CP.note) !== js(NOTE)) changes.push('convictionPlays.note');
const oldQ = isObj(CP.byQuarter) ? CP.byQuarter[C.quarter] : null;
if (js(oldQ) !== js(table)) changes.push(`convictionPlays.byQuarter["${C.quarter}"] (${oldQ ? ACTIONS.map(a => (Array.isArray(oldQ[a]) ? oldQ[a].length : 0)).join('/') : 'absent'} → ${ACTIONS.map(a => table[a].length).join('/')} plays)`);
if (js(I.notableTrades) !== js(trades)) changes.push(`notableTrades (${Array.isArray(I.notableTrades) ? I.notableTrades.length : 'absent'} → ${trades.length})`);
if (js(SI.roster) !== js(roster) || js(SI.count) !== js(roster.length)) changes.push(`superInvestors roster ${Array.isArray(SI.roster) ? SI.roster.length : 'absent'} → ${roster.length}${added.length ? ` (+ ${added.join(', ')})` : ''}, count ${SI.count ?? '(absent)'} → ${roster.length}`);
const kept = members.map(m => m.key).filter(k => !OWNED.includes(k));
const head = `${C.quarter} from ${N} tracked funds · EDGAR checked ${sgtDate(checkedMs)}`;

if (DRY) {
  console.log(`investors-compat --dry-run: ${head}`);
  if (out === text) console.log('  no change — the file already carries these values');
  else changes.forEach(c => console.log(`  would change: ${c}`));
  console.log(`  untouched byte-for-byte: ${kept.join(', ') || '(no other keys)'}`);
  process.exit(0);
}
if (out === text) { console.log(`investors-compat: no change — ${head}`); process.exit(0); }
const tmp = D(`.investors.json.tmp-${process.pid}`);
try { fs.writeFileSync(tmp, out); fs.renameSync(tmp, D('investors.json')); }
catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} refuse(`write failed (${String(e.message || e).slice(0, 80)})`); }
console.log(`investors-compat: ${head} · changed ${changes.length} · untouched byte-for-byte: ${kept.join(', ') || '(no other keys)'}`);
changes.forEach(c => console.log(`  ${c}`));
