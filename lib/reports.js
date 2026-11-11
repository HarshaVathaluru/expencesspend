const PDFDocument = require('pdfkit');
const db = require('./db');
const { formatINR } = require('./money');
const { getAnalyticsSummary } = require('./transactions');

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function generateTransactionsCsv(userId, { startDate, endDate }) {
  const rows = await db.query(
    `SELECT t.local_date, t.occurred_at, t.type, t.merchant, t.amount_paise, c.name AS category_name,
            t.payment_method, t.import_source, t.reconciliation_status, t.confidence, t.notes, t.tags_json
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? AND t.local_date >= ? AND t.local_date <= ?
     ORDER BY t.local_date DESC, t.occurred_at DESC`,
    [userId, startDate, endDate]
  );

  const header = [
    'Date',
    'TimestampUTC',
    'Type',
    'Merchant',
    'AmountINR',
    'Category',
    'PaymentMethod',
    'ImportSource',
    'ReconciliationStatus',
    'Confidence',
    'Notes',
    'Tags'
  ].join(',');

  const lines = rows.map((r) => [
    r.local_date,
    r.occurred_at,
    r.type,
    r.merchant,
    (r.amount_paise / 100).toFixed(2),
    r.category_name || 'Uncategorized',
    r.payment_method,
    r.import_source,
    r.reconciliation_status,
    r.confidence,
    r.notes || '',
    r.tags_json || '[]'
  ].map(csvEscape).join(','));

  return [header, ...lines].join('\n');
}

async function generateMonthlyStatementPdfBuffer(userId, { monthKey, startDate, endDate, timezone = 'Asia/Kolkata', locale = 'en-IN', currency = 'INR' }) {
  const user = await db.get(`SELECT name, email FROM users WHERE id = ?`, [userId]);
  const summary = await getAnalyticsSummary(userId, { startDate, endDate, monthKey, timezone });
  const txs = await db.query(
    `SELECT t.local_date, t.type, t.merchant, t.amount_paise, t.payment_method, t.reconciliation_status, c.name AS category_name
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? AND t.local_date >= ? AND t.local_date <= ?
     ORDER BY t.local_date DESC LIMIT 200`,
    [userId, summary.rangeStart, summary.rangeEnd]
  );

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmt = (p) => formatINR(p, locale, currency).replace('₹', 'INR ');

    doc.fontSize(20).fillColor('#0F172A').text('PaisaPilot Monthly Financial Statement');
    doc.fontSize(10).fillColor('#475569').text(`Account: ${user?.name || ''} (${user?.email || ''})`);
    doc.text(`Period: ${summary.rangeStart} to ${summary.rangeEnd}  |  Timezone: ${timezone}`);
    doc.moveDown(1);

    doc.fontSize(12).fillColor('#0F172A').text('Overview');
    doc.fontSize(10).fillColor('#334155');
    doc.text(`Total Net Spent: ${fmt(summary.netSpentPaise)}   |   Income: ${fmt(summary.incomePaise)}   |   Net Cash Flow: ${fmt(summary.netCashFlowPaise)}`);
    doc.text(`Previous Month (${summary.prevMonthKey}) Spent: ${fmt(summary.prevMonthSpentPaise)}   |   Change: ${summary.deltaPercent}%`);
    doc.text(`Transactions: ${summary.transactionCount}   |   Verified: ${summary.reconciliationCounts.verified}   |   Needs Review: ${summary.reconciliationCounts.needs_review}`);
    doc.moveDown(1);

    doc.fontSize(12).fillColor('#0F172A').text('Category Breakdown');
    doc.fontSize(9.5).fillColor('#334155');
    if (summary.categories.length === 0) {
      doc.text('No expenses recorded in this period.');
    } else {
      for (const c of summary.categories) {
        doc.text(`• ${c.name}: ${fmt(c.totalPaise)} (${c.sharePercent}%, ${c.count} txns)`);
      }
    }
    doc.moveDown(1);

    doc.fontSize(12).fillColor('#0F172A').text('Transactions (up to 200 most recent)');
    doc.fontSize(8.5).fillColor('#334155');
    for (const t of txs) {
      doc.text(`${t.local_date}  |  ${t.type.toUpperCase()}  |  ${t.merchant}  |  ${fmt(t.amount_paise)}  |  ${t.category_name || 'Uncategorized'}  |  ${t.payment_method}`);
    }

    doc.end();
  });
}

async function exportAllUserDataJson(userId) {
  const user = await db.get(`SELECT id, email, name, created_at FROM users WHERE id = ?`, [userId]);
  const settings = await db.get(`SELECT * FROM user_settings WHERE user_id = ?`, [userId]);
  if (settings) delete settings.email_verification_code;
  const categories = await db.query(`SELECT * FROM categories WHERE user_id = ?`, [userId]);
  const transactions = await db.query(`SELECT * FROM transactions WHERE user_id = ? ORDER BY local_date DESC`, [userId]);
  const budgets = await db.query(`SELECT * FROM budgets WHERE user_id = ?`, [userId]);
  const goals = await db.query(`SELECT * FROM savings_goals WHERE user_id = ?`, [userId]);
  const recurring = await db.query(`SELECT * FROM recurring_rules WHERE user_id = ?`, [userId]);
  const rules = await db.query(`SELECT * FROM merchant_category_rules WHERE user_id = ?`, [userId]);

  return {
    exportedAt: new Date().toISOString(),
    user,
    settings,
    categories,
    transactions,
    budgets,
    savingsGoals: goals,
    recurringRules: recurring,
    merchantRules: rules
  };
}

module.exports = {
  generateTransactionsCsv,
  generateMonthlyStatementPdfBuffer,
  exportAllUserDataJson
};
