const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { getDatePartsInTz } = require('../lib/money');
const reports = require('../lib/reports');
const brevo = require('../lib/brevo');
const { tickDailyScheduler } = require('../lib/scheduler');
const { recordAudit } = require('../lib/audit');

const router = express.Router();

const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Email dispatch limit reached for this hour.' }
});

// Protected cron endpoint for external schedulers (Render/Railway/Cloud Scheduler)
router.post('/cron/daily-reports', async (req, res, next) => {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['x-cron-secret'] !== secret) {
      return res.status(403).json({ error: 'Invalid cron secret' });
    }
    await tickDailyScheduler();
    res.json({ ok: true, checkedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// Brevo delivery webhook receiver (validates secret if configured)
router.post('/webhooks/brevo', async (req, res, next) => {
  try {
    const expectedSecret = process.env.BREVO_WEBHOOK_SECRET;
    if (expectedSecret && req.headers['x-brevo-secret'] !== expectedSecret) {
      return res.status(403).json({ error: 'Invalid Brevo webhook signature' });
    }
    const msgId = req.body?.['message-id'] || req.body?.messageId;
    const event = String(req.body?.event || '').toLowerCase();
    if (msgId && ['delivered', 'hard_bounce', 'soft_bounce', 'blocked', 'error'].includes(event)) {
      const nextStatus = event === 'delivered' ? 'sent' : 'failed';
      await db.run(
        `UPDATE email_delivery_logs SET status = ?, failure_reason = ?, updated_at = ? WHERE provider_message_id = ?`,
        [nextStatus, event === 'delivered' ? null : `Brevo webhook: ${event}`, new Date().toISOString(), String(msgId)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.use(requireAuth);

// --- REPORTS & EXPORTS ---
router.get('/reports/export/csv', async (req, res, next) => {
  try {
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const monthKey = req.query.monthKey || getDatePartsInTz(new Date(), tz).monthKey;
    const startDate = req.query.startDate || `${monthKey}-01`;
    const endDate = req.query.endDate || `${monthKey}-31`;
    const csv = await reports.generateTransactionsCsv(req.user.id, { startDate, endDate });
    await recordAudit({ userId: req.user.id, action: 'report.export_csv', resourceType: 'report', req, metadata: { startDate, endDate } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="paisapilot_${startDate}_to_${endDate}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/reports/export/pdf', async (req, res, next) => {
  try {
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const monthKey = req.query.monthKey || getDatePartsInTz(new Date(), tz).monthKey;
    const startDate = req.query.startDate || `${monthKey}-01`;
    const endDate = req.query.endDate || `${monthKey}-31`;
    const buf = await reports.generateMonthlyStatementPdfBuffer(req.user.id, {
      monthKey,
      startDate,
      endDate,
      timezone: tz,
      locale: req.userSettings.locale || 'en-IN',
      currency: req.userSettings.currency || 'INR'
    });
    await recordAudit({ userId: req.user.id, action: 'report.export_pdf', resourceType: 'report', req, metadata: { startDate, endDate } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="paisapilot_statement_${startDate}_to_${endDate}.pdf"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

router.get('/reports/export/json', async (req, res, next) => {
  try {
    const data = await reports.exportAllUserDataJson(req.user.id);
    await recordAudit({ userId: req.user.id, action: 'report.export_full_json', resourceType: 'user', resourceId: req.user.id, req });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="paisapilot_full_export.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    next(err);
  }
});

// --- EMAIL REMINDER SETTINGS & BREVO ---
router.get('/email/settings', async (req, res, next) => {
  try {
    const s = req.userSettings;
    const logs = await db.query(
      `SELECT id, recipient_email, report_type, status, http_status, retry_count, failure_reason, provider_message_id, created_at
       FROM email_delivery_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json({
      brevoConfigured: brevo.isBrevoConfigured(),
      settings: {
        daily_email_enabled: Boolean(s.daily_email_enabled),
        daily_email_time: s.daily_email_time || '23:00',
        timezone: s.timezone || 'Asia/Kolkata',
        email_recipient: s.email_recipient || req.user.email,
        email_verified: Boolean(s.email_verified)
      },
      logs
    });
  } catch (err) {
    next(err);
  }
});

router.put('/email/settings', async (req, res, next) => {
  try {
    const recipient = String(req.body?.email_recipient || req.userSettings.email_recipient || req.user.email).trim().toLowerCase();
    const emailChanged = recipient !== (req.userSettings.email_recipient || '').toLowerCase();
    const verified = emailChanged ? 0 : (req.userSettings.email_verified ? 1 : 0);
    const enabled = req.body?.daily_email_enabled && verified ? 1 : 0;
    const time = /^\d{2}:\d{2}$/.test(req.body?.daily_email_time || '') ? req.body.daily_email_time : (req.userSettings.daily_email_time || '23:00');
    const tz = String(req.body?.timezone || req.userSettings.timezone || 'Asia/Kolkata');

    if (req.body?.daily_email_enabled && !verified) {
      return res.status(400).json({ error: 'Please confirm/verify your recipient email address before enabling daily scheduled reports.' });
    }

    await db.run(
      `UPDATE user_settings SET email_recipient = ?, email_verified = ?, daily_email_enabled = ?, daily_email_time = ?, timezone = ?, updated_at = ?
       WHERE user_id = ?`,
      [recipient, verified, enabled, time, tz, new Date().toISOString(), req.user.id]
    );
    res.json({ ok: true, email_verified: Boolean(verified), daily_email_enabled: Boolean(enabled) });
  } catch (err) {
    next(err);
  }
});

router.post('/email/verify/request', async (req, res, next) => {
  try {
    const recipient = String(req.body?.email_recipient || req.userSettings.email_recipient || req.user.email).trim().toLowerCase();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await db.run(
      `UPDATE user_settings SET email_recipient = ?, email_verification_code = ?, email_verified = 0, updated_at = ? WHERE user_id = ?`,
      [recipient, code, new Date().toISOString(), req.user.id]
    );
    res.json({
      ok: true,
      recipient,
      message: 'Verification code issued. Enter the code to confirm this email address.',
      verificationCodePreview: code
    });
  } catch (err) {
    next(err);
  }
});

router.post('/email/verify/confirm', async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim();
    const row = await db.get(`SELECT email_verification_code FROM user_settings WHERE user_id = ?`, [req.user.id]);
    if (!row || !row.email_verification_code || row.email_verification_code !== code) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }
    await db.run(
      `UPDATE user_settings SET email_verified = 1, email_verification_code = NULL, updated_at = ? WHERE user_id = ?`,
      [new Date().toISOString(), req.user.id]
    );
    res.json({ ok: true, email_verified: true });
  } catch (err) {
    next(err);
  }
});

router.get('/email/preview', async (req, res, next) => {
  try {
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const localDate = req.query.date || getDatePartsInTz(new Date(), tz).localDate;
    const [data, budgetAlertHtml] = await Promise.all([
      brevo.buildDailySummaryData(req.user.id, localDate, tz),
      brevo.buildBudgetAlertPreviewHtml(req.user.id, tz)
    ]);
    res.json({ ...data, budgetAlertHtml });
  } catch (err) {
    next(err);
  }
});

router.post('/email/send-test', emailLimiter, async (req, res, next) => {
  try {
    const result = await brevo.deliverDailyReportForUser({
      userId: req.user.id,
      reportType: 'test_email',
      force: true
    });
    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/email/send-today', emailLimiter, async (req, res, next) => {
  try {
    const result = await brevo.deliverDailyReportForUser({
      userId: req.user.id,
      reportType: 'daily_summary',
      force: true
    });
    await recordAudit({ userId: req.user.id, action: 'email.manual_daily_report', resourceType: 'daily_report', resourceId: result.reportId, req });
    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- GENERAL SETTINGS & AUDIT LOGS ---
router.get('/settings', (req, res) => {
  const s = req.userSettings;
  res.json({
    profile: req.user,
    settings: {
      timezone: s.timezone,
      currency: s.currency,
      locale: s.locale,
      theme: s.theme,
      enable_3d: Boolean(s.enable_3d),
      reduced_motion: Boolean(s.reduced_motion),
      budget_rollover_enabled: Boolean(s.budget_rollover_enabled),
      budget_reset_day: s.budget_reset_day,
      data_retention_days: s.data_retention_days
    }
  });
});

router.put('/settings', async (req, res, next) => {
  try {
    const b = req.body || {};
    const now = new Date().toISOString();
    if (b.name && String(b.name).trim().length >= 2) {
      await db.run(`UPDATE users SET name = ?, updated_at = ? WHERE id = ?`, [String(b.name).trim().slice(0, 80), now, req.user.id]);
    }
    await db.run(
      `UPDATE user_settings SET
        timezone = ?, currency = ?, locale = ?, theme = ?, enable_3d = ?, reduced_motion = ?,
        budget_rollover_enabled = ?, budget_reset_day = ?, data_retention_days = ?, updated_at = ?
       WHERE user_id = ?`,
      [
        b.timezone || req.userSettings.timezone || 'Asia/Kolkata',
        b.currency || req.userSettings.currency || 'INR',
        b.locale || req.userSettings.locale || 'en-IN',
        b.theme === 'light' ? 'light' : 'dark',
        b.enable_3d === false ? 0 : 1,
        b.reduced_motion ? 1 : 0,
        b.budget_rollover_enabled ? 1 : 0,
        Math.min(28, Math.max(1, Number(b.budget_reset_day || 1))),
        Math.max(0, Number(b.data_retention_days || 0)),
        now,
        req.user.id
      ]
    );
    await recordAudit({ userId: req.user.id, action: 'settings.updated', resourceType: 'user_settings', resourceId: req.user.id, req });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/audit-logs', async (req, res, next) => {
  try {
    const logs = await db.query(
      `SELECT id, action, resource_type, resource_id, ip_address, metadata_json, created_at
       FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
