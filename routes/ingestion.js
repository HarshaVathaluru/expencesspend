const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const db = require('../lib/db');
const { newId, sha256 } = require('../lib/crypto');
const { requireAuth } = require('../lib/auth');
const ingestion = require('../lib/ingestion');
const { getDatePartsInTz } = require('../lib/money');
const { createTransaction } = require('../lib/transactions');
const { recordAudit } = require('../lib/audit');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Ingestion rate limit exceeded; try again shortly.' }
});

/**
 * Companion / Webhook endpoint authenticated either by user session OR per-connection X-Webhook-Token.
 */
router.post('/ingestion/webhook', ingestLimiter, async (req, res, next) => {
  try {
    const token = req.headers['x-webhook-token'] || req.body?.webhookToken;
    if (!token) return res.status(401).json({ error: 'Missing X-Webhook-Token' });
    const tokenHash = sha256(String(token));
    const conn = await db.get(
      `SELECT * FROM ingestion_connections WHERE webhook_token_hash = ? AND status = 'active' AND consent_granted = 1`,
      [tokenHash]
    );
    if (!conn) return res.status(403).json({ error: 'Invalid, paused, or revoked connection token' });
    const settings = await db.get(`SELECT * FROM user_settings WHERE user_id = ?`, [conn.user_id]);
    const result = await ingestion.ingestNotificationEvent({
      userId: conn.user_id,
      userSettings: settings,
      connectionId: conn.id,
      provider: conn.provider,
      payload: req.body,
      req
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.use(requireAuth);

router.get('/ingestion/architecture', (req, res) => {
  res.json(ingestion.PHONEPE_ARCHITECTURE_INFO);
});

router.get('/ingestion/connections', async (req, res, next) => {
  try {
    const connections = await db.query(
      `SELECT id, provider, display_name, status, consent_granted, consent_granted_at, scopes_json, last_sync_at, last_error, pending_count, created_at
       FROM ingestion_connections WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    const events = await db.query(
      `SELECT id, provider, payload_summary, confidence, status, error_message, transaction_id, created_at
       FROM ingestion_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`,
      [req.user.id]
    );
    res.json({ connections, recentEvents: events });
  } catch (err) {
    next(err);
  }
});

router.post('/ingestion/connections', async (req, res, next) => {
  try {
    const provider = String(req.body?.provider || '');
    const allowed = ['android_notification', 'sms_parser', 'email_receipt', 'statement_import'];
    if (!allowed.includes(provider)) return res.status(400).json({ error: 'Unsupported provider' });
    if (!req.body?.consentGranted) return res.status(400).json({ error: 'Explicit user consent is required before enabling capture' });

    const displayName = String(req.body?.displayName || provider.replace('_', ' ')).slice(0, 80);
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : ['payment_amount', 'merchant_name', 'timestamp'];
    const rawToken = `ppk_${newId('').replace(/-/g, '')}`;
    const id = newId('con');
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO ingestion_connections (id, user_id, provider, display_name, status, consent_granted, consent_granted_at, scopes_json, webhook_token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)`,
      [id, req.user.id, provider, displayName, now, JSON.stringify(scopes), sha256(rawToken), now, now]
    );

    await recordAudit({
      userId: req.user.id,
      action: 'ingestion.connection_created',
      resourceType: 'ingestion_connection',
      resourceId: id,
      req,
      metadata: { provider }
    });

    const conn = await db.get(
      `SELECT id, provider, display_name, status, consent_granted, consent_granted_at, scopes_json, last_sync_at, last_error, pending_count, created_at
       FROM ingestion_connections WHERE id = ?`,
      [id]
    );
    res.status(201).json({ connection: conn, webhookTokenOnce: rawToken });
  } catch (err) {
    next(err);
  }
});

router.patch('/ingestion/connections/:id', async (req, res, next) => {
  try {
    const conn = await db.get(`SELECT * FROM ingestion_connections WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    const now = new Date().toISOString();

    if (req.body?.action === 'test') {
      await db.run(`UPDATE ingestion_connections SET last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`, [now, now, conn.id]);
      return res.json({
        ok: true,
        message: conn.status === 'active'
          ? 'Connection endpoint ready to receive consented payment events.'
          : `Connection is currently ${conn.status}. Resume it to accept events.`
      });
    }

    const nextStatus = ['active', 'paused', 'disconnected'].includes(req.body?.status) ? req.body.status : conn.status;
    await db.run(`UPDATE ingestion_connections SET status = ?, updated_at = ? WHERE id = ?`, [nextStatus, now, conn.id]);
    await recordAudit({
      userId: req.user.id,
      action: 'ingestion.connection_updated',
      resourceType: 'ingestion_connection',
      resourceId: conn.id,
      req,
      metadata: { status: nextStatus }
    });
    res.json({ ok: true, status: nextStatus });
  } catch (err) {
    next(err);
  }
});

router.delete('/ingestion/connections/:id', async (req, res, next) => {
  try {
    const conn = await db.get(`SELECT id FROM ingestion_connections WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (req.query.deleteEvents === 'true') {
      await db.run(`DELETE FROM ingestion_events WHERE connection_id = ? AND user_id = ?`, [conn.id, req.user.id]);
    }
    await db.run(`DELETE FROM ingestion_connections WHERE id = ? AND user_id = ?`, [conn.id, req.user.id]);
    await recordAudit({
      userId: req.user.id,
      action: 'ingestion.connection_revoked',
      resourceType: 'ingestion_connection',
      resourceId: conn.id,
      req
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/ingestion/events', ingestLimiter, async (req, res, next) => {
  try {
    const result = await ingestion.ingestNotificationEvent({
      userId: req.user.id,
      userSettings: req.userSettings,
      connectionId: req.body?.connectionId || null,
      provider: req.body?.provider || 'android_notification',
      payload: req.body,
      req
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/ingestion/import/csv-preview', upload.single('file'), (req, res, next) => {
  try {
    const csvText = req.file ? req.file.buffer.toString('utf8') : String(req.body?.csvText || '');
    if (!csvText.trim()) return res.status(400).json({ error: 'Provide a CSV file or CSV text' });
    const parsed = ingestion.parseCsvText(csvText);
    const suggestedMapping = ingestion.guessCsvMapping(parsed.headers);
    res.json({
      filename: req.file?.originalname || 'pasted.csv',
      headers: parsed.headers,
      suggestedMapping,
      totalRows: parsed.rows.length,
      previewRows: parsed.rows.slice(0, 20),
      rows: parsed.rows.slice(0, 1000)
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ingestion/import/pdf-preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF statement' });
    if (req.file.mimetype !== 'application/pdf' && !req.file.originalname.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Only PDF files are accepted here' });
    }
    const extracted = await ingestion.extractRowsFromPdfBuffer(req.file.buffer);
    res.json({
      filename: req.file.originalname,
      headers: ['date', 'merchant', 'amount', 'type', 'paymentMethod', 'reference'],
      suggestedMapping: {
        date: 'date',
        merchant: 'merchant',
        amount: 'amount',
        type: 'type',
        paymentMethod: 'paymentMethod',
        reference: 'reference'
      },
      rawLineCount: extracted.rawLineCount,
      totalRows: extracted.rows.length,
      previewRows: extracted.rows.slice(0, 20),
      rows: extracted.rows.slice(0, 1000)
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ingestion/import/commit', ingestLimiter, async (req, res, next) => {
  try {
    const { rows, mapping, sourceType, filename } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows to import' });
    }
    const report = await ingestion.runMappedImport({
      userId: req.user.id,
      userSettings: req.userSettings,
      rows: rows.slice(0, 1000),
      mapping: mapping || {},
      sourceType: sourceType === 'pdf' ? 'pdf' : 'csv',
      filename: String(filename || 'statement').slice(0, 120),
      req
    });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

router.get('/ingestion/batches', async (req, res, next) => {
  try {
    const batches = await db.query(
      `SELECT id, source_type, filename, total_rows, imported_rows, duplicate_rows, review_rows, failed_rows, status, created_at
       FROM import_batches WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json({ batches });
  } catch (err) {
    next(err);
  }
});

router.get('/reconciliation', async (req, res, next) => {
  try {
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const monthKey = req.query.monthKey || getDatePartsInTz(new Date(), tz).monthKey;
    const overview = await ingestion.getReconciliationOverview(req.user.id, monthKey);
    res.json(overview);
  } catch (err) {
    next(err);
  }
});

router.post('/reconciliation/resolve-event/:id', async (req, res, next) => {
  try {
    const ev = await db.get(`SELECT * FROM ingestion_events WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (!ev) return res.status(404).json({ error: 'Ingestion event not found' });

    if (req.body?.action === 'dismiss') {
      await db.run(`UPDATE ingestion_events SET status = 'ignored' WHERE id = ?`, [ev.id]);
      return res.json({ ok: true, status: 'ignored' });
    }

    const txRes = await createTransaction({
      userId: req.user.id,
      userSettings: req.userSettings,
      req,
      payload: {
        amount: req.body.amount,
        merchant: req.body.merchant,
        type: req.body.type || 'expense',
        categoryId: req.body.categoryId || null,
        paymentMethod: req.body.paymentMethod || 'PhonePe UPI',
        localDate: req.body.localDate,
        importSource: ev.provider,
        reconciliationStatus: 'verified',
        notes: 'Manually verified from review queue'
      }
    });

    await db.run(
      `UPDATE ingestion_events SET status = 'processed', transaction_id = ? WHERE id = ?`,
      [txRes.transaction?.id || null, ev.id]
    );
    res.json({ ok: true, transaction: txRes.transaction });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
