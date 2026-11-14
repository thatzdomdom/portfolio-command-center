/*
 * funds.js — the Funds (13F) section of book.html and the 13F lines in every holding's drawer.
 * Phase 6 of the 11 Sep 2026 redesign, section D. Same-origin, loaded by book.html after common.js;
 * it exposes window.FUNDS = { render, forPosition } and fetches nothing — book.html hands it
 * data/13f.json with the other public files.
 *
 * Why it exists: until phase 6 the 13F tables reached the owner through investors.json, rewritten by
 * the research LLM every morning under a rule that bumped its stamp daily. On 18 Aug that put a fresh
 * stamp over a quarter-old table. The numbers now come from EDGAR, parsed by scripts/13f-scan.js, and
 * this file only draws them. Every fund line wears the three dates that matter and no others: the
 * quarter the table describes, the day it was filed, and the day code last checked EDGAR. A render
 * time is never one of them.
 *
 * Choices that look odd and are not:
 *  - Book hits come FIRST. Twelve funds' diffs run to thousands of rows (Bridgewater alone ~1,200);
 *    the rows that bear on this book are GDX/SILJ/SLVP/VNM and the watchlist. When no tracked fund
 *    reports the book's US lines — true on 13 Sep 2026 — the section says so in a sentence instead of
 *    leaving the owner to infer it from an empty table.
 *  - Collapsed by default, and a fund's diff table is built the first time it is opened. 13F is
 *    quarterly and 45 days late by law: context for a drawer, never the headline of the page.
 *  - The drawer keeps "no tracked fund holds this" apart from "13F cannot see this". An SGX REIT is in
 *    no 13F by construction; "no fund holds D05" would read as a finding when it is a blind spot.
 *  - Stamps turn amber when a fund is behind the newest quarter whose ROLLED deadline has passed, or
 *    has stopped filing (their lateness, not ours), and red when the scan itself is more than 3 days
 *    old — validate-all's "13F feed is DEAD, not quiet" threshold, so the page and the check agree.
 *  - Every value is already US dollars. The scanner multiplied the thousands filers (Duquesne,
 *    Baupost) by 1,000; "units reported in thousands" is provenance, not a conversion done here.
 *  - A value change mixes trading with price moves, and the tables say so once rather than letting a
 *    rally in a held name read as buying.
 *
 * All data reaches the DOM through PCC.el's `text`; no markup string is assigned anywhere. The only URLs are the
 * filings' own www.sec.gov index pages, linked, and only when they are exactly that. The pure half
 * (listing, coverage, fundState, hits) needs no DOM so node can run it against the real file.
 */
(function (g) {
  'use strict';
  var P = g.PCC || {};

  var SEC_URL = /^https:\/\/www\.sec\.gov\//;
  var ACTIONS = ['New', 'Added', 'Reduced', 'Exited'];
  var FIRST_ROWS = 40;          // a fund's diff table shows this many rows until asked for all
  var DEAD_AFTER_DAYS = 3;      // validate-all FAILs "13F feed is DEAD, not quiet" past this age
  // Yahoo exchange suffixes, named for the drawer sentence. Yahoo writes share classes with a hyphen
  // (BRK-B), so a dot in a Yahoo symbol is always an exchange, never a class.
  var ABROAD = { SI: 'Singapore (SGX)', HK: 'Hong Kong (HKEX)', AX: 'Australia (ASX)', KS: 'Korea (KRX)',
    KQ: 'Korea (KOSDAQ)', T: 'Tokyo (TSE)', L: 'London (LSE)', TO: 'Toronto (TSX)', V: 'Toronto (TSX-V)' };

  // ── pure: dates, quarters, deadlines ──────────────────────────────────────
  function sgtDate(iso) {
    if (!iso) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso);
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  }
  function today() { return P.sgtToday ? P.sgtToday() : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); }
  function daysBetween(a, b) {
    var x = Date.parse(a), y = Date.parse(b);
    return isNaN(x) || isNaN(y) ? null : Math.round((y - x) / 864e5);
  }
  function quarterOf(iso) {
    var m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
    return m ? m[1] + ' Q' + Math.ceil(+m[2] / 3) : null;
  }
  function qShort(q) {
    var m = /^(\d{4}) Q([1-4])$/.exec(String(q || ''));
    return m ? 'Q' + m[2] + '\'' + m[1].slice(2) : String(q || '—');
  }
  // 13f.json's deadlines are already rolled to a weekday. A fund filing ON the deadline is on time,
  // so a deadline has "passed" only from the day after.
  function deadlines(F, day) {
    var out = { passed: null, next: null }, map = (F && F.deadlines) || {};
    Object.keys(map).forEach(function (q) {
      var d = map[q];
      if (d < day) { if (!out.passed || d > out.passed.date) out.passed = { quarter: q, date: d }; }
      else if (!out.next || d < out.next.date) out.next = { quarter: q, date: d };
    });
    return out;
  }
  function scanState(F, day) {
    var s = (F && F.scan) || {}, checked = sgtDate(s.checkedAt);
    var age = checked ? daysBetween(checked, day) : null;
    return { checked: checked, age: age, dead: age == null || age > DEAD_AFTER_DAYS, ok: s.ok !== false, errors: s.errors || [] };
  }
  function isStopped(f) { return !!f && (f.status === 'stopped' || f.inferredStatus === 'stopped' || (f.status && f.status !== 'active')); }

  // ── pure: one fund's line ─────────────────────────────────────────────────
  function fundState(f, F, day) {
    var L = (f && f.latest) || null, counts = { New: 0, Added: 0, Reduced: 0, Exited: 0 };
    ((f && f.diff) || []).forEach(function (d) { if (counts[d.action] != null) counts[d.action]++; });
    var dl = deadlines(F, day), sc = scanState(F, day), flags = [], state = 'fresh';
    var worse = function (s) { if (s === 'stale' || (s === 'aging' && state === 'fresh')) state = s; };
    var stopped = isStopped(f);
    if (stopped) {
      flags.push({ cls: 'warn', text: f.status === 'stopped' || f.inferredStatus === 'stopped'
        ? 'stopped after ' + (quarterOf(f.stoppedAfter || (L && L.period)) || 'its last filing') : 'status: ' + f.status });
      worse('aging');
    }
    if (L && L.via === 'notice') flags.push({ cls: 'flat', text: 'via notice (CIK ' + ((L.reporter && L.reporter.cik) || L.cik) + ')' });
    if (L && L.units === 'thousands') flags.push({ cls: 'flat', text: 'units reported in thousands' });
    if (L && L.reconciled === false) { flags.push({ cls: 'bad', text: 'does not reconcile to its cover page' }); worse('stale'); }
    if (L && L.confidentialOmitted) flags.push({ cls: 'flat', text: 'confidential positions omitted' });
    if (f && f.proposedCik) flags.push({ cls: 'warn', text: 'EDGAR names CIK ' + f.proposedCik.cik + ' (' + f.proposedCik.name + ') — not yet in funds.json' });
    if (!stopped && f && f.edgarLatestPeriod && (!L || f.edgarLatestPeriod > L.period)) {
      flags.push({ cls: 'bad', text: 'EDGAR shows ' + quarterOf(f.edgarLatestPeriod) + ' — not ingested yet' });
      worse('stale');
    } else if (!stopped && dl.passed && (!L || L.quarter < dl.passed.quarter)) {
      flags.push({ cls: 'warn', text: 'has not filed ' + dl.passed.quarter + ' (due ' + fmtShort(dl.passed.date) + ') — their lateness, not ours' });
      worse('aging');
    }
    if (L && L.tickers && L.tickers.mapped < L.tickers.total) flags.push({ cls: 'flat', text: L.tickers.mapped + ' of ' + L.tickers.total + ' CUSIPs mapped to a ticker' });
    if (sc.dead) worse('stale');
    var stamp = L
      ? '13F ' + qShort(L.quarter) + ' · filed ' + fmtShort(L.filed) + ' · checked ' + fmtShort(sc.checked)
      : 'no 13F on file · checked ' + fmtShort(sc.checked);
    if (sc.dead) stamp += ' — feed DEAD, not quiet';
    return { counts: counts, flags: flags, state: state, stamp: stamp, stopped: stopped };
  }

  // ── pure: can 13F see this holding, and who reports it ────────────────────
  function listing(row) {
    row = row || {};
    var sym = String(row.yf || '').trim().toUpperCase(), name = row.t || sym;
    if (!sym) return row.manual
      ? { us: false, why: (name ? name + ' is' : 'this is') + ' a manual line with no exchange listing on file' }
      : { us: false, unknown: true, why: 'no exchange symbol loaded for ' + (name || 'this line') + ', so its 13F coverage could not be checked' };
    if (/[=^]/.test(sym) || /-USD$/.test(sym)) return { us: false, why: name + ' is priced from ' + sym + ', a futures, index or crypto series rather than a listed security' };
    var ex = /\.([A-Z]{1,3})$/.exec(sym);
    if (ex) return { us: false, why: name + ' is listed in ' + (ABROAD[ex[1]] || 'a non-US market (' + ex[1] + ')') };
    if (/^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(sym)) return { us: true, ticker: sym.replace('-', '.') };
    return { us: false, why: sym + ' does not look like a US listing' };
  }
  function coverage(row, F) {
    var L = listing(row), out = { listing: L, ticker: L.ticker || null, lines: [], funds: 0, quarters: {} };
    if (!F || !F.funds) return out;
    Object.keys(F.funds).forEach(function (id) {
      var f = F.funds[id], lat = f.latest || {};
      out.funds++;
      var qk = isStopped(f) ? 'stopped' : (lat.quarter || 'none');
      out.quarters[qk] = (out.quarters[qk] || 0) + 1;
      if (!L.us) return;
      var byKey = {};
      (lat.holdings || []).forEach(function (h) { if (h.ticker === L.ticker) byKey[h.key] = { hold: h }; });
      (f.diff || []).forEach(function (d) { if (d.ticker === L.ticker) (byKey[d.key] = byKey[d.key] || {}).diff = d; });
      Object.keys(byKey).forEach(function (k) {
        var x = byKey[k], base = x.hold || x.diff;
        out.lines.push({ fund: id, name: f.name || id, stopped: isStopped(f), stoppedAfter: f.stoppedAfter || null,
          quarter: lat.quarter, filed: lat.filed, url: lat.url, key: k, type: base.type, putCall: base.putCall || null,
          hold: x.hold || null, diff: x.diff || null });
      });
    });
    var size = function (l) { return Math.abs(l.diff ? l.diff.valueChgUSD || 0 : 0) || (l.hold ? l.hold.valueUSD || 0 : 0); };
    out.lines.sort(function (a, b) { return (a.stopped - b.stopped) || (size(b) - size(a)); });
    return out;
  }
  function bookTickers(rows) {
    var seen = {}, out = [];
    (rows || []).forEach(function (r) { var L = listing(r); if (L.us && !seen[L.ticker]) { seen[L.ticker] = 1; out.push(L.ticker); } });
    return out;
  }
  // Book hits first. 13f.json tags in-book from the scanner's own copy of the book; the page's rows
  // are what the owner is looking at, so either source makes a hit in-book. A book name a fund holds
  // UNCHANGED produces no diff row and no bookHit, so it is found from the holdings instead.
  function hits(F, rows) {
    var mine = bookTickers(rows), set = {}, out = { tickers: mine, inBook: [], watch: [], unchanged: [], quiet: [] };
    mine.forEach(function (t) { set[t] = 1; });
    ((F && F.bookHits) || []).forEach(function (h) { (set[h.ticker] || h.tag === 'in-book' ? out.inBook : out.watch).push(h); });
    mine.forEach(function (t) {
      var moved = out.inBook.some(function (h) { return h.ticker === t; });
      var held = coverage({ t: t, yf: t.replace('.', '-') }, F).lines.filter(function (l) { return l.hold && !l.diff && !l.stopped; });
      out.unchanged = out.unchanged.concat(held);
      if (!moved && !held.length) out.quiet.push(t);
    });
    return out;
  }

  // ── DOM helpers (PCC.el only) ─────────────────────────────────────────────
  function fmtShort(iso) { return iso ? (P.dateShort ? P.dateShort(iso) : String(iso)) : '—'; }
  function usd(v) { return P.money(v, { cur: 'USD', compact: true }); }
  function usdChg(v) { return (v > 0 ? '+' : '') + usd(v); }
  function signed(v) { return v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + P.num(v, 0); }
  function orList(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1]; }
  function stampSpan(text, state) {
    return P.el('span', { class: 'stamp' + (state === 'stale' ? ' stale' : state === 'aging' ? ' aging' : ''), text: text });
  }
  function secLink(url, label) {
    return url && SEC_URL.test(String(url)) ? P.el('a', { href: url, target: '_blank', rel: 'noopener', text: label || 'filing' }) : null;
  }
  function kindLabel(x) { return x.type === 'PRN' ? 'note (PRN)' : x.putCall ? String(x.putCall).toUpperCase() + ' option' : 'shares'; }
  function unit(x) { return x.type === 'PRN' ? ' principal' : ' sh'; }
  function actCls(a) { return a === 'New' || a === 'Added' ? 'up' : a === 'Reduced' || a === 'Exited' ? 'down' : ''; }
  function td(text, cls) { return P.el('td', { class: cls || null, text: text }); }
  function holdingCell(x) {
    var E = P.el;
    return E('td', { class: 'l' }, [E('b', { text: x.ticker || x.cusip || x.key || '—' }),
      E('span', { class: 'muted', text: ' ' + (x.name || '') + (x.ticker ? '' : ' · no ticker on file, CUSIP shown') })]);
  }
  var styled = false;
  function injectStyle() {
    if (styled || !g.document || !g.document.head) return;
    styled = true;
    g.document.head.appendChild(P.el('style', { text:
      '.funds>summary{cursor:pointer;line-height:1.8}.funds h3{margin:16px 0 6px}'
      + '.funds .fl{border-bottom:1px solid var(--rule-2);padding:6px 0}.funds .fl>summary{cursor:pointer;font-size:13px;line-height:1.8}'
      + '.funds .pill{margin-left:6px}.funds table{font-size:12.5px;margin:6px 0 10px}.funds td{vertical-align:top}'
      + '.funds td.l,.funds th.l{text-align:left}.funds th .dir{color:var(--accent)}'
      + '.funds .why{color:var(--muted);font-size:12px;line-height:1.6;margin:4px 0 8px}' }));
  }

  // ── DOM: tables ───────────────────────────────────────────────────────────
  function hitRow(h, F) {
    var E = P.el, tr = E('tr', {}), f = (F.funds || {})[h.fund] || {}, st = fundState(f, F, today());
    // bookHits' `name` is the FUND's name; the security's name lives on the fund's diff/holding row.
    var sec = (f.diff || []).filter(function (d) { return d.key === h.key; })[0]
      || ((f.latest || {}).holdings || []).filter(function (x) { return x.key === h.key; })[0] || {};
    tr.appendChild(holdingCell({ ticker: h.ticker, key: h.key, cusip: sec.cusip, name: sec.name || '' }));
    tr.appendChild(td(f.name || h.name || h.fund, 'l'));
    tr.appendChild(E('td', { class: 'l' }, [E('span', { class: actCls(h.action), text: h.action + (h.putCall ? ' (' + String(h.putCall).toUpperCase() + ' option)' : '') })]));
    tr.appendChild(td(signed(h.sharesChg) + (h.pctChg == null ? '' : ' (' + P.pct(h.pctChg, { dp: 1, sign: true }) + ')'), 'num'));
    tr.appendChild(td(usdChg(h.valueChgUSD), 'num'));
    tr.appendChild(td(h.action === 'Exited' ? '—' : usd(h.valueUSD), 'num'));
    var last = E('td', { class: 'l' }, [stampSpan(st.stamp, st.state)]);
    var a = secLink(h.url);
    if (a) { last.appendChild(E('span', { text: ' · ' })); last.appendChild(a); }
    tr.appendChild(last);
    return tr;
  }
  function hitTable(list, F, extra) {
    var E = P.el, tb = E('tbody', {});
    list.forEach(function (h) { tb.appendChild(hitRow(h, F)); });
    (extra || []).forEach(function (l) { tb.appendChild(hitRow({ fund: l.fund, name: l.name, ticker: l.hold.ticker, key: l.key,
      action: 'held, unchanged', putCall: l.putCall, sharesChg: 0, pctChg: 0, valueUSD: l.hold.valueUSD, valueChgUSD: 0, url: l.url }, F)); });
    var head = E('tr', {});
    [['Holding', 'l'], ['Fund', 'l'], ['Action', 'l'], ['Shares change'], ['Value change'], ['Position now'], ['As of', 'l']]
      .forEach(function (c) { head.appendChild(E('th', { class: c[1] || null, text: c[0] })); });
    return E('div', { class: 'scroll' }, [E('table', {}, [E('thead', {}, [head]), tb])]);
  }

  function diffTable(f) {
    var E = P.el, box = E('div', {}), st = { by: 'chg', dir: -1, all: false }, rows = (f.diff || []).slice();
    var mag = function (r) { return Math.abs((st.by === 'val' ? r.valueUSD : r.valueChgUSD) || 0); };
    function draw() {
      box.textContent = '';
      if (!rows.length) { box.appendChild(E('p', { class: 'why', text: 'No position changed between the two stored quarters.' })); return; }
      var sorted = rows.slice().sort(function (a, b) { return (mag(a) - mag(b)) * st.dir; });
      var shown = st.all ? sorted : sorted.slice(0, FIRST_ROWS), head = E('tr', {});
      [['Action', null, 'l'], ['Holding', null, 'l'], ['Kind', null, 'l'], ['Before → after'], ['Change'],
        ['|Value change|', 'chg'], ['|Position now|', 'val'], ['% of fund']].forEach(function (c) {
        var th = E('th', { class: c[2] || null, text: c[0] });
        if (c[1]) {
          th.tabIndex = 0;
          th.setAttribute('aria-sort', st.by === c[1] ? (st.dir < 0 ? 'descending' : 'ascending') : 'none');
          if (st.by === c[1]) th.appendChild(E('span', { class: 'dir', text: st.dir < 0 ? ' ▾' : ' ▴' }));
          var go = function () { if (st.by === c[1]) st.dir = -st.dir; else { st.by = c[1]; st.dir = -1; } draw(); };
          th.addEventListener('click', go);
          th.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
        }
        head.appendChild(th);
      });
      var tb = E('tbody', {});
      shown.forEach(function (r) {
        var tr = E('tr', {});
        tr.appendChild(E('td', { class: 'l' }, [E('span', { class: actCls(r.action), text: r.action })]));
        tr.appendChild(holdingCell(r));
        tr.appendChild(E('td', { class: 'l' }, [E('span', { class: 'pill ' + (r.type === 'PRN' || r.putCall ? 'warn' : 'flat'), text: kindLabel(r) })]));
        tr.appendChild(td(P.num(r.sharesPrior, 0) + ' → ' + P.num(r.sharesLatest, 0), 'num'));
        tr.appendChild(td(r.action === 'New' ? 'new' : r.pctChg == null ? '—' : P.pct(r.pctChg, { dp: 1, sign: true }), 'num'));
        tr.appendChild(td(usdChg(r.valueChgUSD), 'num'));
        tr.appendChild(td(r.action === 'Exited' ? '—' : usd(r.valueUSD), 'num'));
        tr.appendChild(td(r.pctOfPortfolio == null ? '—' : P.pct(r.pctOfPortfolio, { dp: 2, sign: false }), 'num'));
        tb.appendChild(tr);
      });
      box.appendChild(E('div', { class: 'scroll' }, [E('table', {}, [E('thead', {}, [head]), tb])]));
      if (rows.length > FIRST_ROWS) {
        box.appendChild(E('button', { type: 'button', class: 'chip', text: st.all ? 'show the largest ' + FIRST_ROWS : 'show all ' + rows.length + ' changes',
          onclick: function () { st.all = !st.all; draw(); } }));
      }
    }
    draw();
    return box;
  }

  function fundBody(id, f) {
    var E = P.el, L = f.latest || {}, R = f.prior || null, box = E('div', {});
    var p = E('p', { class: 'why' });
    p.appendChild(E('span', { text: (f.manager ? f.manager + ' · ' : '') + (f.kind || '') + ' · ' + (L.quarter || '—') + ' table filed '
      + (P.dateLong ? P.dateLong(L.filed) : L.filed) + ' by CIK ' + (L.cik || '—')
      + ((L.amendments || []).length ? ' · ' + L.amendments.length + ' amendment(s) applied' : '')
      + (R ? ' · compared with ' + R.quarter + ' (filed ' + fmtShort(R.filed) + ': ' + R.positions + ' positions, ' + usd(R.valueUSD) + ')' : ' · no prior quarter stored') + ' · ' }));
    var a = secLink(L.url, 'the filing on EDGAR');
    if (a) p.appendChild(a);
    box.appendChild(p);
    box.appendChild(diffTable(f));
    return box;
  }

  function fundLine(id, f, F, day) {
    var E = P.el, L = f.latest || {}, s = fundState(f, F, day), c = s.counts;
    var det = E('details', { class: 'fl' }), sum = E('summary', {});
    sum.appendChild(E('b', { text: f.name || id }));
    sum.appendChild(E('span', { class: 'num', text: ' · ' + (L.quarter || 'no filing') + ' · ' + (L.positions == null ? '—' : L.positions) + ' positions · '
      + usd(L.valueUSD) + ' · ' + c.New + ' new · ' + c.Added + ' added · ' + c.Reduced + ' reduced · ' + c.Exited + ' exited' }));
    sum.appendChild(E('br'));
    sum.appendChild(stampSpan(s.stamp, s.state));
    s.flags.forEach(function (fl) { sum.appendChild(E('span', { class: 'pill ' + fl.cls, text: fl.text })); });
    det.appendChild(sum);
    var built = false;
    det.addEventListener('toggle', function () { if (det.open && !built) { built = true; det.appendChild(fundBody(id, f)); } });
    return det;
  }

  function consensusBlock(F) {
    var E = P.el, C = F.consensus, box = E('div', {});
    if (!C || !C.period) {
      box.appendChild(P.err('No consensus in 13f.json: fewer than half the active tracked funds have filed the newest quarter yet.'));
      return box;
    }
    box.appendChild(E('p', { class: 'why', text: 'Counted over the ' + C.funds + ' tracked funds whose latest table is ' + C.quarter
      + ' (of ' + C.activeTracked + ' active; quant and index filers are excluded — turnover is not conviction). Top 10 per action. '
      + 'The value column is the net change in reported value across those funds, which mixes trading with price moves.' }));
    var head = E('tr', {}), tb = E('tbody', {});
    [['Holding', 'l'], ['Funds'], ['Which', 'l'], ['Σ value change']].forEach(function (c) { head.appendChild(E('th', { class: c[1] || null, text: c[0] })); });
    ACTIONS.forEach(function (act) {
      var list = C[act] || [];
      var g1 = E('td', { class: 'l', text: act + ' · ' + list.length + (list.length === 1 ? ' name' : ' names') });
      g1.colSpan = 4;
      tb.appendChild(E('tr', { class: 'grp' }, [g1]));
      list.forEach(function (r) {
        tb.appendChild(E('tr', {}, [holdingCell({ ticker: r.ticker, key: r.key, name: r.name + (r.putCall ? ' (' + r.putCall + ' option)' : '') }),
          td(r.count + ' of ' + C.funds, 'num'), td((r.names || r.funds || []).join(', '), 'l'), td(usdChg(r.valueUSD), 'num')]));
      });
    });
    box.appendChild(E('div', { class: 'scroll' }, [E('table', {}, [E('thead', {}, [head]), tb])]));
    return box;
  }

  // ── public: the section ───────────────────────────────────────────────────
  function render(container, F, rows) {
    P = g.PCC || P;
    if (!container || !P.el) return;
    var E = P.el;
    container.textContent = '';
    if (!F || !F.funds) {
      container.appendChild(P.err('13f.json did not load, so the Funds (13F) section is missing — not empty. It is written by scripts/13f-scan.js on GitHub Actions each morning.'));
      return;
    }
    injectStyle();
    var day = today(), sc = scanState(F, day), dl = deadlines(F, day), ids = Object.keys(F.funds), H = hits(F, rows);
    var newest = ids.map(function (id) { return (F.funds[id].latest || {}).quarter || ''; }).sort().pop() || null;
    var current = ids.filter(function (id) { return !isStopped(F.funds[id]) && (F.funds[id].latest || {}).quarter === newest; }).length;

    var det = E('details', { class: 'card funds' }), sum = E('summary', {});
    sum.appendChild(E('b', { text: 'Funds (13F)' }));
    sum.appendChild(E('span', { text: ' · ' + ids.length + ' tracked · ' + current + ' current through ' + (newest || '—') + ' · '
      + H.inBook.length + ' move' + (H.inBook.length === 1 ? '' : 's') + ' in your book · ' + H.watch.length + ' on the watchlist   ' }));
    sum.appendChild(stampSpan('checked ' + fmtShort(sc.checked) + (sc.dead ? ' — feed DEAD, not quiet' : ''), sc.dead ? 'stale' : 'fresh'));
    det.appendChild(sum);

    det.appendChild(E('p', { class: 'why', text: 'What the tracked funds reported to EDGAR, parsed by code from each 13F filing. '
      + '13F is quarterly, filed up to 45 days after the quarter ends, and covers US-listed securities only — context, never a trade signal. '
      + (dl.next ? 'Next deadline: ' + dl.next.quarter + ', ' + (P.dateLong ? P.dateLong(dl.next.date) : dl.next.date) + '.' : '') }));
    if (sc.dead) det.appendChild(P.err('The 13F scan last checked EDGAR on ' + (sc.checked || 'an unknown date') + ' — more than ' + DEAD_AFTER_DAYS + ' days ago. Nothing below is known to be current.'));
    if (!sc.ok || sc.errors.length) {
      sc.errors.slice(0, 6).forEach(function (e) { det.appendChild(P.err('Last scan: ' + (e.fund || '?') + ' failed at ' + (e.stage || '?') + ' — ' + (e.message || '') + '. Its previous table is kept.')); });
    }

    det.appendChild(E('h3', { text: 'Your names first' }));
    if (H.inBook.length || H.unchanged.length) det.appendChild(hitTable(H.inBook, F, H.unchanged));
    if (H.quiet.length) {
      det.appendChild(E('p', { class: 'why', text: 'No tracked fund reports ' + orList(H.quiet) + ' in its latest 13F, and none exited '
        + (H.quiet.length === 1 ? 'it' : 'them') + ' last quarter. That is a fact about ' + current + ' funds\' ' + (newest || '') + ' tables, not about the holdings.' }));
    } else if (!H.tickers.length) {
      // With no rows loaded (a file failed, or locked with targets.json missing) nothing was matched —
      // a different fact from a book that has no US listing, and it must not read as one.
      det.appendChild(E('p', { class: 'why', text: (!rows || !rows.length)
        ? 'No holdings rows loaded on this page, so book hits could not be matched. The fund tables below are unaffected.'
        : 'The book on this page has no US-listed line, so no 13F can report one.' }));
    }
    if (H.watch.length) {
      det.appendChild(E('p', { class: 'why', text: 'Watchlist names a tracked fund moved (active funds only):' }));
      det.appendChild(hitTable(H.watch, F));
    }

    det.appendChild(E('h3', { text: 'Tracked funds' }));
    ids.forEach(function (id) { det.appendChild(fundLine(id, F.funds[id], F, day)); });
    det.appendChild(E('p', { class: 'why', text: 'Open a fund for its quarter-on-quarter changes, largest first; the two value headings re-sort by size. '
      + 'Options and notes (PRN) are kept and labelled. A holding whose share count did not change has no row.' }));

    det.appendChild(E('h3', { text: 'Consensus · ' + ((F.consensus && F.consensus.quarter) || '—') }));
    det.appendChild(consensusBlock(F));

    (F.integrity || []).slice(0, 6).forEach(function (x) {
      det.appendChild(P.err('Integrity: ' + (x.ticker || x.cusip) + ' ' + (x.name || '') + ' — funds disagree on price per share ×' + P.num(x.ratio, 1) + ' in ' + x.quarter + '. ' + (x.why || '')));
    });
    var ex = (F.excluded || []).map(function (x) { return x.name + ' (' + x.why + ')'; });
    det.appendChild(E('p', { class: 'why', text: (ex.length ? 'Not tracked by policy: ' + ex.join('; ') + '. ' : '') + (F.source ? 'Source: ' + F.source + '.' : '') }));
    container.appendChild(det);
  }

  // ── public: the drawer lines for one holding ──────────────────────────────
  function forPosition(row, F) {
    P = g.PCC || P;
    var E = P.el, box = E('div', { class: 'funds-pos' }), ul = E('ul', {});
    box.appendChild(E('h3', { text: 'Funds (13F)' }));
    box.appendChild(ul);
    if (!F || !F.funds) {
      ul.appendChild(E('li', { class: 'muted', text: '13f.json did not load, so the tracked funds could not be checked for this line — missing, not empty.' }));
      return box;
    }
    var day = today(), sc = scanState(F, day), cov = coverage(row, F);
    // newest quarter first, stopped filers last — the reader's question is "how current is this"
    var qs = Object.keys(cov.quarters).sort(function (a, b) {
      return ((a === 'stopped') - (b === 'stopped')) || (a < b ? 1 : a > b ? -1 : 0);
    }).map(function (q) {
      return q === 'stopped' ? cov.quarters[q] + ' stopped filing' : cov.quarters[q] + ' through ' + q;
    }).join(', ');
    if (!cov.listing.us) {
      ul.appendChild(E('li', { class: 'muted', text: 'No tracked fund reports this ticker — 13F covers US-listed securities only, and ' + cov.listing.why + '.' }));
    } else if (!cov.lines.length) {
      ul.appendChild(E('li', { class: 'muted', text: 'No tracked fund reports ' + cov.ticker + ' — none of the ' + cov.funds
        + ' tracked funds\' latest 13F tables holds it, and none exited it last quarter (' + qs + ').' }));
    } else {
      cov.lines.forEach(function (l) {
        var h = l.hold, d = l.diff, li = E('li', {}), what;
        var kind = l.putCall ? ' (' + l.putCall + ' option)' : l.type === 'PRN' ? ' (note)' : '';
        if (d && d.action === 'Exited') what = 'exited ' + P.num(d.sharesPrior, 0) + unit(d) + kind + ', was ' + usd(d.valuePriorUSD);
        else if (d && d.action === 'New') what = 'opened ' + P.num(d.sharesLatest, 0) + unit(d) + kind + ' · ' + usd(d.valueUSD);
        else if (d) what = d.action.toLowerCase() + ' ' + P.num(Math.abs(d.sharesChg), 0) + unit(d) + ' (' + P.pct(d.pctChg, { dp: 1, sign: true }) + ') to '
          + P.num(d.sharesLatest, 0) + unit(d) + kind + ' · ' + usd(d.valueUSD);
        else what = 'held ' + P.num(h.shares, 0) + unit(h) + kind + ', unchanged · ' + usd(h.valueUSD);
        if (h && h.pct != null) what += ', ' + P.pct(h.pct, { dp: 2, sign: false }) + ' of the fund';
        li.appendChild(E('b', { text: l.name }));
        li.appendChild(E('span', { class: d ? actCls(d.action) : '', text: ' ' + what }));
        li.appendChild(E('span', { text: ' · ' }));
        li.appendChild(stampSpan('13F ' + qShort(l.quarter) + ' · filed ' + fmtShort(l.filed)
          + (l.stopped ? ' · stopped filing after ' + (quarterOf(l.stoppedAfter) || qShort(l.quarter)) + ' — their last table' : ''), l.stopped ? 'aging' : 'fresh'));
        var a = secLink(l.url);
        if (a) { li.appendChild(E('span', { text: ' · ' })); li.appendChild(a); }
        ul.appendChild(li);
      });
    }
    ul.appendChild(E('li', {}, [stampSpan('13F tables: ' + qs + ' · checked ' + fmtShort(sc.checked) + (sc.dead ? ' — feed DEAD, not quiet' : ''), sc.dead ? 'stale' : 'fresh')]));
    return box;
  }

  var api = { render: render, forPosition: forPosition,
    // pure, for node and for anyone debugging the page
    listing: listing, coverage: coverage, fundState: fundState, hits: hits, deadlines: deadlines, scanState: scanState, qShort: qShort, quarterOf: quarterOf };
  g.FUNDS = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
