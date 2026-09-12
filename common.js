/*
 * common.js — shared by every page of the Portfolio Command Center (phase 1 of the 11 Sep 2026
 * redesign, extended for the phase-5 page split). No framework, no build step, no external calls.
 *
 *   freshness(asOf, cadence)  — grey / amber / stale from the DATA's date against its cadence.
 *                               Never from a render time or a job run time: that is how quarter-old
 *                               13F data once wore a green dot.
 *   loadEncrypted(url)        — fetch a `.enc` envelope and decrypt it with a passphrase the viewer
 *                               types once per device. Files that carry the owner's balances
 *                               (book, valuation) are never published in the clear; see
 *                               scripts/encrypt-publish.js for the matching encryptor.
 *
 * Phase 5 (13 Sep 2026) makes this file the contract the three surfaces are built on — today.html,
 * book.html, inbox.html all render through it. What was added and WHY:
 *
 *  - unlock(): the passphrase used to come from window.prompt(). Safari on iOS suppresses a prompt
 *    that is not inside a user gesture, so the phone page could silently render a locked shell with
 *    no way in, and a prompt cannot say WHERE the passphrase goes. The panel is in-page, explains
 *    that the passphrase is asked once per device and stored only in this browser, and carries a
 *    visible "forget on this device" control — the escape hatch has to be in the same place as the
 *    thing it undoes. loadEncrypted keeps its signature and its wrong-passphrase retry.
 *  - el(): the ONE way data reaches the DOM. Every value here comes from EDGAR headlines or from an
 *    LLM, so `text` goes through textContent and there is no innerHTML path for data anywhere.
 *  - spark()/chart(): the charts are hand-drawn inline SVG because a chart library is an external
 *    call. They return strings, which is safe only because they contain no data-derived TEXT — the
 *    only characters drawn are digits this file formatted itself.
 *  - load/loadAll/priv/locked: one fetch path, cache-busted, null on any failure. A page that gets
 *    null prints one honest line (err()); it never renders a zero in place of a number it lacks.
 *
 * index.html does not use this file — the parallel week runs the old computation beside the new one.
 */
(function (g) {
  'use strict';

  // ── freshness ────────────────────────────────────────────────────────────
  // cadence → [amber after N days, stale after N days]
  const CADENCE = { daily: [1, 2], 'daily-verify': [1, 3], weekly: [8, 12], quarterly: [100, 140], manual: [90, 180] };
  // Market files are stamped with the last COMPLETED session, so on a Sunday a perfectly healthy
  // fx.json reads 2 days old and a calendar-day rule paints the whole pipeline red. These cadences
  // age in WEEKDAYS instead. (A public holiday still over-counts by a day; that is why the amber
  // step exists.) Everything else — manual marks, quarterly filings — ages in calendar days.
  const WEEKDAY_CADENCE = { daily: 1, 'daily-verify': 1 };
  function sgtToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); }
  function ageDays(asOf) {
    const t = Date.parse(String(asOf || '').slice(0, 10)); if (isNaN(t)) return null;
    return Math.floor((Date.parse(sgtToday()) - t) / 864e5);
  }
  // weekdays elapsed between two YYYY-MM-DD dates, counting neither endpoint's weekend
  function weekdaysBetween(fromISO, toISO) {
    let a = Date.parse(fromISO), b = Date.parse(toISO); if (isNaN(a) || isNaN(b) || b < a) return null;
    let n = 0; for (let t = a + 864e5; t <= b; t += 864e5) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  function freshness(asOf, cadence) {
    const cal = ageDays(asOf);
    const age = WEEKDAY_CADENCE[cadence] && cal != null
      ? weekdaysBetween(String(asOf).slice(0, 10), sgtToday())
      : cal;
    const [amber, stale] = CADENCE[cadence] || CADENCE.daily;
    if (age == null) return { state: 'unknown', ageDays: null, days: null, label: 'no date' };
    const state = age >= stale ? 'stale' : age >= amber ? 'amber' : 'fresh';
    const label = cal <= 0 ? 'today' : cal === 1 ? 'yesterday' : cal + 'd old';
    // `days` is the phase-5 spec's name for it; `ageDays` is what index-era callers read. Both.
    // The label always quotes CALENDAR days (that is what a reader counts); only the state uses the
    // weekday age, so a Sunday reads "2d old" in grey rather than "STALE 2d" in red.
    return { state, ageDays: cal, days: cal, weekdays: age, label: state === 'stale' ? 'STALE ' + cal + 'd' : label };
  }
  // A stamp is WORDS, never colour alone — Mail on iPhone strips styles, and colour-only state is
  // invisible to anyone who cannot see it.
  // Both interpolations are DATA (a file's asOf, a caller's label) and the pages assign the result
  // with innerHTML, so both are escaped here. stampEl() is the safe path and stampHTML wraps it;
  // new code should call stampEl. The tokens are --bad / --warn: --red and --amber do not exist in
  // pcc.css, and their hardcoded fallbacks failed contrast on a dark phone.
  const escHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function stampText(asOf, cadence, what) {
    const f = freshness(asOf, cadence);
    return { text: (what ? what + ' · ' : '') + 'as of ' + String(asOf || '—').slice(0, 10) + ' · ' + f.label, state: f.state };
  }
  function stampEl(asOf, cadence, what) {
    const t = stampText(asOf, cadence, what);
    return el('span', { class: 'stamp' + (t.state === 'stale' ? ' stale' : t.state === 'amber' ? ' aging' : ''), text: t.text });
  }
  function stampHTML(asOf, cadence, what) {
    const t = stampText(asOf, cadence, what);
    const col = t.state === 'stale' ? 'var(--bad,#a32a24)' : t.state === 'amber' ? 'var(--warn,#8a5a0b)' : 'var(--muted,#77808d)';
    return '<span class="stamp" style="color:' + col + ';font-size:11px;font-variant-numeric:tabular-nums">' + escHTML(t.text) + '</span>';
  }

  // ── encryption (matches scripts/encrypt-publish.js) ──────────────────────
  // Envelope: { v:1, kdf:"PBKDF2-SHA256", iter:150000, salt:b64, iv:b64, ct:b64 }  AES-256-GCM, tag appended to ct.
  const PASS_KEY = 'pcc.passphrase';
  const te = new TextEncoder(), td = new TextDecoder();
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function deriveKey(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function decryptEnvelope(env, pass) {
    if (!env || env.v !== 1) throw new Error('unrecognised envelope');
    const key = await deriveKey(pass, b64(env.salt), env.iter || 150000);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(env.iv) }, key, b64(env.ct));
    return JSON.parse(td.decode(pt));
  }
  function storedPassphrase() { try { return localStorage.getItem(PASS_KEY); } catch (_) { return null; } }
  function forgetPassphrase() { try { localStorage.removeItem(PASS_KEY); } catch (_) {} }
  function locked() { return !storedPassphrase(); }

  // The in-page passphrase panel. NOT window.prompt: iOS Safari drops a prompt outside a user
  // gesture, and a prompt cannot tell the viewer that the passphrase never leaves this browser.
  // Resolves true once a passphrase is stored, false if the panel is dismissed.
  let lockOpen = null;
  function unlock(opts) {
    opts = opts || {};
    if (!opts.force && !locked()) return Promise.resolve(true);
    if (lockOpen) return lockOpen;
    const doc = g.document;
    if (!doc || !doc.body) return Promise.resolve(false);
    lockOpen = new Promise(function (resolve) {
      let done = false;
      const finish = ok => { if (done) return; done = true; lockOpen = null; try { doc.removeEventListener('keydown', onKey, true); } catch (_) {} if (back.parentNode) back.parentNode.removeChild(back); resolve(ok); };
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };

      const note = el('p', { class: 'stamp', style: 'margin:10px 0 0', text: opts.message || '' });
      const input = el('input', {
        type: 'password', id: 'pcc-pass', name: 'pcc-pass', autocomplete: 'current-password',
        'aria-label': 'Passphrase', placeholder: 'passphrase',
        style: 'width:100%;box-sizing:border-box;min-height:40px;margin:12px 0 10px;padding:8px 10px;border:1px solid var(--rule,#e4e2dc);border-radius:8px;background:var(--bg,#fbfaf7);color:var(--ink,#15181d);font-size:16px'
      });
      const forget = el('button', {
        type: 'button', class: 'btn link',
        style: 'background:none;border:0;padding:0;min-height:40px;color:var(--accent,#0e5f57);text-decoration:underline;font-size:13px;cursor:pointer',
        text: 'forget on this device',
        onclick: () => { forgetPassphrase(); input.value = ''; note.textContent = 'Forgotten on this device. Nothing is stored here now.'; input.focus(); }
      });
      const card = el('form', {
        class: 'card pcc-card',
        style: 'width:min(340px,calc(100vw - 32px));background:var(--surface,#fff);color:var(--ink,#15181d);border:1px solid var(--rule,#e4e2dc);border-radius:10px;padding:16px 18px;box-shadow:var(--shadow,0 6px 20px -12px rgba(21,24,29,.5))',
        onsubmit: e => { e.preventDefault(); const v = String(input.value || '').trim(); if (!v) { note.textContent = 'Type the passphrase, or close this and read the public numbers.'; input.focus(); return; } try { localStorage.setItem(PASS_KEY, v); } catch (_) {} finish(true); }
      }, [
        el('h2', { style: 'margin:0;font-size:16px', text: 'Locked' }),
        el('p', { class: 'stamp', style: 'margin:6px 0 0;line-height:1.5', text: 'Your balances are encrypted in the file itself. The passphrase is asked once per device and stored only in this browser — it is never sent anywhere, and there is no server to send it to.' }),
        input,
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
          el('button', { type: 'submit', class: 'btn', style: 'min-height:40px;padding:0 14px;border-radius:8px;border:1px solid var(--accent,#0e5f57);background:var(--accent,#0e5f57);color:var(--accent-ink,#fff);font-size:14px;font-weight:600;cursor:pointer', text: 'Unlock' }),
          el('button', { type: 'button', class: 'btn ghost', style: 'min-height:40px;padding:0 12px;border-radius:8px;border:1px solid var(--rule,#e4e2dc);background:none;color:var(--ink-2,#4a535f);font-size:14px;cursor:pointer', text: 'Not now', onclick: () => finish(false) }),
          forget
        ]),
        note
      ]);
      const back = el('div', {
        class: 'pcc-lock', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Passphrase',
        style: 'position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(21,24,29,.45)',
        onclick: e => { if (e.target === back) finish(false); }
      }, [card]);
      doc.body.appendChild(back);
      doc.addEventListener('keydown', onKey, true);
      try { input.focus(); } catch (_) {}
    });
    return lockOpen;
  }

  // Fetch + decrypt. A wrong passphrase throws a DOMException from subtle.decrypt; we clear the
  // cached one and let the caller retry so a typo does not lock the device out.
  async function loadEncrypted(url, opts) {
    opts = opts || {};
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    const env = await r.json();
    let pass = opts.force ? null : storedPassphrase();
    if (!pass) { if (await unlock({ force: true, message: opts.message || '' })) pass = storedPassphrase(); }
    if (!pass) throw new Error('no passphrase given');
    try { return await decryptEnvelope(env, pass); }
    catch (e) {
      forgetPassphrase();
      if (opts.retried) throw new Error('wrong passphrase');
      return loadEncrypted(url, { force: true, retried: true, message: 'That passphrase did not open the file. Try again.' });
    }
  }

  // ── loading ──────────────────────────────────────────────────────────────
  // Same-origin only, cache-busted, null on ANY failure. Null is a rendering instruction: say the
  // file is missing (err()), never substitute a zero.
  const dataURL = name => 'data/' + String(name == null ? '' : name).replace(/^\/*(?:data\/)?/, '');
  async function load(name) {
    const u = dataURL(name);
    try {
      const r = await fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }
  async function loadAll(names) {
    const ks = Array.isArray(names) ? names : [];
    const vs = await Promise.all(ks.map(load));
    const out = {}; ks.forEach((k, i) => { out[k] = vs[i]; }); return out;
  }
  async function priv(name) {
    const base = String(name == null ? '' : name).replace(/^\/*(?:data\/)?/, '').replace(/\.enc$/, '');
    try { return await loadEncrypted('data/' + base + '.enc'); } catch (_) { return null; }
  }

  // ── formatting ───────────────────────────────────────────────────────────
  const DASH = '—';
  const SYM = { SGD: 'S$', USD: 'US$', HKD: 'HK$', JPY: '¥', KRW: '₩', EUR: '€', GBP: '£', CNY: 'CN¥', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', TWD: 'NT$', MYR: 'RM', CHF: 'CHF ' };
  const fin = v => typeof v === 'number' && isFinite(v);
  function group(s) {
    s = String(s);
    const neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
    const dot = s.indexOf('.'), head = dot < 0 ? s : s.slice(0, dot), tail = dot < 0 ? '' : s.slice(dot);
    return (neg ? '-' : '') + head.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + tail;
  }
  function money(n, o) {
    o = o || {};
    const v = Number(n); if (n == null || n === '' || !fin(v)) return DASH;
    const cur = o.cur || 'SGD', dp = o.dp == null ? 0 : o.dp;
    const sym = SYM[cur] || (cur + ' ');
    const a = Math.abs(v);
    let body;
    if (o.compact) {
      const s = a >= 1e9 ? 'B' : a >= 1e6 ? 'M' : a >= 1e3 ? 'K' : '';
      const d = s === 'B' ? a / 1e9 : s === 'M' ? a / 1e6 : s === 'K' ? a / 1e3 : a;
      body = group(d.toFixed(s ? 2 : dp)) + s;
    } else body = group(a.toFixed(dp));
    return (v < 0 ? '-' : '') + sym + body;
  }
  function pct(n, o) {
    o = o || {};
    const v = Number(n); if (n == null || n === '' || !fin(v)) return DASH;
    const dp = o.dp == null ? 2 : o.dp, sign = o.sign !== false;
    const body = Math.abs(v).toFixed(dp);
    const lead = Number(body) === 0 ? '' : v < 0 ? '-' : sign ? '+' : '';
    return lead + body + '%';
  }
  function num(n, dp) {
    const v = Number(n); if (n == null || n === '' || !fin(v)) return DASH;
    return group(v.toFixed(dp == null ? 2 : dp));
  }
  // Dates are formatted by hand, not by toLocaleDateString: a YYYY-MM-DD parsed in a browser west
  // of SGT lands on the day before, and the brief's dates are already SGT calendar days.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function ymd(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso == null ? '' : iso));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1) return null;
    return d;
  }
  function dateShort(iso) { const d = ymd(iso); return d ? d.getUTCDate() + ' ' + MON[d.getUTCMonth()] : DASH; }
  function dateLong(iso) { const d = ymd(iso); return d ? DOW[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear() : DASH; }
  function ago(iso) {
    const a = ageDays(iso);
    if (a == null) return DASH;
    if (a <= 0) return 'today';
    if (a === 1) return 'yesterday';
    return a + 'd ago';
  }

  // ── the DOM ──────────────────────────────────────────────────────────────
  // el() is the ONLY way data reaches the page. `text` is textContent; `html` exists for the
  // literal strings this file's SVG helpers produce and must never be handed a data value.
  function el(tag, attrs, kids) {
    const doc = g.document;
    const n = doc.createElement(tag || 'div');
    attrs = attrs || {};
    for (const k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') { n.textContent = String(v); continue; }
      if (k === 'html') { n.innerHTML = String(v); continue; }
      if (k === 'class' || k === 'className') { if (String(v)) n.setAttribute('class', String(v)); continue; }
      if (k === 'dataset' && typeof v === 'object') { for (const d in v) { if (v[d] != null) n.setAttribute('data-' + d, String(v[d])); } continue; }
      if (k.slice(0, 2) === 'on' && typeof v === 'function') { n.addEventListener(k.slice(2), v); continue; }
      if (typeof v === 'function') continue;
      // URL attributes carry data (alerts.json / signals.json links). Allow only http(s), mailto,
      // a fragment, or a relative path; anything with another scheme (javascript:, data:) is dropped.
      if (/^(href|src|action|formaction|xlink:href|srcset|poster)$/i.test(k)) {
        const u = String(v).trim();
        if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(https?|mailto):/i.test(u)) continue;
      }
      n.setAttribute(k, v === true ? '' : String(v));
    }
    const list = kids == null ? [] : (Array.isArray(kids) ? kids : [kids]);
    for (const c of list) {
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'object' && c.nodeType ? c : doc.createTextNode(String(c)));
    }
    return n;
  }
  function err(msg) { return el('p', { class: 'err', text: String(msg == null ? '' : msg) }); }

  // ── series ───────────────────────────────────────────────────────────────
  // closes.json is exchange-indexed to halve its size; this puts it back together. Sessions where
  // an instrument did not print are dropped, not carried forward — a flat line invented by a
  // forward fill is a lie about a holiday.
  function closesFor(cl, sym) {
    if (!cl || !cl.instruments) return [];
    const inst = cl.instruments[sym];
    if (!inst || !Array.isArray(inst.c)) return [];
    const dates = (cl.exchanges && cl.exchanges[inst.ex]) || [];
    const n = Math.min(dates.length, inst.c.length), out = [];
    for (let i = 0; i < n; i++) { const c = Number(inst.c[i]); if (inst.c[i] == null || !fin(c)) continue; out.push({ d: String(dates[i]), c }); }
    return out;
  }
  function retPct(series, sessions) {
    if (!Array.isArray(series)) return null;
    const k = Math.round(Number(sessions));
    if (!fin(k) || k < 1) return null;
    const n = series.length; if (n < k + 1) return null;
    const a = series[n - 1 - k], b = series[n - 1];
    const p0 = a && Number(a.c), p1 = b && Number(b.c);
    if (!fin(p0) || !fin(p1) || p0 <= 0) return null;
    return (p1 / p0 - 1) * 100;
  }

  // ── charts: hand-drawn inline SVG ────────────────────────────────────────
  // Strings, not elements, because they carry no data-derived TEXT — the only glyphs drawn are
  // digits formatted here. Colour comes from currentColor and the pcc.css tokens, so a sparkline
  // inside .up is green and the same call inside .down is red, in either theme.
  const r2 = v => String(Math.round((fin(v) ? v : 0) * 100) / 100);
  const safeLab = s => String(s).replace(/[^0-9.,+\-%A-Za-z ]/g, '');
  function clean(series) {
    const out = [];
    const list = Array.isArray(series) ? series : [];
    for (const p of list) { if (!p || p.c == null) continue; const c = Number(p.c); if (!fin(c)) continue; out.push({ d: String(p.d == null ? '' : p.d), c }); }
    return out;
  }
  function scale(pts, w, h, padX, padT, padB) {
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { if (p.c < lo) lo = p.c; if (p.c > hi) hi = p.c; }
    if (!fin(lo) || !fin(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const n = pts.length;
    return {
      lo, hi,
      x: i => n < 2 ? w / 2 : padX + (i * (w - 2 * padX)) / (n - 1),
      y: v => h - padB - ((v - lo) / (hi - lo)) * (h - padT - padB)
    };
  }
  function pathOf(pts, s) {
    let d = '';
    for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + r2(s.x(i)) + ' ' + r2(s.y(pts[i].c));
    return d;
  }
  function spark(series, o) {
    o = o || {};
    const w = fin(+o.w) ? +o.w : 108, h = fin(+o.h) ? +o.h : 26, pad = 2;
    const pts = clean(series);
    const head = '<svg class="spark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + r2(w) + ' ' + r2(h)
      + '" width="' + r2(w) + '" height="' + r2(h) + '" role="img" aria-hidden="true" focusable="false">';
    if (!pts.length) return head + '</svg>';
    const s = scale(pts, w, h, pad, pad, pad);
    const d = pathOf(pts, s);
    let body = '';
    if (o.fill) body += '<path d="' + d + 'L' + r2(s.x(pts.length - 1)) + ' ' + r2(h) + 'L' + r2(s.x(0)) + ' ' + r2(h) + 'Z" fill="currentColor" fill-opacity="0.12" stroke="none"></path>';
    body += '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"></path>';
    body += '<circle cx="' + r2(s.x(pts.length - 1)) + '" cy="' + r2(s.y(pts[pts.length - 1].c)) + '" r="2" fill="currentColor"></circle>';
    return head + body + '</svg>';
  }
  // bands shade the spans where the trend gate was OFF: [{from:'2026-02-03',to:'2026-04-08'}].
  // `to` null means "still off" and runs to the right edge.
  function chart(series, o) {
    o = o || {};
    const w = fin(+o.w) ? +o.w : 640, h = fin(+o.h) ? +o.h : 200, padX = 4, padT = 8, padB = 8;
    const pts = clean(series);
    const head = '<svg class="chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + r2(w) + ' ' + r2(h)
      + '" role="img" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">';
    if (!pts.length) return head + '</svg>';
    const over = clean(o.overlay);
    let lo = Infinity, hi = -Infinity;
    for (const p of pts.concat(over)) { if (p.c < lo) lo = p.c; if (p.c > hi) hi = p.c; }
    const s = scale([{ d: '', c: lo }, { d: '', c: hi }], w, h, padX, padT, padB);
    const n = pts.length;
    const X = i => n < 2 ? w / 2 : padX + (i * (w - 2 * padX)) / (n - 1);
    const at = (iso, dflt) => {
      if (iso == null) return dflt;
      const t = String(iso).slice(0, 10);
      for (let i = 0; i < n; i++) if (pts[i].d >= t) return X(i);
      return X(n - 1);
    };
    let body = '';
    const bands = Array.isArray(o.bands) ? o.bands : [];
    for (const b of bands) {
      if (!b) continue;
      const x0 = at(b.from, X(0)), x1 = b.to == null ? X(n - 1) : at(b.to, X(n - 1));
      const lft = Math.min(x0, x1), wid = Math.max(1, Math.abs(x1 - x0));
      body += '<rect class="band' + (b.kind === 'warn' ? ' band-warn' : '') + '" x="' + r2(lft) + '" y="' + r2(padT) + '" width="' + r2(wid) + '" height="' + r2(h - padT - padB) + '"></rect>';
    }
    // index the main series by position, but map both series onto the shared value scale
    const mainPath = (() => { let d = ''; for (let i = 0; i < n; i++) d += (i ? 'L' : 'M') + r2(X(i)) + ' ' + r2(s.y(pts[i].c)); return d; })();
    if (over.length) {
      // by DATE, not by position: an overlay of a different length must not be stretched to fit
      const ix = new Map(); for (let i = 0; i < n; i++) ix.set(pts[i].d, i);
      let d = '', started = false;
      for (const o of over) { if (!ix.has(o.d)) continue; d += (started ? 'L' : 'M') + r2(X(ix.get(o.d))) + ' ' + r2(s.y(o.c)); started = true; }
      body += '<path class="overlay" d="' + d + '" fill="none" stroke="var(--muted,#77808d)" stroke-width="1.1" stroke-dasharray="3 3"></path>';
    }
    body += '<path d="' + mainPath + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></path>';
    body += '<circle cx="' + r2(X(n - 1)) + '" cy="' + r2(s.y(pts[n - 1].c)) + '" r="2.4" fill="currentColor"></circle>';
    if (o.label) {
      const dp = hi >= 1000 ? 0 : hi >= 10 ? 2 : 4;
      body += '<text class="lab" x="' + r2(padX) + '" y="' + r2(padT + 8) + '" fill="var(--muted,#77808d)" font-size="9">' + safeLab(num(hi, dp)) + '</text>';
      body += '<text class="lab" x="' + r2(padX) + '" y="' + r2(h - padB - 1) + '" fill="var(--muted,#77808d)" font-size="9">' + safeLab(num(lo, dp)) + '</text>';
    }
    return head + body + '</svg>';
  }

  // ── surfaces ─────────────────────────────────────────────────────────────
  function asof() {
    let q = '';
    try { q = (g.location && g.location.search) || ''; } catch (_) { return null; }
    const m = /[?&]asof=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(q);
    return m ? m[1] : null;
  }
  function hash() { try { return String((g.location && g.location.hash) || ''); } catch (_) { return ''; } }
  function deepLink(surface, anchor, asOf) {
    const sfc = String(surface == null ? 'today' : surface);
    const page = /\.html$/.test(sfc) ? sfc : sfc + '.html';
    const a = asOf === undefined ? asof() : asOf;
    const d = a ? String(a).slice(0, 10) : '';
    const q = /^\d{4}-\d{2}-\d{2}$/.test(d) ? '?asof=' + d : '';
    const an = anchor == null || anchor === '' ? '' : (String(anchor).charAt(0) === '#' ? String(anchor) : '#' + String(anchor));
    return page + q + an;
  }
  function nav(active, asOf) {
    const a = asof();
    const bar = el('nav', { class: 'bar', 'aria-label': 'surfaces' });
    [['today', 'Today'], ['book', 'Book'], ['inbox', 'Inbox']].forEach(function (p) {
      const on = String(active || '').replace(/\.html$/, '') === p[0];
      bar.appendChild(el('a', { href: deepLink(p[0], '', a), class: on ? 'on' : '', 'aria-current': on ? 'page' : null, text: p[1] }));
    });
    // NEVER the wall clock: with no as-of to show, say so. (A render time shown as a data date is
    // how quarter-old 13F holdings once wore a fresh green stamp.)
    const d = asOf || a;
    bar.appendChild(el('span', { class: 'stamp num', text: d ? 'as of ' + String(d).slice(0, 10) : 'as-of per block below' }));
    return bar;
  }
  function asofBanner() {
    const a = asof(); if (!a) return null;
    const t = sgtToday(); if (!(a < t)) return null;
    return el('div', { class: 'asof-banner', text: 'viewing ' + dateShort(a) + ' · today is ' + dateShort(t) });
  }
  function gateLabel(t) {
    const gt = t && t.gate;
    if (!gt || typeof gt.on !== 'boolean') return { text: 'gate —', cls: 'flat' };
    if (gt.on) return { text: 'gate ON', cls: 'good' };
    const n = Number(gt.belowStreak);
    return { text: 'gate OFF' + (fin(n) && n > 0 ? ' ' + n + 'd' : ''), cls: 'bad' };
  }

  g.PCC = {
    // phase 1
    freshness, stampHTML, stampEl, stampText, ageDays, sgtToday, loadEncrypted, decryptEnvelope, forgetPassphrase,
    // phase 5 — loading
    load, loadAll, priv, locked, unlock,
    // phase 5 — formatting
    money, pct, num, dateShort, dateLong, ago,
    // phase 5 — DOM
    el, err,
    // phase 5 — series and charts
    closesFor, retPct, spark, chart,
    // phase 5 — surfaces
    nav, asof, asofBanner, deepLink, hash, gateLabel
  };
})(window);
