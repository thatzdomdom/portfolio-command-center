#!/usr/bin/env node
/*
 * encrypt-publish.js — the files that carry the owner's balances never leave the Mac in the clear.
 *
 * Decision 4 of the 11 Sep 2026 redesign, answered "encrypt". GitHub Pages is world-readable at a
 * stable URL. Phase 1 moves 13 cash accounts, 3 property marks, a PE stake and the margin loan out
 * of the HTML into clean JSON — which would be a clean feed of the owner's finances for anyone with
 * the link. So: plaintext book.json and valuation.json are GITIGNORED, and only their `.enc`
 * envelopes are committed. The browser decrypts with a passphrase typed once per device
 * (common.js). No server, no account, nothing that expires.
 *
 * FAIL CLOSED. No passphrase → exit 78 and write nothing. publish.js treats that as red and does
 * not push. The alternative — falling back to plaintext — is the one outcome this file exists to
 * make impossible.
 *
 * Envelope (must match common.js decryptEnvelope):
 *   { v:1, kdf:"PBKDF2-SHA256", iter:150000, salt:b64(16), iv:b64(12), ct:b64(ciphertext||gcmTag) }
 * WebCrypto's AES-GCM expects the 16-byte tag appended to the ciphertext; Node returns it
 * separately, so it is concatenated here. A round-trip self-test runs on every invocation.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const D = f => path.join(__dirname, '..', 'data', f);
// Phase 4 (12 Sep 2026): oneaction.json (the action text names the loan) and journal.json (the
// owner's replies) join the envelope set. Absent files are skipped, never invented.
const FILES = ['book.json', 'valuation.json', 'oneaction.json', 'journal.json'];
const ITER = 150000;

function readEnv() {
  const o = {};
  try { fs.readFileSync(path.join(process.env.HOME, '.claude', 'portfolio-brief.env'), 'utf8').split('\n')
    .forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].trim(); }); } catch (_) {}
  return o;
}
function encrypt(obj, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pass, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final(), c.getAuthTag()]);
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}
function decrypt(env, pass) {   // self-test only; mirrors common.js exactly
  const salt = Buffer.from(env.salt, 'base64'), iv = Buffer.from(env.iv, 'base64'), ct = Buffer.from(env.ct, 'base64');
  const key = crypto.pbkdf2Sync(pass, salt, env.iter, 32, 'sha256');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'));
}

const pass = readEnv().PCC_PASSPHRASE;
if (!pass || pass.length < 12) {
  console.error('encrypt-publish: PCC_PASSPHRASE missing or under 12 chars in ~/.claude/portfolio-brief.env — NOTHING written (fail closed)');
  process.exit(78);
}
let n = 0;
for (const f of FILES) {
  if (!fs.existsSync(D(f))) { console.log(`  skip ${f} (absent)`); continue; }
  const obj = JSON.parse(fs.readFileSync(D(f), 'utf8'));
  const env = encrypt(obj, pass);
  const back = decrypt(env, pass);
  if (JSON.stringify(back) !== JSON.stringify(obj)) { console.error(`encrypt-publish: ROUND-TRIP FAILED for ${f}`); process.exit(1); }
  if (fs.existsSync(D(f + '.plain'))) fs.unlinkSync(D(f + '.plain'));
  const out = D(f.replace(/\.json$/, '.enc'));
  fs.writeFileSync(out, JSON.stringify(env) + '\n');
  n++;
  console.log(`  ${f} → ${path.basename(out)} (${(fs.statSync(out).size / 1024).toFixed(1)} KB, round-trip OK)`);
}
console.log(`encrypt-publish: ${n} file(s) encrypted`);
