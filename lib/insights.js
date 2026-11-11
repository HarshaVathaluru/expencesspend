const db = require('./db');
const { formatINR, getPreviousMonthKey } = require('./money');
const { getAnalyticsSummary } = require('./transactions');

async function generateInsights(userId, { monthKey, timezone = 'Asia/Kolkata' }) {
  const current = await getAnalyticsSummary(userId, { monthKey, timezone });
  const prevMonthKey = getPreviousMonthKey(current.monthKey);
  const prev = await getAnalyticsSummary(userId, { monthKey: prevMonthKey, timezone });

  const insights = [];

  // 1. Budget threshold alerts
  if (current.overallBudgetPaise > 0) {
    const pct = current.budgetUsedPercent;
    const budgetRow = await db.get(
      `SELECT alert_thresholds_json FROM budgets WHERE user_id = ? AND (month_key = ? OR month_key = 'default') ORDER BY CASE WHEN month_key = ? THEN 0 ELSE 1 END LIMIT 1`,
      [userId, current.monthKey, current.monthKey]
    );
    let thresholds = [50, 75, 90, 100];
    try { if (budgetRow?.alert_thresholds_json) thresholds = JSON.parse(budgetRow.alert_thresholds_json); } catch {}
    const crossed = thresholds.filter((t) => pct >= t).sort((a, b) => b - a);
    if (crossed.length > 0) {
      const topT = crossed[0];
      insights.push({
        id: `budget_${topT}`,
        kind: pct >= 100 ? 'warning' : pct >= 75 ? 'attention' : 'info',
        title: `Monthly budget reached ${pct}% (${topT}% threshold)`,
        detail: `You have recorded ${formatINR(current.netSpentPaise)} out of your ${formatINR(current.overallBudgetPaise)} budget for ${current.monthKey}.`,
        window: current.monthKey,
        transactionCount: current.transactionCount
      });
    }
  }

  // 2. Category spikes vs previous month
  const prevCatMap = new Map(prev.categories.map((c) => [c.slug, c]));
  for (const cat of current.categories) {
    const p = prevCatMap.get(cat.slug);
    const prevPaise = p ? p.totalPaise : 0;
    const diff = cat.totalPaise - prevPaise;
    if (prevPaise > 0 && diff >= 50000 && cat.totalPaise >= prevPaise * 1.3) {
      const pctRise = Math.round((diff / prevPaise) * 100);
      insights.push({
        id: `spike_${cat.slug}`,
        kind: 'attention',
        title: `${cat.name} is up ${pctRise}% vs ${prevMonthKey}`,
        detail: `${formatINR(cat.totalPaise)} across ${cat.count} transactions in ${current.monthKey} compared to ${formatINR(prevPaise)} in ${prevMonthKey}.`,
        window: `${prevMonthKey} vs ${current.monthKey}`,
        categorySlug: cat.slug
      });
    }
  }

  // 3. Unusual large transactions (> 2x median expense)
  const monthTxs = await db.query(
    `SELECT id, merchant, amount_paise, local_date, payment_method FROM transactions
     WHERE user_id = ? AND type = 'expense' AND local_date >= ? AND local_date <= ?
     ORDER BY amount_paise ASC`,
    [userId, `${current.monthKey}-01`, `${current.monthKey}-31`]
  );
  if (monthTxs.length >= 4) {
    const mid = Math.floor(monthTxs.length / 2);
    const medianPaise = monthTxs[mid].amount_paise;
    const threshold = Math.max(medianPaise * 2.5, 100000); // at least ₹1,000
    const unusual = monthTxs.filter((t) => t.amount_paise > threshold).slice(-3).reverse();
    for (const u of unusual) {
      insights.push({
        id: `unusual_${u.id}`,
        kind: 'info',
        title: `Larger-than-usual expense at ${u.merchant}`,
        detail: `${formatINR(u.amount_paise)} on ${u.local_date} via ${u.payment_method} (your median expense this month is ${formatINR(medianPaise)}).`,
        window: current.monthKey,
        transactionIds: [u.id]
      });
    }
  }

  // 4. Duplicate & uncategorized reminders
  if (current.reconciliationCounts.possible_duplicate > 0) {
    insights.push({
      id: 'dup_alert',
      kind: 'warning',
      title: `${current.reconciliationCounts.possible_duplicate} possible duplicate(s) flagged`,
      detail: `Review flagged records in the Reconciliation Center to confirm whether they are separate payments or duplicates.`,
      window: current.monthKey
    });
  }

  if (current.uncategorizedCount > 0) {
    insights.push({
      id: 'uncat_alert',
      kind: 'info',
      title: `${current.uncategorizedCount} uncategorized transaction(s)`,
      detail: `Categorizing these items keeps your 3D breakdown and daily 11:00 PM digest accurate.`,
      window: current.monthKey
    });
  }

  // 5. Subscription / recurring candidate detector
  const recurringCandidates = await db.query(
    `SELECT merchant, COUNT(*) AS cnt, MAX(amount_paise) AS amt
     FROM transactions
     WHERE user_id = ? AND type = 'expense'
     GROUP BY LOWER(merchant)
     HAVING COUNT(*) >= 2
     ORDER BY cnt DESC LIMIT 5`,
    [userId]
  );

  return {
    monthKey: current.monthKey,
    prevMonthKey,
    insights,
    recurringCandidates
  };
}

module.exports = { generateInsights };
