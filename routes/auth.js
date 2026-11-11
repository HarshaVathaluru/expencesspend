const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const auth = require('../lib/auth');
const { recordAudit } = require('../lib/audit');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please wait a few minutes.' }
});

const registerSchema = z.object({
  email: z.string().email().max(160),
  name: z.string().min(2).max(80),
  password: z.string().min(8).max(128),
  timezone: z.string().min(2).max(64).optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration data' });
    }
    const user = await auth.registerUser({ ...parsed.data, req });
    const token = auth.setSessionCookie(res, user);
    res.status(201).json({ user, token });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid email and password are required' });
    }
    const user = await auth.loginUser({ ...parsed.data, req });
    const token = auth.setSessionCookie(res, user);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', auth.requireAuth, (req, res) => {
  res.json({
    user: req.user,
    settings: {
      timezone: req.userSettings.timezone,
      currency: req.userSettings.currency,
      locale: req.userSettings.locale,
      theme: req.userSettings.theme,
      enable_3d: Boolean(req.userSettings.enable_3d),
      reduced_motion: Boolean(req.userSettings.reduced_motion),
      daily_email_enabled: Boolean(req.userSettings.daily_email_enabled),
      daily_email_time: req.userSettings.daily_email_time,
      email_recipient: req.userSettings.email_recipient,
      email_verified: Boolean(req.userSettings.email_verified)
    }
  });
});

router.post('/password-reset/request', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim();
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const result = await auth.requestPasswordReset({ email, req });
    res.json({
      ok: true,
      message: 'If an account matches that email, a reset token has been generated.',
      devResetToken: result.resetToken
    });
  } catch (err) {
    next(err);
  }
});

router.post('/password-reset/confirm', authLimiter, async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!token || newPassword.length < 8) {
      return res.status(400).json({ error: 'Valid reset token and password (min 8 chars) are required' });
    }
    await auth.resetPassword({ token, newPassword, req });
    res.json({ ok: true, message: 'Password updated. You can now sign in.' });
  } catch (err) {
    next(err);
  }
});

router.delete('/account', auth.requireAuth, async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    const row = await db.get(`SELECT password_hash FROM users WHERE id = ?`, [req.user.id]);
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      return res.status(403).json({ error: 'Password confirmation failed' });
    }
    await recordAudit({
      userId: req.user.id,
      action: 'user.account_deleted',
      resourceType: 'user',
      resourceId: req.user.id,
      req
    });
    await db.run(`DELETE FROM users WHERE id = ?`, [req.user.id]);
    auth.clearSessionCookie(res);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
