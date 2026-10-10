#!/usr/bin/env node
/*
 * send-smtp.js — send the brief as raw MIME over SMTP, bypassing Mail.app.
 *
 * WHY THIS EXISTS. Mail.app's AppleScript compose ALWAYS wraps the body in
 * <blockquote type="cite"> inside Apple-Mail-URLShareWrapperClass divs, and
 * adds a multipart/related part with an embedded PNG. Clients then render the
 * message as quoted/forwarded text. Eight compose paths were tested — content
 * at create, content after create, visible:true, plain-text default-format
 * preference, paragraph objects, mailto:, the html content property, and a
 * styled self-contained card — and every single one emits the wrapper. It is
 * not configurable.
 *
 * Sending raw MIME over SMTP gives byte-level control: a clean
 * multipart/alternative with text/plain + text/html, no blockquote, no
 * wrapper divs, no embedded image. The message is a normal first-party email.
 *
 * CONFIG (~/.claude/portfolio-brief.env):
 *   SMTP_HOST=smtp.mail.me.com     # iCloud. Gmail: smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=domzhao@me.com       # the full address
 *   SMTP_PASS=xxxx-xxxx-xxxx-xxxx  # an APP-SPECIFIC password, never the real one
 *
 * Usage: node scripts/send-smtp.js <subject> <textFile> <htmlFile> <to> [from]
 * Exits 0 on success, non-zero otherwise (so callers can fall back).
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

function readEnv() {
  const o = {};
  try {
    fs.readFileSync(path.join(process.env.HOME, '.claude', 'portfolio-brief.env'), 'utf8')
      .split('\n').forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].trim(); });
  } catch (_) {}
  return o;
}
// RFC 2047 encode a header that may contain non-ASCII (our subject has an emoji)
const encHeader = s => /^[\x20-\x7E]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
// quoted-printable, so UTF-8 survives and no line exceeds 76 chars
// Token-based: each byte becomes an indivisible token ("A", "=E2"), and a soft
// break is emitted BEFORE a token that would cross column 73. This can never
// split an =XX escape and always advances — an earlier index-slicing version
// could leave `cut` at 0, loop forever and exhaust the heap.
function qp(str) {
  const out = [];
  for (const line of str.split(/\r?\n/)) {
    let cur = '';
    for (const b of Buffer.from(line, 'utf8')) {
      const tok = b === 61 ? '=3D'
        : (b >= 32 && b <= 126) ? String.fromCharCode(b)
        : b === 9 ? '=09'
        : '=' + b.toString(16).toUpperCase().padStart(2, '0');
      if (cur.length + tok.length > 73) { out.push(cur + '='); cur = ''; }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join('\r\n');
}

const [, , subject, textFile, htmlFile, to, fromArg] = process.argv;
if (!subject || !textFile || !to) { console.error('usage: send-smtp.js <subject> <textFile> <htmlFile> <to> [from]'); process.exit(2); }
const env = readEnv();
const host = env.SMTP_HOST, port = env.SMTP_PORT || '587', user = env.SMTP_USER, pass = env.SMTP_PASS;
const DUMP = process.argv.includes('--dump');   // --dump builds and prints the MIME without needing credentials
if (!DUMP && (!host || !user || !pass)) { console.error('smtp: not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)'); process.exit(3); }
const from = fromArg || user || 'test@example.com';

const text = fs.readFileSync(textFile, 'utf8');
const html = htmlFile && fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, 'utf8') : null;

const bnd = 'pcc_' + Date.now().toString(36) + '_' + Math.floor(process.hrtime()[1] / 1000).toString(36);
const date = new Date().toUTCString().replace('GMT', '+0000');
const msgId = `<${Date.now()}.${process.pid}@${(from.split('@')[1] || 'localhost')}>`;
const head = [
  `From: ${encHeader('Portfolio Command Center')} <${from}>`,
  `To: <${to}>`,
  `Subject: ${encHeader(subject)}`,
  `Date: ${date}`,
  `Message-ID: ${msgId}`,
  'MIME-Version: 1.0',
];
let mime;
if (html) {
  mime = head.concat([
    `Content-Type: multipart/alternative; boundary="${bnd}"`, '',
    `--${bnd}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '', qp(text), '',
    `--${bnd}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '', qp(html), '',
    `--${bnd}--`, '',
  ]).join('\r\n');
} else {
  mime = head.concat(['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '', qp(text), '']).join('\r\n');
}

const tmp = path.join(require('os').tmpdir(), 'pcc-mime-' + process.pid + '.eml');
fs.writeFileSync(tmp, mime);
if (process.argv.includes('--dump')) { console.log(mime.slice(0, 1200)); process.exit(0); }

const r = spawnSync('curl', ['-s', '--show-error', '--ssl-reqd', '--max-time', '90',
  `smtp://${host}:${port}`, '--mail-from', from, '--mail-rcpt', to,
  '--upload-file', tmp, '--user', `${user}:${pass}`], { encoding: 'utf8', timeout: 100000 });
try { fs.unlinkSync(tmp); } catch (_) {}
if (r.status === 0) { console.log(`smtp: sent to ${to} via ${host} (clean MIME, no quote wrapper)`); process.exit(0); }
console.error('smtp: FAILED ' + ((r.stderr || '').trim() || `exit ${r.status}`).slice(0, 200));
process.exit(1);
