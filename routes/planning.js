const express = require('express');
const db = require('../lib/db');
const { newId } = require('../lib/crypto');
const { requireAuth } = require('../lib/auth');
const { toPaise, getDatePartsInTz, shiftDate } = require('../lib/money');
const { createTransaction, getAnalyticsSummary } = require('../lib/transactions');
const { generateInsights } = require('../lib/insights');
const { checkAndSendBudgetExceededAlert } = require('../lib/brevo');

const router = express.Router();
router.use(requireAuth);

// --- BUDGETS ---
router.get('/budgets', async (req, res, next) => {
  try {
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const monthKey = req.query.monthKey || getDatePartsInTz(new Date(), tz).monthKey;
    let budget = await db.get(`SELECT * FROM budgets WHERE user_id = ? AND month_key = ?`, [req.user.id, monthKey]);
    if (!budget) {
      budget = await db.get(`SELECT * FROM budgets WHERE user_id = ? AND month_key = 'default'`, [req.user.id]);
    }
    const categoryLimits = budget
      ? await db.query(
          `SELECT bc.*, c.name AS category_name, c.slug AS category_slug, c.color AS category_color, c.icon_path AS category_icon
           FROM budget_categories bc
           JOIN categories c ON bc.category_id = c.id
           WHERE bc.budget_id = ? AND bc.user_id = ?`,
          [budget.id, req.user.id]
        )
      : [];
    const summary = await getAnalyticsSummary(req.user.id, { monthKey, timezone: tz });
    res.json({
      monthKey,
      budget: budget
        ? {
            ...budget,
            alertThresholds: JSON.parse(budget.alert_thresholds_json || '[50,75,90,100]')
          }
        : null,
      categoryLimits,
      spentByCategory: summary.categories,
      netSpentPaise: summary.netSpentPaise
    });
  } catch (err) {
    next(err);
  }
});

router.put('/budgets', async (req, res, next) => {
  try {
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const monthKey = req.body?.monthKey || getDatePartsInTz(new Date(), tz).monthKey;
    const overallLimitPaise = req.body?.overallLimitPaise !== undefined
      ? Number(req.body.overallLimitPaise)
      : toPaise(String(req.body?.overallLimit || '0'));
    const thresholds = Array.isArray(req.body?.alertThresholds)
      ? req.body.alertThresholds.map(Number).filter((n) => n > 0 && n <= 200)
      : [50, 75, 90, 100];
    const rolloverEnabled = req.body?.rolloverEnabled ? 1 : 0;
    const resetDay = Math.min(28, Math.max(1, Number(req.body?.resetDay || 1)));
    const now = new Date().toISOString();

    let existing = await db.get(`SELECT id FROM budgets WHERE user_id = ? AND month_key = ?`, [req.user.id, monthKey]);
    let budgetId = existing?.id;
    if (!budgetId) {
      budgetId = newId('bdg');
      await db.run(
        `INSERT INTO budgets (id, user_id, month_key, overall_limit_paise, alert_thresholds_json, rollover_enabled, reset_day, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [budgetId, req.user.id, monthKey, overallLimitPaise, JSON.stringify(thresholds), rolloverEnabled, resetDay, now, now]
      );
    } else {
      await db.run(
        `UPDATE budgets SET overall_limit_paise = ?, alert_thresholds_json = ?, rollover_enabled = ?, reset_day = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
        [overallLimitPaise, JSON.stringify(thresholds), rolloverEnabled, resetDay, now, budgetId, req.user.id]
      );
    }

    if (Array.isArray(req.body?.categoryLimits)) {
      await db.run(`DELETE FROM budget_categories WHERE budget_id = ? AND user_id = ?`, [budgetId, req.user.id]);
      for (const cl of req.body.categoryLimits) {
        if (!cl.categoryId) continue;
        const limitPaise = cl.limitPaise !== undefined ? Number(cl.limitPaise) : toPaise(String(cl.limit || '0'));
        if (limitPaise <= 0) continue;
        await db.run(
          `INSERT INTO budget_categories (id, budget_id, user_id, category_id, limit_paise, rollover_paise, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
          [newId('bcat'), budgetId, req.user.id, cl.categoryId, limitPaise, now]
        );
      }
    }

    await checkAndSendBudgetExceededAlert({
      userId: req.user.id,
      monthKey: monthKey === 'default' ? getDatePartsInTz(new Date(), tz).monthKey : monthKey,
      timezone: tz
    });

    res.json({ ok: true, budgetId, monthKey });
  } catch (err) {
    next(err);
  }
});

// --- SAVINGS GOALS ---
router.get('/goals', async (req, res, next) => {
  try {
    const goals = await db.query(`SELECT * FROM savings_goals WHERE user_id = ? ORDER BY created_at DESC`, [req.user.id]);
    res.json({ goals });
  } catch (err) {
    next(err);
  }
});

router.post('/goals', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Goal name is required' });
    const targetPaise = req.body?.targetPaise !== undefined ? Number(req.body.targetPaise) : toPaise(String(req.body?.target || '0'));
    const currentPaise = req.body?.currentPaise !== undefined ? Number(req.body.currentPaise) : toPaise(String(req.body?.current || '0'));
    const monthlyPaise = req.body?.monthlyContribution ? toPaise(String(req.body.monthlyContribution)) : 0;
    if (targetPaise <= 0) return res.status(400).json({ error: 'Target amount must be positive' });

    const id = newId('gol');
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO savings_goals (id, user_id, name, target_paise, current_paise, target_date, monthly_contribution_paise, color, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.user.id,
        name,
        targetPaise,
        currentPaise,
        req.body?.targetDate || null,
        monthlyPaise,
        req.body?.color || '#10B981',
        currentPaise >= targetPaise ? 'completed' : 'active',
        now,
        now
      ]
    );
    const goal = await db.get(`SELECT * FROM savings_goals WHERE id = ?`, [id]);
    res.status(201).json({ goal });
  } catch (err) {
    next(err);
  }
});

router.patch('/goals/:id', async (req, res, next) => {
  try {
    const goal = await db.get(`SELECT * FROM savings_goals WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    let currentPaise = goal.current_paise;
    if (req.body?.deltaAmount !== undefined) {
      const delta = toPaise(String(Math.abs(Number(req.body.deltaAmount))));
      currentPaise = req.body.action === 'withdraw' ? Math.max(0, currentPaise - delta) : currentPaise + delta;
    } else if (req.body?.currentPaise !== undefined) {
      currentPaise = Number(req.body.currentPaise);
    }

    const status = currentPaise >= goal.target_paise ? 'completed' : (req.body?.status || goal.status);
    await db.run(
      `UPDATE savings_goals SET current_paise = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [currentPaise, status, new Date().toISOString(), goal.id, req.user.id]
    );
    const updated = await db.get(`SELECT * FROM savings_goals WHERE id = ?`, [goal.id]);
    res.json({ goal: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/goals/:id', async (req, res, next) => {
  try {
    await db.run(`DELETE FROM savings_goals WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- RECURRING RULES ---
function advanceDueDate(dateStr, cadence) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (cadence === 'daily') return shiftDate(dateStr, 1);
  if (cadence === 'weekly') return shiftDate(dateStr, 7);
  if (cadence === 'yearly') return `${y + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // monthly
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  return `${nextY}-${String(nextM).padStart(2, '0')}-${String(Math.min(28, d)).padStart(2, '0')}`;
}

router.get('/recurring', async (req, res, next) => {
  try {
    const rules = await db.query(
      `SELECT r.*, c.name AS category_name, c.color AS category_color
       FROM recurring_rules r
       LEFT JOIN categories c ON r.category_id = c.id
       WHERE r.user_id = ? ORDER BY r.next_due_date ASC`,
      [req.user.id]
    );
    res.json({ recurring: rules });
  } catch (err) {
    next(err);
  }
});

router.post('/recurring', async (req, res, next) => {
  try {
    const title = String(req.body?.title || '').trim();
    const merchant = String(req.body?.merchant || title).trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const amountPaise = req.body?.amountPaise !== undefined ? Number(req.body.amountPaise) : toPaise(String(req.body?.amount || '0'));
    if (amountPaise <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    const id = newId('rec');
    const now = new Date().toISOString();
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const nextDueDate = req.body?.nextDueDate || getDatePartsInTz(new Date(), tz).localDate;
    await db.run(
      `INSERT INTO recurring_rules (id, user_id, title, merchant, amount_paise, type, category_id, payment_method, cadence, next_due_date, auto_create, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        req.user.id,
        title,
        merchant,
        amountPaise,
        req.body?.type === 'income' ? 'income' : 'expense',
        req.body?.categoryId || null,
        req.body?.paymentMethod || 'PhonePe UPI',
        ['daily', 'weekly', 'monthly', 'yearly'].includes(req.body?.cadence) ? req.body.cadence : 'monthly',
        nextDueDate,
        req.body?.autoCreate ? 1 : 0,
        now,
        now
      ]
    );
    const created = await db.get(`SELECT * FROM recurring_rules WHERE id = ?`, [id]);
    res.status(201).json({ rule: created });
  } catch (err) {
    next(err);
  }
});

router.post('/recurring/:id/record', async (req, res, next) => {
  try {
    const rule = await db.get(`SELECT * FROM recurring_rules WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (!rule) return res.status(404).json({ error: 'Recurring rule not found' });

    const txRes = await createTransaction({
      userId: req.user.id,
      userSettings: req.userSettings,
      req,
      payload: {
        amountPaise: rule.amount_paise,
        type: rule.type,
        merchant: rule.merchant,
        categoryId: rule.category_id,
        paymentMethod: rule.payment_method,
        localDate: rule.next_due_date,
        importSource: 'recurring',
        reconciliationStatus: 'verified',
        notes: `Recorded from recurring schedule: ${rule.title}`
      }
    });

    const nextDue = advanceDueDate(rule.next_due_date, rule.cadence);
    await db.run(
      `UPDATE recurring_rules SET last_matched_date = ?, next_due_date = ?, updated_at = ? WHERE id = ?`,
      [rule.next_due_date, nextDue, new Date().toISOString(), rule.id]
    );

    res.json({ ok: true, transaction: txRes.transaction, nextDueDate: nextDue });
  } catch (err) {
    next(err);
  }
});

router.delete('/recurring/:id', async (req, res, next) => {
  try {
    await db.run(`DELETE FROM recurring_rules WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- MERCHANT RULES ---
router.get('/rules', async (req, res, next) => {
  try {
    const rules = await db.query(
      `SELECT r.*, c.name AS category_name, c.color AS category_color
       FROM merchant_category_rules r
       JOIN categories c ON r.category_id = c.id
       WHERE r.user_id = ? ORDER BY r.priority ASC, r.created_at DESC`,
      [req.user.id]
    );
    res.json({ rules });
  } catch (err) {
    next(err);
  }
});

router.post('/rules', async (req, res, next) => {
  try {
    const pattern = String(req.body?.merchantPattern || '').trim();
    const categoryId = String(req.body?.categoryId || '').trim();
    if (!pattern || !categoryId) return res.status(400).json({ error: 'Pattern and category are required' });
    const id = newId('rul');
    await db.run(
      `INSERT INTO merchant_category_rules (id, user_id, merchant_pattern, match_type, category_id, priority, learned_from_correction, hit_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        id,
        req.user.id,
        pattern,
        ['contains', 'exact', 'regex'].includes(req.body?.matchType) ? req.body.matchType : 'contains',
        categoryId,
        Number(req.body?.priority || 10),
        new Date().toISOString()
      ]
    );
    res.status(201).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

router.delete('/rules/:id', async (req, res, next) => {
  try {
    await db.run(`DELETE FROM merchant_category_rules WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- INSIGHTS ---
router.get('/insights', async (req, res, next) => {
  try {
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const monthKey = req.query.monthKey || getDatePartsInTz(new Date(), tz).monthKey;
    const data = await generateInsights(req.user.id, { monthKey, timezone: tz });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
