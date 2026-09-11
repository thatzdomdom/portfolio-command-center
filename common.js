/*
 * common.js — shared by every page of the Portfolio Command Center (phase 1 of the 11 Sep 2026
 * redesign). No framework, no build step, no external calls. Two jobs:
 *
 *   freshness(asOf, cadence)  — grey / amber / stale from the DATA's date against its cadence.
 *                               Never from a render time or a job run time: that is how quarter-old
 *                               13F data once wore a green dot.
 *   loadEncrypted(url)        — fetch a `.enc` envelope and decrypt it with a passphrase the viewer
 *                               types once per device. Files that carry the owner's balances
 *                               (book, valuation) are never published in the clear; see
 *                               scripts/encrypt-publish.js for the matching encryptor.
 *
 * index.html does not use this file yet — the parallel week runs the old computation beside the
 * new one. The phase-5 pages are built on it.
 */
(function (g) {
  'use strict';

  // ── freshness ────────────────────────────────────────────────────────────
  // cadence → [amber after N days, stale after N days]
  const CADENCE = { daily: [1, 2], 'daily-verify': [1, 3], weekly: [8, 12], quarterly: [100, 140], manual: [90, 180] };
  function sgtToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); }
  function ageDays(asOf) {
    const t = Date.parse(String(asOf || '').slice(0, 10)); if (isNaN(t)) return null;
    return Math.floor((Date.parse(sgtToday()) - t) / 864e5);
  }
  function freshness(asOf, cadence) {
    const age = ageDays(asOf);
    const [amber, stale] = CADENCE[cadence] || CADENCE.daily;
    if (age == null) return { state: 'unknown', ageDays: null, label: 'no date' };
    const state = age >= stale ? 'stale' : age >= amber ? 'amber' : 'fresh';
    const label = age <= 0 ? 'today' : age === 1 ? 'yesterday' : age + 'd old';
    return { state, ageDays: age, label: state === 'stale' ? 'STALE ' + age + 'd' : label };
  }
  // A stamp is WORDS, never colour alone — Mail on iPhone strips styles, and colour-only state is
  // invisible to anyone who cannot see it.
  function stampHTML(asOf, cadence, what) {
    const f = freshness(asOf, cadence);
    const col = f.state === 'stale' ? 'var(--red,#b91c1c)' : f.state === 'amber' ? 'var(--amber,#b45309)' : 'var(--muted,#6b7280)';
    return '<span class="stamp" style="color:' + col + ';font-size:11px;font-variant-numeric:tabular-nums">'
      + (what ? what + ' · ' : '') + 'as of ' + String(asOf || '—').slice(0, 10) + ' · ' + f.label + '</span>';
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
  function getPassphrase(force) {
    let p = null; try { p = force ? null : localStorage.getItem(PASS_KEY); } catch (_) {}
    if (!p) { p = window.prompt('Passphrase for your portfolio data (asked once per device):'); if (p) { try { localStorage.setItem(PASS_KEY, p); } catch (_) {} } }
    return p;
  }
  function forgetPassphrase() { try { localStorage.removeItem(PASS_KEY); } catch (_) {} }
  // Fetch + decrypt. A wrong passphrase throws a DOMException from subtle.decrypt; we clear the
  // cached one and let the caller retry so a typo does not lock the device out.
  async function loadEncrypted(url, opts) {
    opts = opts || {};
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    const env = await r.json();
    let pass = getPassphrase(opts.force);
    if (!pass) throw new Error('no passphrase given');
    try { return await decryptEnvelope(env, pass); }
    catch (e) { forgetPassphrase(); if (opts.retried) throw new Error('wrong passphrase'); return loadEncrypted(url, { force: true, retried: true }); }
  }

  g.PCC = { freshness, stampHTML, ageDays, sgtToday, loadEncrypted, decryptEnvelope, forgetPassphrase };
})(window);
