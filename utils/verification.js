const crypto = require('crypto');
const QRCode = require('qrcode');

// The secret that "signs" each result so nobody can fake a verification link.
// On Render we reuse DATABASE_URL (already private); you can also set VERIFY_SECRET.
function getSecret() {
  return process.env.VERIFY_SECRET || process.env.DATABASE_URL || 'resultpro-dev-secret';
}

// A short code that only the server can produce for one student + term + session.
function makeVerifyCode(studentId, term, session) {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`${studentId}|${term}|${session}`)
    .digest('hex')
    .slice(0, 20);
}

function isValidVerifyCode(studentId, term, session, code) {
  if (!code) return false;
  const expected = Buffer.from(makeVerifyCode(studentId, term, session));
  const given = Buffer.from(String(code));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Works both locally and behind Render's proxy (which forwards the real https).
function baseUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0];
  return `${proto}://${req.get('host')}`;
}

// Returns { url, qr } — the link the QR points to, and the QR image as a data URL.
async function buildVerification(req, studentId, term, session) {
  const code = makeVerifyCode(studentId, term, session);
  const url =
    `${baseUrl(req)}/verify.html?s=${studentId}` +
    `&t=${encodeURIComponent(term)}&y=${encodeURIComponent(session)}&c=${code}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 180 });
  return { url, qr };
}

module.exports = { makeVerifyCode, isValidVerifyCode, buildVerification };
