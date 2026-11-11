const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'token',
  'secret',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'brevo_api_key',
  'gemini_api_key',
  'auth_secret',
  'reference_id',
  'raw_body',
  'notification_body',
  'otp',
  'upi_pin',
  'encrypted_secret'
]);

function redact(obj, depth = 0) {
  if (depth > 4 || obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (obj.length > 24 && /^(AQ\.|xkeysib-|Bearer\s)/i.test(obj)) {
      return '[REDACTED]';
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...redact(meta)
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  redact
};
