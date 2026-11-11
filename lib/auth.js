const bcrypt = require('bcryptjs');
const db = require('./db');
const { newId, sha256, signSessionToken, verifySessionToken } = require('./crypto');
const { seedDefaultCategoriesForUser } = require('./categories');
const { recordAudit } = require('./audit');

const COOKIE_NAME = 'paisapilot_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function setSessionCookie(res, user) {
  const token = signSessionToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role || 'user',
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && (process.env.APP_BASE_URL || '').startsWith('https://'),
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/'
  });
  return token;
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

async function registerUser({ email, name, password, timezone = 'Asia/Kolkata', req = null }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await db.get(`SELECT id FROM users WHERE email = ?`, [normalizedEmail]);
  if (existing) {
    const err = new Error('An account with this email already exists.');
    err.statusCode = 409;
    throw err;
  }

  const now = new Date().toISOString();
  const userId = newId('usr');
  const passwordHash = await bcrypt.hash(password, 10);

  await db.run(
    `INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, ?)`,
    [userId, normalizedEmail, name.trim(), passwordHash, now, now]
  );

  await db.run(
    `INSERT INTO user_settings (
      user_id, timezone, currency, locale, theme, enable_3d, reduced_motion,
      daily_email_enabled, daily_email_time, email_recipient, email_verified,
      budget_rollover_enabled, budget_reset_day, data_retention_days, updated_at
    ) VALUES (?, ?, 'INR', 'en-IN', 'dark', 1, 0, 0, '23:00', ?, 0, 0, 1, 0, ?)`,
    [userId, timezone || 'Asia/Kolkata', normalizedEmail, now]
  );

  await seedDefaultCategoriesForUser(userId);

  // Seed default masked payment source so quick-add works smoothly
  await db.run(
    `INSERT INTO accounts_or_payment_sources (id, user_id, label, payment_method, masked_identifier, institution, is_active, created_at)
     VALUES (?, ?, 'PhonePe Primary UPI', 'PhonePe UPI', '••••@ybl', 'PhonePe / NPCI UPI', 1, ?)`,
    [newId('src'), userId, now]
  );

  await recordAudit({
    userId,
    action: 'user.registered',
    resourceType: 'user',
    resourceId: userId,
    req
  });

  return { id: userId, email: normalizedEmail, name: name.trim(), role: 'user' };
}

async function loginUser({ email, password, req = null }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await db.get(
    `SELECT id, email, name, password_hash, role, deleted_at FROM users WHERE email = ?`,
    [normalizedEmail]
  );
  if (!user || user.deleted_at) {
    const err = new Error('Invalid email or password.');
    err.statusCode = 401;
    throw err;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await recordAudit({
      userId: user.id,
      action: 'user.login_failed',
      resourceType: 'user',
      resourceId: user.id,
      req
    });
    const err = new Error('Invalid email or password.');
    err.statusCode = 401;
    throw err;
  }
  await recordAudit({
    userId: user.id,
    action: 'user.logged_in',
    resourceType: 'user',
    resourceId: user.id,
    req
  });
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

async function requestPasswordReset({ email, req = null }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await db.get(`SELECT id, email FROM users WHERE email = ? AND deleted_at IS NULL`, [normalizedEmail]);
  if (!user) {
    return { issued: false };
  }
  const rawToken = newId('rst').replace(/_/g, '') + Math.random().toString(36).slice(2, 10);
  const tokenHash = sha256(rawToken);
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 30).toISOString();

  await db.run(
    `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [newId('pr'), user.id, tokenHash, expires, now.toISOString()]
  );

  await recordAudit({
    userId: user.id,
    action: 'user.password_reset_requested',
    resourceType: 'user',
    resourceId: user.id,
    req
  });

  // In development/local single-node mode without Brevo, return token preview only when NODE_ENV !== 'production'
  return {
    issued: true,
    userId: user.id,
    email: user.email,
    resetToken: process.env.NODE_ENV !== 'production' ? rawToken : undefined
  };
}

async function resetPassword({ token, newPassword, req = null }) {
  const tokenHash = sha256(token);
  const row = await db.get(
    `SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ? ORDER BY created_at DESC LIMIT 1`,
    [tokenHash]
  );
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    const err = new Error('Reset token is invalid or has expired.');
    err.statusCode = 400;
    throw err;
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const now = new Date().toISOString();
  await db.run(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [passwordHash, now, row.user_id]);
  await db.run(`UPDATE password_resets SET used_at = ? WHERE id = ?`, [now, row.id]);
  await recordAudit({
    userId: row.user_id,
    action: 'user.password_reset_completed',
    resourceType: 'user',
    resourceId: row.user_id,
    req
  });
  return true;
}

function extractToken(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) {
    return req.cookies[COOKIE_NAME];
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const decoded = verifySessionToken(token);
  if (!decoded || !decoded.sub) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  const user = await db.get(
    `SELECT id, email, name, role, deleted_at FROM users WHERE id = ?`,
    [decoded.sub]
  );
  if (!user || user.deleted_at) {
    return res.status(401).json({ error: 'Account unavailable' });
  }
  const settings = await db.get(`SELECT * FROM user_settings WHERE user_id = ?`, [user.id]);
  req.user = user;
  req.userSettings = settings || { timezone: 'Asia/Kolkata', currency: 'INR', locale: 'en-IN' };
  next();
}

module.exports = {
  COOKIE_NAME,
  setSessionCookie,
  clearSessionCookie,
  registerUser,
  loginUser,
  requestPasswordReset,
  resetPassword,
  requireAuth
};
