const crypto = require('crypto');

function getAuthSecret() {
  return process.env.AUTH_SECRET || 'paisapilot-fallback-dev-secret-do-not-use-in-prod';
}

function getEncKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || getAuthSecret();
  return crypto.createHash('sha256').update(raw).digest();
}

function newId(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function encryptSecret(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptSecret(ciphertext) {
  if (!ciphertext) return null;
  const parts = String(ciphertext).split(':');
  if (parts.length !== 3) return null;
  const [ivHex, tagHex, encHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

function signSessionToken(payloadObj) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', getAuthSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const data = `${header}.${payload}`;
  const expected = crypto.createHmac('sha256', getAuthSecret()).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.exp && Date.now() > parsed.exp * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  newId,
  sha256,
  encryptSecret,
  decryptSecret,
  signSessionToken,
  verifySessionToken
};
