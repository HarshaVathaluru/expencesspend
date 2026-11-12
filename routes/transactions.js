const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const db = require('../lib/db');
const { newId } = require('../lib/crypto');
const { requireAuth } = require('../lib/auth');
const { getUserCategories, ensureOrCreateCategory } = require('../lib/categories');
const txService = require('../lib/transactions');

const router = express.Router();
router.use(requireAuth);

const uploadsRoot = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });

const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const userDir = path.join(uploadsRoot, req.user.id);
      fs.mkdirSync(userDir, { recursive: true });
      cb(null, userDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(ext) ? ext : '.bin';
      cb(null, `${newId('rcp')}${safeExt}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : new Error('Only PNG, JPEG, WebP, or PDF receipts up to 5MB are allowed'), ok);
  }
});

const txSchema = z.object({
  amount: z.union([z.string(), z.number()]).optional(),
  amountPaise: z.number().int().nonnegative().optional(),
  type: z.enum(['expense', 'income', 'transfer', 'refund']).default('expense'),
  occurredAt: z.string().optional(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  merchant: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  categoryId: z.string().nullable().optional(),
  subcategory: z.string().max(80).optional(),
  paymentMethod: z.string().max(40).optional(),
  sourceAccountId: z.string().nullable().optional(),
  referenceId: z.string().max(64).nullable().optional(),
  notes: z.string().max(600).optional(),
  tags: z.array(z.string().max(32)).max(12).optional(),
  reconciliationStatus: z.enum(['verified', 'captured', 'needs_review', 'possible_duplicate']).optional(),
  splits: z.array(z.object({
    categoryId: z.string().nullable().optional(),
    amount: z.union([z.string(), z.number()]).optional(),
    amountPaise: z.number().int().nonnegative().optional(),
    note: z.string().max(150).optional()
  })).optional(),
  learnRule: z.boolean().optional()
});

router.get('/categories', async (req, res, next) => {
  try {
    const categories = await getUserCategories(req.user.id);
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

router.post('/categories', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const kind = ['expense', 'income', 'transfer', 'savings'].includes(req.body?.kind) ? req.body.kind : 'expense';
    const color = /^#[0-9A-Fa-f]{6}$/.test(req.body?.color || '') ? req.body.color : null;
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Category name must be 2-40 characters' });
    const result = await ensureOrCreateCategory(req.user.id, { name, kind, color });
    if (!result) return res.status(400).json({ error: 'Invalid category name' });
    res.status(result.created ? 201 : 200).json({ category: result.category, created: result.created });
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', async (req, res, next) => {
  try {
    const cat = await db.get(
      `SELECT id, slug, name FROM categories WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    if (cat.slug === 'uncategorized') {
      return res.status(400).json({ error: 'Uncategorized fallback cannot be deleted' });
    }
    const fallback = await db.get(
      `SELECT id FROM categories WHERE user_id = ? AND slug = 'uncategorized' LIMIT 1`,
      [req.user.id]
    );
    const fallbackId = fallback?.id || null;
    await db.run(`UPDATE transactions SET category_id = ? WHERE user_id = ? AND category_id = ?`, [fallbackId, req.user.id, cat.id]);
    await db.run(`UPDATE transaction_splits SET category_id = ? WHERE user_id = ? AND category_id = ?`, [fallbackId, req.user.id, cat.id]);
    await db.run(`DELETE FROM budget_categories WHERE user_id = ? AND category_id = ?`, [req.user.id, cat.id]);
    await db.run(`DELETE FROM merchant_category_rules WHERE user_id = ? AND category_id = ?`, [req.user.id, cat.id]);
    await db.run(`DELETE FROM categories WHERE id = ? AND user_id = ?`, [cat.id, req.user.id]);
    res.json({ deleted: true, id: cat.id });
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard/summary', async (req, res, next) => {
  try {
    const { monthKey, startDate, endDate } = req.query;
    const summary = await txService.getAnalyticsSummary(req.user.id, {
      monthKey: monthKey || null,
      startDate: startDate || null,
      endDate: endDate || null,
      timezone: req.userSettings.timezone || 'Asia/Kolkata'
    });
    res.json({ summary });
  } catch (err) {
    next(err);
  }
});

router.get('/transactions', async (req, res, next) => {
  try {
    const result = await txService.listTransactions(req.user.id, req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/transactions', async (req, res, next) => {
  try {
    const parsed = txSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid transaction payload' });
    }
    if (parsed.data.amount === undefined && parsed.data.amountPaise === undefined) {
      return res.status(400).json({ error: 'Amount is required' });
    }
    const result = await txService.createTransaction({
      userId: req.user.id,
      userSettings: req.userSettings,
      payload: parsed.data,
      req
    });
    res.status(201).json(result);
  } catch (err) {
    if (/amount|split|merchant/i.test(err.message)) err.statusCode = 400;
    next(err);
  }
});

router.post('/transactions/demo-seed', async (req, res, next) => {
  try {
    const result = await txService.seedDemoTransactions(req.user.id, req.userSettings);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.delete('/transactions/demo-seed', async (req, res, next) => {
  try {
    const result = await txService.clearDemoTransactions(req.user.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/transactions/:id', async (req, res, next) => {
  try {
    const tx = await txService.getTransactionById(req.user.id, req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ transaction: tx });
  } catch (err) {
    next(err);
  }
});

router.put('/transactions/:id', async (req, res, next) => {
  try {
    const parsed = txSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid update payload' });
    }
    const updated = await txService.updateTransaction({
      userId: req.user.id,
      txId: req.params.id,
      payload: parsed.data,
      userSettings: req.userSettings,
      req
    });
    res.json({ transaction: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/transactions/:id', async (req, res, next) => {
  try {
    await txService.deleteTransaction({ userId: req.user.id, txId: req.params.id, req });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/transactions/:id/receipt', receiptUpload.single('receipt'), async (req, res, next) => {
  try {
    const tx = await txService.getTransactionById(req.user.id, req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (!req.file) return res.status(400).json({ error: 'Receipt file is required' });
    const relPath = path.join(req.user.id, req.file.filename);
    await db.run(`UPDATE transactions SET receipt_path = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
      relPath,
      new Date().toISOString(),
      tx.id,
      req.user.id
    ]);
    res.json({ ok: true, receiptUrl: `/api/v1/transactions/${tx.id}/receipt` });
  } catch (err) {
    next(err);
  }
});

router.get('/transactions/:id/receipt', async (req, res, next) => {
  try {
    const tx = await txService.getTransactionById(req.user.id, req.params.id);
    if (!tx || !tx.receipt_path) return res.status(404).json({ error: 'Receipt not found' });
    const resolved = path.resolve(uploadsRoot, tx.receipt_path);
    if (!resolved.startsWith(uploadsRoot) || !fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'Receipt file missing' });
    }
    res.sendFile(resolved);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
