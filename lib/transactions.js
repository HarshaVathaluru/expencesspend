const db = require('./db');
const { newId, sha256 } = require('./crypto');
const { toPaise, getDatePartsInTz, getPreviousMonthKey, shiftDate } = require('./money');
const { suggestCategory } = require('./ai');
const { recordAudit } = require('./audit');

function normalizeMerchant(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function computeFingerprint({ amountPaise, localDate, merchant, paymentMethod, referenceId }) {
  const normMerch = normalizeMerchant(merchant);
  const base = `${amountPaise}|${localDate}|${normMerch}|${String(paymentMethod || '').toLowerCase()}`;
  return sha256(referenceId ? `${base}|${referenceId}` : base).slice(0, 24);
}

async function detectDuplicate({ userId, importSource, externalId, amountPaise, localDate, merchant, paymentMethod, referenceId, excludeId = null }) {
  // 1. Check authoritative external source transaction ID first
  if (externalId) {
    const exact = await db.get(
      `SELECT id FROM transactions WHERE user_id = ? AND import_source = ? AND external_id = ?`,
      [userId, importSource, externalId]
    );
    if (exact && exact.id !== excludeId) {
      return { isExactDuplicate: true, duplicateOfId: exact.id, reason: 'Matched external transaction ID' };
    }
  }

  // 2. Cautious fingerprint match (same amount, date, normalized merchant)
  const fp = computeFingerprint({ amountPaise, localDate, merchant, paymentMethod, referenceId });
  const fpWithoutRef = computeFingerprint({ amountPaise, localDate, merchant, paymentMethod, referenceId: null });
  const candidates = await db.query(
    `SELECT id, merchant, reference_id, occurred_at FROM transactions
     WHERE user_id = ? AND amount_paise = ? AND local_date = ?`,
    [userId, amountPaise, localDate]
  );

  for (const c of candidates) {
    if (c.id === excludeId) continue;
    if (referenceId && c.reference_id && c.reference_id === referenceId) {
      return { isExactDuplicate: false, isPossibleDuplicate: true, duplicateOfId: c.id, fingerprint: fp, reason: 'Matched payment reference ID on same date and amount' };
    }
    if (normalizeMerchant(c.merchant) === normalizeMerchant(merchant)) {
      return { isExactDuplicate: false, isPossibleDuplicate: true, duplicateOfId: c.id, fingerprint: fpWithoutRef, reason: 'Same amount, date, and merchant' };
    }
  }
  return { isExactDuplicate: false, isPossibleDuplicate: false, duplicateOfId: null, fingerprint: fp };
}

async function createTransaction({ userId, userSettings, payload, req = null }) {
  const tz = userSettings?.timezone || 'Asia/Kolkata';
  const amountPaise = payload.amountPaise !== undefined ? Number(payload.amountPaise) : toPaise(String(payload.amount));
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new Error('Invalid transaction amount');
  }

  const occurredAt = payload.occurredAt ? new Date(payload.occurredAt).toISOString() : new Date().toISOString();
  const localDate = payload.localDate && /^\d{4}-\d{2}-\d{2}$/.test(payload.localDate)
    ? payload.localDate
    : getDatePartsInTz(occurredAt, tz).localDate;

  const merchant = String(payload.merchant || '').trim();
  if (!merchant) throw new Error('Merchant / payee is required');

  const type = ['expense', 'income', 'transfer', 'refund'].includes(payload.type) ? payload.type : 'expense';
  const paymentMethod = payload.paymentMethod || 'PhonePe UPI';
  const importSource = payload.importSource || 'manual';

  let categoryId = payload.categoryId || null;
  let confidence = payload.confidence || 'high';
  if (!categoryId && !payload.isSplit) {
    const sug = await suggestCategory({
      userId,
      merchant,
      description: payload.description || payload.notes || '',
      type,
      paymentMethod
    });
    categoryId = sug.categoryId;
    if (!payload.confidence) confidence = sug.confidence;
  }

  const dup = await detectDuplicate({
    userId,
    importSource,
    externalId: payload.externalId || null,
    amountPaise,
    localDate,
    merchant,
    paymentMethod,
    referenceId: payload.referenceId || null
  });

  if (dup.isExactDuplicate && payload.skipExactDuplicate) {
    return { skipped: true, reason: dup.reason, existingId: dup.duplicateOfId };
  }

  const reconciliationStatus = payload.reconciliationStatus
    || (dup.isPossibleDuplicate ? 'possible_duplicate' : importSource === 'manual' ? 'verified' : 'captured');

  const txId = newId('tx');
  const now = new Date().toISOString();
  const splits = Array.isArray(payload.splits) ? payload.splits : [];
  const isSplit = splits.length > 1 ? 1 : 0;

  if (isSplit) {
    let splitSum = 0;
    for (const s of splits) {
      const sp = s.amountPaise !== undefined ? Number(s.amountPaise) : toPaise(String(s.amount));
      splitSum += sp;
    }
    if (splitSum !== amountPaise) {
      throw new Error(`Split amounts (${splitSum} paise) must equal total transaction amount (${amountPaise} paise)`);
    }
  }

  await db.withTransaction(async (txDb) => {
    await txDb.run(
      `INSERT INTO transactions (
        id, user_id, amount_paise, type, occurred_at, local_date, merchant, description,
        category_id, subcategory, payment_method, source_account_id, reference_id,
        notes, tags_json, receipt_path, import_source, import_timestamp, external_id,
        fingerprint, confidence, reconciliation_status, duplicate_of_id, is_split, is_demo,
        batch_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        txId,
        userId,
        amountPaise,
        type,
        occurredAt,
        localDate,
        merchant,
        String(payload.description || ''),
        isSplit ? null : categoryId,
        String(payload.subcategory || ''),
        paymentMethod,
        payload.sourceAccountId || null,
        payload.referenceId ? String(payload.referenceId).slice(0, 64) : null,
        String(payload.notes || ''),
        JSON.stringify(Array.isArray(payload.tags) ? payload.tags.slice(0, 12) : []),
        payload.receiptPath || null,
        importSource,
        importSource === 'manual' ? null : now,
        payload.externalId || null,
        dup.fingerprint,
        confidence,
        reconciliationStatus,
        dup.duplicateOfId || null,
        isSplit,
        payload.isDemo ? 1 : 0,
        payload.batchId || null,
        now,
        now
      ]
    );

    if (isSplit) {
      for (const s of splits) {
        const sp = s.amountPaise !== undefined ? Number(s.amountPaise) : toPaise(String(s.amount));
        await txDb.run(
          `INSERT INTO transaction_splits (id, transaction_id, user_id, category_id, amount_paise, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [newId('spl'), txId, userId, s.categoryId || null, sp, String(s.note || '')]
        );
      }
    }
  });

  await recordAudit({
    userId,
    action: 'transaction.created',
    resourceType: 'transaction',
    resourceId: txId,
    req,
    metadata: { type, amountPaise, importSource, isSplit: Boolean(isSplit) }
  });

  if (type === 'expense' && !payload.skipBudgetAlert) {
    const { checkAndSendBudgetExceededAlert } = require('./brevo');
    await checkAndSendBudgetExceededAlert({
      userId,
      monthKey: localDate.slice(0, 7),
      categoryId,
      triggerMerchant: merchant,
      triggerAmountPaise: amountPaise,
      timezone: tz
    });
  }

  const created = await getTransactionById(userId, txId);
  return { skipped: false, transaction: created, duplicateWarning: dup.isPossibleDuplicate ? dup.reason : null };
}

async function getTransactionById(userId, txId) {
  const row = await db.get(
    `SELECT t.*, c.name AS category_name, c.slug AS category_slug, c.color AS category_color, c.icon_path AS category_icon
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.id = ? AND t.user_id = ?`,
    [txId, userId]
  );
  if (!row) return null;
  let splits = [];
  if (row.is_split) {
    splits = await db.query(
      `SELECT ts.*, c.name AS category_name, c.slug AS category_slug, c.color AS category_color
       FROM transaction_splits ts
       LEFT JOIN categories c ON ts.category_id = c.id
       WHERE ts.transaction_id = ? AND ts.user_id = ?`,
      [txId, userId]
    );
  }
  return {
    ...row,
    tags: safeParseJson(row.tags_json, []),
    splits
  };
}

function safeParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

async function listTransactions(userId, filters = {}) {
  const where = ['t.user_id = ?'];
  const params = [userId];

  if (filters.startDate) {
    where.push('t.local_date >= ?');
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    where.push('t.local_date <= ?');
    params.push(filters.endDate);
  }
  if (filters.type) {
    where.push('t.type = ?');
    params.push(filters.type);
  }
  if (filters.categoryId) {
    where.push('(t.category_id = ? OR EXISTS (SELECT 1 FROM transaction_splits ts WHERE ts.transaction_id = t.id AND ts.category_id = ?))');
    params.push(filters.categoryId, filters.categoryId);
  }
  if (filters.paymentMethod) {
    where.push('t.payment_method = ?');
    params.push(filters.paymentMethod);
  }
  if (filters.importSource) {
    where.push('t.import_source = ?');
    params.push(filters.importSource);
  }
  if (filters.reconciliationStatus) {
    where.push('t.reconciliation_status = ?');
    params.push(filters.reconciliationStatus);
  }
  if (filters.minPaise !== undefined && filters.minPaise !== null && filters.minPaise !== '') {
    where.push('t.amount_paise >= ?');
    params.push(Number(filters.minPaise));
  }
  if (filters.maxPaise !== undefined && filters.maxPaise !== null && filters.maxPaise !== '') {
    where.push('t.amount_paise <= ?');
    params.push(Number(filters.maxPaise));
  }
  if (filters.q) {
    const qLike = `%${String(filters.q).trim().toLowerCase()}%`;
    where.push('(LOWER(t.merchant) LIKE ? OR LOWER(t.description) LIKE ? OR LOWER(t.notes) LIKE ? OR LOWER(t.tags_json) LIKE ?)');
    params.push(qLike, qLike, qLike, qLike);
  }

  const sortCol = {
    date: 't.local_date',
    amount: 't.amount_paise',
    merchant: 't.merchant'
  }[filters.sortBy] || 't.local_date';
  const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

  const page = Math.max(1, Number(filters.page || 1));
  const limit = Math.min(200, Math.max(1, Number(filters.limit || 25)));
  const offset = (page - 1) * limit;

  const whereSql = where.join(' AND ');
  const countRow = await db.get(`SELECT COUNT(*) AS cnt FROM transactions t WHERE ${whereSql}`, params);
  const rows = await db.query(
    `SELECT t.*, c.name AS category_name, c.slug AS category_slug, c.color AS category_color, c.icon_path AS category_icon
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE ${whereSql}
     ORDER BY ${sortCol} ${sortDir}, t.occurred_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // Batch fetch splits to avoid N+1 queries
  const splitTxIds = rows.filter((r) => r.is_split).map((r) => r.id);
  const splitsByTx = new Map();
  if (splitTxIds.length > 0) {
    const placeholders = splitTxIds.map(() => '?').join(',');
    const splitRows = await db.query(
      `SELECT ts.*, c.name AS category_name, c.slug AS category_slug, c.color AS category_color
       FROM transaction_splits ts
       LEFT JOIN categories c ON ts.category_id = c.id
       WHERE ts.transaction_id IN (${placeholders}) AND ts.user_id = ?`,
      [...splitTxIds, userId]
    );
    for (const s of splitRows) {
      if (!splitsByTx.has(s.transaction_id)) splitsByTx.set(s.transaction_id, []);
      splitsByTx.get(s.transaction_id).push(s);
    }
  }

  return {
    total: Number(countRow?.cnt || 0),
    page,
    limit,
    items: rows.map((r) => ({
      ...r,
      tags: safeParseJson(r.tags_json, []),
      splits: splitsByTx.get(r.id) || []
    }))
  };
}

async function updateTransaction({ userId, txId, payload, userSettings, req = null }) {
  const existing = await getTransactionById(userId, txId);
  if (!existing) {
    const err = new Error('Transaction not found');
    err.statusCode = 404;
    throw err;
  }

  const tz = userSettings?.timezone || 'Asia/Kolkata';
  const amountPaise = payload.amountPaise !== undefined
    ? Number(payload.amountPaise)
    : payload.amount !== undefined
    ? toPaise(String(payload.amount))
    : existing.amount_paise;

  const occurredAt = payload.occurredAt ? new Date(payload.occurredAt).toISOString() : existing.occurred_at;
  const localDate = payload.localDate && /^\d{4}-\d{2}-\d{2}$/.test(payload.localDate)
    ? payload.localDate
    : payload.occurredAt
    ? getDatePartsInTz(occurredAt, tz).localDate
    : existing.local_date;

  const type = payload.type || existing.type;
  const merchant = payload.merchant !== undefined ? String(payload.merchant).trim() : existing.merchant;
  const categoryId = payload.categoryId !== undefined ? payload.categoryId : existing.category_id;
  const paymentMethod = payload.paymentMethod || existing.payment_method;
  const reconciliationStatus = payload.reconciliationStatus || existing.reconciliation_status;
  const now = new Date().toISOString();

  const splits = Array.isArray(payload.splits) ? payload.splits : null;
  const isSplit = splits ? (splits.length > 1 ? 1 : 0) : existing.is_split;

  if (splits && splits.length > 1) {
    let sum = 0;
    for (const s of splits) sum += s.amountPaise !== undefined ? Number(s.amountPaise) : toPaise(String(s.amount));
    if (sum !== amountPaise) throw new Error('Split amounts must equal total transaction amount');
  }

  await db.withTransaction(async (txDb) => {
    await txDb.run(
      `UPDATE transactions SET
        amount_paise = ?, type = ?, occurred_at = ?, local_date = ?, merchant = ?,
        description = ?, category_id = ?, subcategory = ?, payment_method = ?,
        reference_id = ?, notes = ?, tags_json = ?, reconciliation_status = ?,
        is_split = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [
        amountPaise,
        type,
        occurredAt,
        localDate,
        merchant,
        payload.description !== undefined ? String(payload.description) : existing.description,
        isSplit ? null : categoryId,
        payload.subcategory !== undefined ? String(payload.subcategory) : existing.subcategory,
        paymentMethod,
        payload.referenceId !== undefined ? payload.referenceId : existing.reference_id,
        payload.notes !== undefined ? String(payload.notes) : existing.notes,
        payload.tags !== undefined ? JSON.stringify(payload.tags) : existing.tags_json,
        reconciliationStatus,
        isSplit,
        now,
        txId,
        userId
      ]
    );

    if (splits) {
      await txDb.run(`DELETE FROM transaction_splits WHERE transaction_id = ? AND user_id = ?`, [txId, userId]);
      if (splits.length > 1) {
        for (const s of splits) {
          const sp = s.amountPaise !== undefined ? Number(s.amountPaise) : toPaise(String(s.amount));
          await txDb.run(
            `INSERT INTO transaction_splits (id, transaction_id, user_id, category_id, amount_paise, note)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [newId('spl'), txId, userId, s.categoryId || null, sp, String(s.note || '')]
          );
        }
      }
    }
  });

  // Learn merchant-to-category rule if user explicitly corrected category
  if (payload.learnRule && categoryId && categoryId !== existing.category_id && merchant) {
    const existingRule = await db.get(
      `SELECT id FROM merchant_category_rules WHERE user_id = ? AND LOWER(merchant_pattern) = ?`,
      [userId, merchant.toLowerCase()]
    );
    if (existingRule) {
      await db.run(
        `UPDATE merchant_category_rules SET category_id = ?, learned_from_correction = 1 WHERE id = ?`,
        [categoryId, existingRule.id]
      );
    } else {
      await db.run(
        `INSERT INTO merchant_category_rules (id, user_id, merchant_pattern, match_type, category_id, priority, learned_from_correction, hit_count, created_at)
         VALUES (?, ?, ?, 'contains', ?, 5, 1, 1, ?)`,
        [newId('rul'), userId, merchant, categoryId, now]
      );
    }
  }

  await recordAudit({
    userId,
    action: 'transaction.updated',
    resourceType: 'transaction',
    resourceId: txId,
    req
  });

  if (type === 'expense' && !payload.skipBudgetAlert) {
    const { checkAndSendBudgetExceededAlert } = require('./brevo');
    await checkAndSendBudgetExceededAlert({
      userId,
      monthKey: localDate.slice(0, 7),
      categoryId,
      triggerMerchant: merchant,
      triggerAmountPaise: amountPaise,
      timezone: tz
    });
  }

  return getTransactionById(userId, txId);
}

async function deleteTransaction({ userId, txId, req = null }) {
  const existing = await db.get(`SELECT id FROM transactions WHERE id = ? AND user_id = ?`, [txId, userId]);
  if (!existing) {
    const err = new Error('Transaction not found');
    err.statusCode = 404;
    throw err;
  }
  await db.run(`DELETE FROM transactions WHERE id = ? AND user_id = ?`, [txId, userId]);
  await recordAudit({
    userId,
    action: 'transaction.deleted',
    resourceType: 'transaction',
    resourceId: txId,
    req
  });
  return true;
}

/**
 * Compute authoritative dashboard & reporting summary directly from persisted transactions.
 * Handles splits, refunds (netted against expenses, not treated as fresh income), and transfers (excluded from spending/income).
 */
async function getAnalyticsSummary(userId, { startDate, endDate, timezone = 'Asia/Kolkata', monthKey = null }) {
  const nowParts = getDatePartsInTz(new Date(), timezone);
  const activeMonth = monthKey || (startDate ? startDate.slice(0, 7) : nowParts.monthKey);
  const prevMonth = getPreviousMonthKey(activeMonth);

  const rangeStart = startDate || `${activeMonth}-01`;
  const rangeEnd = endDate || `${activeMonth}-31`;

  const txs = await db.query(
    `SELECT t.*, c.name AS category_name, c.slug AS category_slug, c.color AS category_color, c.icon_path AS category_icon
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? AND t.local_date >= ? AND t.local_date <= ?`,
    [userId, rangeStart, rangeEnd]
  );

  // Batch load splits
  const splitIds = txs.filter((t) => t.is_split).map((t) => t.id);
  const splitsMap = new Map();
  if (splitIds.length > 0) {
    const ph = splitIds.map(() => '?').join(',');
    const srows = await db.query(
      `SELECT ts.*, c.name AS category_name, c.slug AS category_slug, c.color AS category_color, c.icon_path AS category_icon
       FROM transaction_splits ts
       LEFT JOIN categories c ON ts.category_id = c.id
       WHERE ts.transaction_id IN (${ph}) AND ts.user_id = ?`,
      [...splitIds, userId]
    );
    for (const sr of srows) {
      if (!splitsMap.has(sr.transaction_id)) splitsMap.set(sr.transaction_id, []);
      splitsMap.get(sr.transaction_id).push(sr);
    }
  }

  let grossExpensePaise = 0;
  let refundPaise = 0;
  let incomePaise = 0;
  let transferPaise = 0;

  const categoryMap = new Map();
  const dailyMap = new Map();
  const methodMap = new Map();
  const merchantMap = new Map();
  const reconciliationCounts = { verified: 0, captured: 0, needs_review: 0, possible_duplicate: 0 };
  const sourceCounts = { manual: 0, imported: 0 };
  let uncategorizedCount = 0;
  let demoCount = 0;

  for (const t of txs) {
    if (t.is_demo) demoCount++;
    if (reconciliationCounts[t.reconciliation_status] !== undefined) {
      reconciliationCounts[t.reconciliation_status]++;
    }
    if (t.import_source === 'manual') sourceCounts.manual++;
    else sourceCounts.imported++;

    if (t.type === 'transfer') {
      transferPaise += t.amount_paise;
      continue;
    }
    if (t.type === 'income') {
      incomePaise += t.amount_paise;
      continue;
    }
    if (t.type === 'refund') {
      refundPaise += t.amount_paise;
      continue;
    }

    // Expense
    grossExpensePaise += t.amount_paise;

    // Daily trend
    dailyMap.set(t.local_date, (dailyMap.get(t.local_date) || 0) + t.amount_paise);

    // Payment method
    methodMap.set(t.payment_method, (methodMap.get(t.payment_method) || 0) + t.amount_paise);

    // Merchant
    const mKey = t.merchant || 'Unknown';
    const prevM = merchantMap.get(mKey) || { merchant: mKey, totalPaise: 0, count: 0 };
    prevM.totalPaise += t.amount_paise;
    prevM.count += 1;
    merchantMap.set(mKey, prevM);

    // Category breakdown (handles split transactions accurately)
    if (t.is_split && splitsMap.has(t.id)) {
      for (const s of splitsMap.get(t.id)) {
        const key = s.category_id || 'uncategorized';
        if (s.category_slug === 'uncategorized' || !s.category_id) uncategorizedCount++;
        const prevC = categoryMap.get(key) || {
          categoryId: s.category_id,
          slug: s.category_slug || 'uncategorized',
          name: s.category_name || 'Uncategorized',
          color: s.category_color || '#64748B',
          iconPath: s.category_icon || '/images/categories/uncategorized.svg',
          totalPaise: 0,
          count: 0
        };
        prevC.totalPaise += s.amount_paise;
        prevC.count += 1;
        categoryMap.set(key, prevC);
      }
    } else {
      const key = t.category_id || 'uncategorized';
      if (t.category_slug === 'uncategorized' || !t.category_id) uncategorizedCount++;
      const prevC = categoryMap.get(key) || {
        categoryId: t.category_id,
        slug: t.category_slug || 'uncategorized',
        name: t.category_name || 'Uncategorized',
        color: t.category_color || '#64748B',
        iconPath: t.category_icon || '/images/categories/uncategorized.svg',
        totalPaise: 0,
        count: 0
      };
      prevC.totalPaise += t.amount_paise;
      prevC.count += 1;
      categoryMap.set(key, prevC);
    }
  }

  const netSpentPaise = Math.max(0, grossExpensePaise - refundPaise);
  const netCashFlowPaise = incomePaise - netSpentPaise;

  // Previous month comparison
  const prevTxs = await db.query(
    `SELECT amount_paise, type FROM transactions WHERE user_id = ? AND local_date >= ? AND local_date <= ?`,
    [userId, `${prevMonth}-01`, `${prevMonth}-31`]
  );
  let prevGross = 0;
  let prevRefund = 0;
  for (const pt of prevTxs) {
    if (pt.type === 'expense') prevGross += pt.amount_paise;
    else if (pt.type === 'refund') prevRefund += pt.amount_paise;
  }
  const prevMonthSpentPaise = Math.max(0, prevGross - prevRefund);
  const deltaPaise = netSpentPaise - prevMonthSpentPaise;
  const deltaPercent = prevMonthSpentPaise > 0
    ? Math.round((deltaPaise / prevMonthSpentPaise) * 1000) / 10
    : (netSpentPaise > 0 ? 100 : 0);

  // Today & this week quick stats (relative to user's timezone today)
  const todayDate = nowParts.localDate;
  const weekStart = shiftDate(todayDate, -6);
  const quickRows = await db.query(
    `SELECT amount_paise, type, local_date FROM transactions WHERE user_id = ? AND local_date >= ? AND local_date <= ?`,
    [userId, weekStart, todayDate]
  );
  let todaySpentPaise = 0;
  let weekSpentPaise = 0;
  for (const qr of quickRows) {
    if (qr.type === 'expense') {
      weekSpentPaise += qr.amount_paise;
      if (qr.local_date === todayDate) todaySpentPaise += qr.amount_paise;
    } else if (qr.type === 'refund') {
      weekSpentPaise = Math.max(0, weekSpentPaise - qr.amount_paise);
      if (qr.local_date === todayDate) todaySpentPaise = Math.max(0, todaySpentPaise - qr.amount_paise);
    }
  }

  // Budget for active month (fallback to 'default' template if month-specific not set)
  let budget = await db.get(`SELECT * FROM budgets WHERE user_id = ? AND month_key = ?`, [userId, activeMonth]);
  if (!budget) {
    budget = await db.get(`SELECT * FROM budgets WHERE user_id = ? AND month_key = 'default'`, [userId]);
  }
  const overallBudgetPaise = budget ? Number(budget.overall_limit_paise || 0) : 0;
  const budgetRemainingPaise = overallBudgetPaise > 0 ? overallBudgetPaise - netSpentPaise : 0;
  const budgetUsedPercent = overallBudgetPaise > 0 ? Math.round((netSpentPaise / overallBudgetPaise) * 1000) / 10 : 0;

  // Upcoming recurring bills
  const recurringRows = await db.query(
    `SELECT r.*, c.name AS category_name FROM recurring_rules r
     LEFT JOIN categories c ON r.category_id = c.id
     WHERE r.user_id = ? AND r.is_active = 1
     ORDER BY r.next_due_date ASC LIMIT 6`,
    [userId]
  );

  // Largest transactions
  const largestTransactions = txs
    .filter((t) => t.type === 'expense')
    .sort((a, b) => b.amount_paise - a.amount_paise)
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      merchant: t.merchant,
      amount_paise: t.amount_paise,
      local_date: t.local_date,
      category_name: t.category_name || 'Uncategorized',
      payment_method: t.payment_method
    }));

  const categories = Array.from(categoryMap.values())
    .sort((a, b) => b.totalPaise - a.totalPaise)
    .map((c) => ({
      ...c,
      sharePercent: grossExpensePaise > 0 ? Math.round((c.totalPaise / grossExpensePaise) * 1000) / 10 : 0
    }));

  const dailyTrend = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, totalPaise]) => ({ date, totalPaise }));

  const paymentMethods = Array.from(methodMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([method, totalPaise]) => ({ method, totalPaise }));

  const topMerchants = Array.from(merchantMap.values())
    .sort((a, b) => b.totalPaise - a.totalPaise)
    .slice(0, 8);

  const latestEmailLog = await db.get(
    `SELECT status, failure_reason, created_at FROM email_delivery_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const latestEmailFailure = latestEmailLog && latestEmailLog.status === 'failed' ? latestEmailLog : null;

  return {
    monthKey: activeMonth,
    prevMonthKey: prevMonth,
    rangeStart,
    rangeEnd,
    todayDate,
    todaySpentPaise,
    weekSpentPaise,
    grossExpensePaise,
    refundPaise,
    netSpentPaise,
    incomePaise,
    transferPaise,
    netCashFlowPaise,
    prevMonthSpentPaise,
    deltaPaise,
    deltaPercent,
    overallBudgetPaise,
    budgetRemainingPaise,
    budgetUsedPercent,
    transactionCount: txs.length,
    uncategorizedCount,
    demoCount,
    reconciliationCounts,
    sourceCounts,
    categories,
    dailyTrend,
    paymentMethods,
    topMerchants,
    largestTransactions,
    upcomingRecurring: recurringRows,
    latestEmailFailure
  };
}

/**
 * Explicitly marked demo-only dataset (clearly labeled & removable via settings/dashboard).
 */
async function seedDemoTransactions(userId, userSettings) {
  const tz = userSettings?.timezone || 'Asia/Kolkata';
  const today = getDatePartsInTz(new Date(), tz).localDate;
  const cats = await db.query(`SELECT id, slug FROM categories WHERE user_id = ?`, [userId]);
  const catBySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));

  const samples = [
    { daysAgo: 0, amount: '425.00', type: 'expense', merchant: 'Swiggy', cat: 'food', method: 'PhonePe UPI', source: 'android_notification', status: 'captured', ref: 'PP-DEMO-901' },
    { daysAgo: 0, amount: '1280.00', type: 'expense', merchant: 'Blinkit Groceries', cat: 'groceries', method: 'PhonePe UPI', source: 'android_notification', status: 'verified', ref: 'PP-DEMO-902' },
    { daysAgo: 1, amount: '240.00', type: 'expense', merchant: 'Uber Auto', cat: 'transport', method: 'PhonePe UPI', source: 'android_notification', status: 'verified', ref: 'PP-DEMO-903' },
    { daysAgo: 2, amount: '649.00', type: 'expense', merchant: 'Netflix India', cat: 'subscriptions', method: 'Credit Card', source: 'email_receipt', status: 'verified', ref: 'EM-DEMO-904' },
    { daysAgo: 3, amount: '18500.00', type: 'expense', merchant: 'Koramangala Residency Rent', cat: 'rent', method: 'Bank Transfer', source: 'csv', status: 'verified', ref: 'NEFT-DEMO-905' },
    { daysAgo: 4, amount: '1450.00', type: 'expense', merchant: 'BESCOM Electricity', cat: 'utilities', method: 'PhonePe UPI', source: 'csv', status: 'verified', ref: 'BBPS-DEMO-906' },
    { daysAgo: 5, amount: '85000.00', type: 'income', merchant: 'Acme Tech Payroll', cat: 'income', method: 'Bank Transfer', source: 'csv', status: 'verified', ref: 'SAL-DEMO-907' },
    { daysAgo: 6, amount: '890.00', type: 'expense', merchant: 'Apollo Pharmacy', cat: 'health', method: 'PhonePe UPI', source: 'manual', status: 'verified', ref: 'MAN-DEMO-908' },
    { daysAgo: 7, amount: '2199.00', type: 'expense', merchant: 'Myntra Retail', cat: 'shopping', method: 'Credit Card', source: 'email_receipt', status: 'needs_review', ref: 'EM-DEMO-909' },
    { daysAgo: 7, amount: '350.00', type: 'refund', merchant: 'Myntra Partial Refund', cat: 'shopping', method: 'Credit Card', source: 'email_receipt', status: 'verified', ref: 'REF-DEMO-910' }
  ];

  let created = 0;
  for (const s of samples) {
    const res = await createTransaction({
      userId,
      userSettings,
      payload: {
        amount: s.amount,
        type: s.type,
        localDate: shiftDate(today, -s.daysAgo),
        occurredAt: new Date(Date.now() - s.daysAgo * 86400000).toISOString(),
        merchant: s.merchant,
        categoryId: catBySlug[s.cat] || null,
        paymentMethod: s.method,
        importSource: s.source,
        externalId: s.ref,
        referenceId: s.ref,
        reconciliationStatus: s.status,
        notes: 'Demo sample transaction (safe to clear anytime)',
        tags: ['demo'],
        isDemo: true,
        skipExactDuplicate: true,
        skipBudgetAlert: true
      }
    });
    if (!res.skipped) created++;
  }

  // Also ensure a default budget exists if user has none
  const monthKey = today.slice(0, 7);
  const existingBudget = await db.get(`SELECT id FROM budgets WHERE user_id = ? AND month_key = ?`, [userId, monthKey]);
  if (!existingBudget) {
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO budgets (id, user_id, month_key, overall_limit_paise, alert_thresholds_json, rollover_enabled, reset_day, created_at, updated_at)
       VALUES (?, ?, ?, 4500000, '[50,75,90,100]', 0, 1, ?, ?)`,
      [newId('bdg'), userId, monthKey, now, now]
    );
  }

  return { created };
}

async function clearDemoTransactions(userId) {
  const res = await db.run(`DELETE FROM transactions WHERE user_id = ? AND is_demo = 1`, [userId]);
  return { deleted: res.changes || 0 };
}

module.exports = {
  createTransaction,
  getTransactionById,
  listTransactions,
  updateTransaction,
  deleteTransaction,
  getAnalyticsSummary,
  seedDemoTransactions,
  clearDemoTransactions,
  computeFingerprint,
  detectDuplicate
};
