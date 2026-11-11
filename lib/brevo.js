const db = require('./db');
const { newId } = require('./crypto');
const { formatINR, getDatePartsInTz, shiftDate } = require('./money');
const { getAnalyticsSummary } = require('./transactions');
const { generateInsights } = require('./insights');
const logger = require('./logger');

function isBrevoConfigured() {
  const key = (process.env.BREVO_API_KEY || '').trim();
  const sender = (process.env.BREVO_SENDER_EMAIL || '').trim();
  return Boolean(key && key !== 'YOUR_BREVO_API_KEY' && sender && sender !== 'verified-sender@example.com');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function buildDailySummaryData(userId, localDate, timezone = 'Asia/Kolkata', windowDays = 4) {
  const settings = await db.get(`SELECT * FROM user_settings WHERE user_id = ?`, [userId]);
  const user = await db.get(`SELECT id, name, email FROM users WHERE id = ?`, [userId]);
  const locale = settings?.locale || 'en-IN';
  const currency = settings?.currency || 'INR';
  const days = Math.max(1, Number(windowDays) || 4);
  const startDate = shiftDate(localDate, -(days - 1));
  const monthKey = localDate.slice(0, 7);

  const dayTxs = await db.query(
    `SELECT t.id, t.amount_paise, t.type, t.merchant, t.payment_method, t.local_date, t.reconciliation_status,
            c.name AS category_name, c.slug AS category_slug
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? AND t.local_date >= ? AND t.local_date <= ?`,
    [userId, startDate, localDate]
  );

  let spentPaise = 0;
  let refundPaise = 0;
  let incomePaise = 0;
  const catMap = new Map();
  const merchMap = new Map();
  let largestExpense = null;
  let uncategorizedOrReview = 0;

  for (const t of dayTxs) {
    if (t.reconciliation_status === 'needs_review' || t.reconciliation_status === 'possible_duplicate' || t.category_slug === 'uncategorized') {
      uncategorizedOrReview++;
    }
    if (t.type === 'transfer') continue;
    if (t.type === 'income') {
      incomePaise += t.amount_paise;
      continue;
    }
    if (t.type === 'refund') {
      refundPaise += t.amount_paise;
      continue;
    }
    spentPaise += t.amount_paise;
    const catName = t.category_name || 'Uncategorized';
    catMap.set(catName, (catMap.get(catName) || 0) + t.amount_paise);
    merchMap.set(t.merchant, (merchMap.get(t.merchant) || 0) + t.amount_paise);
    if (!largestExpense || t.amount_paise > largestExpense.amountPaise) {
      largestExpense = { merchant: t.merchant, amountPaise: t.amount_paise, paymentMethod: t.payment_method };
    }
  }

  const netSpentTodayPaise = Math.max(0, spentPaise - refundPaise);
  const netFlowPaise = incomePaise - netSpentTodayPaise;
  const categoryTotals = Array.from(catMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, totalPaise]) => ({ name, totalPaise }));
  const topMerchants = Array.from(merchMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([merchant, totalPaise]) => ({ merchant, totalPaise }));

  const monthSummary = await getAnalyticsSummary(userId, { monthKey, timezone });
  const insightsResp = await generateInsights(userId, { monthKey, timezone });

  const appUrl = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const summary = {
    userName: user?.name || 'PaisaPilot User',
    windowDays: days,
    startDate,
    endDate: localDate,
    localDate,
    timezone,
    transactionCount: dayTxs.length,
    netSpentTodayPaise,
    netSpentWindowPaise: netSpentTodayPaise,
    incomePaise,
    netFlowPaise,
    categoryTotals,
    topMerchants,
    largestExpense,
    monthBudgetPaise: monthSummary.overallBudgetPaise,
    monthSpentPaise: monthSummary.netSpentPaise,
    budgetUsedPercent: monthSummary.budgetUsedPercent,
    uncategorizedOrReview,
    unusualInsights: insightsResp.insights.filter((i) => i.id.startsWith('unusual_') || i.kind === 'warning').slice(0, 3),
    appUrl
  };

  const html = renderDailyEmailHtml(summary, locale, currency);
  const subject = dayTxs.length === 0
    ? `PaisaPilot ${days}-Day Expenses (${startDate} to ${localDate}): No expenses recorded`
    : `PaisaPilot ${days}-Day Expenses (${startDate} to ${localDate}): ${formatINR(netSpentTodayPaise, locale, currency)} spent`;

  return { summary, html, subject };
}

function renderDailyEmailHtml(s, locale = 'en-IN', currency = 'INR') {
  const fmt = (p) => formatINR(p, locale, currency);
  const hasTx = s.transactionCount > 0;
  const daysLabel = `${s.windowDays || 4}-Day`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#0B1220;color:#E2E8F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#111827;border:1px solid #1F2937;border-radius:16px;padding:28px;">
    <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1F2937;padding-bottom:16px;margin-bottom:20px;">
      <div>
        <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#38BDF8;font-weight:700;">PaisaPilot ${daysLabel} Expenses Report</div>
        <h1 style="margin:4px 0 0;font-size:20px;color:#F8FAFC;">${escapeHtml(s.startDate)} to ${escapeHtml(s.endDate)} (${escapeHtml(s.timezone)})</h1>
      </div>
    </div>

    <p style="margin:0 0 18px;color:#CBD5E1;font-size:14px;">Hi ${escapeHtml(s.userName)}, here is your ${daysLabel.toLowerCase()} expenses digest.</p>

    ${!hasTx ? `
      <div style="background:#0F172A;border:1px solid #1E293B;border-radius:12px;padding:18px;margin-bottom:18px;">
        <div style="font-size:16px;font-weight:600;color:#34D399;margin-bottom:6px;">No transactions recorded in this 4-day window</div>
        <div style="font-size:13px;color:#94A3B8;">Your ledger has 0 entries between ${escapeHtml(s.startDate)} and ${escapeHtml(s.endDate)}. Upload a payment screenshot or statement anytime from Import Center.</div>
      </div>
    ` : `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:20px;">
        <tr>
          <td style="padding:12px;background:#0F172A;border-radius:10px;border:1px solid #1E293B;width:32%;">
            <div style="font-size:11px;color:#94A3B8;text-transform:uppercase;">Spent (4 Days)</div>
            <div style="font-size:18px;font-weight:700;color:#F87171;margin-top:4px;">${escapeHtml(fmt(s.netSpentTodayPaise))}</div>
          </td>
          <td style="width:2%;"></td>
          <td style="padding:12px;background:#0F172A;border-radius:10px;border:1px solid #1E293B;width:32%;">
            <div style="font-size:11px;color:#94A3B8;text-transform:uppercase;">Income</div>
            <div style="font-size:18px;font-weight:700;color:#34D399;margin-top:4px;">${escapeHtml(fmt(s.incomePaise))}</div>
          </td>
          <td style="width:2%;"></td>
          <td style="padding:12px;background:#0F172A;border-radius:10px;border:1px solid #1E293B;width:32%;">
            <div style="font-size:11px;color:#94A3B8;text-transform:uppercase;">Net Flow</div>
            <div style="font-size:18px;font-weight:700;color:#38BDF8;margin-top:4px;">${escapeHtml(fmt(s.netFlowPaise))}</div>
          </td>
        </tr>
      </table>

      <div style="font-size:13px;color:#CBD5E1;margin-bottom:16px;">
        <strong>Transactions (4 days):</strong> ${s.transactionCount}
        ${s.largestExpense ? ` · <strong>Largest:</strong> ${escapeHtml(s.largestExpense.merchant)} (${escapeHtml(fmt(s.largestExpense.amountPaise))})` : ''}
      </div>

      ${s.categoryTotals.length ? `
        <h3 style="font-size:13px;color:#94A3B8;text-transform:uppercase;margin:16px 0 8px;">Categories</h3>
        <ul style="margin:0;padding-left:18px;font-size:13px;color:#E2E8F0;">
          ${s.categoryTotals.map((c) => `<li>${escapeHtml(c.name)}: <strong>${escapeHtml(fmt(c.totalPaise))}</strong></li>`).join('')}
        </ul>` : ''}

      ${s.topMerchants.length ? `
        <h3 style="font-size:13px;color:#94A3B8;text-transform:uppercase;margin:16px 0 8px;">Top Merchants</h3>
        <ul style="margin:0;padding-left:18px;font-size:13px;color:#E2E8F0;">
          ${s.topMerchants.map((m) => `<li>${escapeHtml(m.merchant)}: <strong>${escapeHtml(fmt(m.totalPaise))}</strong></li>`).join('')}
        </ul>` : ''}
    `}

    <div style="background:#0F172A;border:1px solid #1E293B;border-radius:12px;padding:14px;margin-top:18px;font-size:13px;color:#CBD5E1;">
      <div><strong>Monthly Budget Usage:</strong> ${s.monthBudgetPaise > 0 ? `${s.budgetUsedPercent}% (${escapeHtml(fmt(s.monthSpentPaise))} of ${escapeHtml(fmt(s.monthBudgetPaise))})` : 'No monthly budget set'}</div>
      <div style="margin-top:6px;"><strong>Uncategorized / Needs Review:</strong> ${s.uncategorizedOrReview} item(s)</div>
    </div>

    ${s.unusualInsights.length ? `
      <div style="margin-top:16px;font-size:13px;color:#FBBF24;">
        <strong>Highlights:</strong>
        <ul style="margin:6px 0 0;padding-left:18px;">
          ${s.unusualInsights.map((ins) => `<li>${escapeHtml(ins.title)}</li>`).join('')}
        </ul>
      </div>` : ''}

    <div style="margin-top:24px;text-align:center;">
      <a href="${escapeHtml(s.appUrl)}/dashboard" style="display:inline-block;background:#0EA5E9;color:#082F49;font-weight:700;text-decoration:none;padding:11px 22px;border-radius:10px;font-size:14px;">Open PaisaPilot Dashboard</a>
    </div>

    <p style="margin:20px 0 0;font-size:11px;color:#64748B;text-align:center;">
      For privacy, full account numbers and raw payment references are omitted from emails.
    </p>
  </div>
</body>
</html>`;
}

async function sendViaBrevo({ toEmail, toName, subject, htmlContent, idempotencyKey }) {
  if (!isBrevoConfigured()) {
    return {
      ok: false,
      transient: false,
      httpStatus: 0,
      error: 'Brevo is not configured on the server (set BREVO_API_KEY and verified BREVO_SENDER_EMAIL in .env).'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY.trim()
      },
      body: JSON.stringify({
        sender: {
          name: process.env.BREVO_SENDER_NAME || 'PaisaPilot',
          email: process.env.BREVO_SENDER_EMAIL.trim()
        },
        to: [{ email: toEmail, name: toName || toEmail }],
        subject,
        htmlContent,
        headers: {
          'X-Idempotency-Key': idempotencyKey
        }
      }),
      signal: controller.signal
    });
    const text = await resp.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }

    if (resp.ok) {
      return { ok: true, httpStatus: resp.status, messageId: parsed.messageId || null, response: parsed };
    }
    const transient = resp.status >= 500 || resp.status === 429;
    return {
      ok: false,
      transient,
      httpStatus: resp.status,
      error: parsed.message || `Brevo API error (${resp.status})`,
      response: parsed
    };
  } catch (err) {
    return { ok: false, transient: true, httpStatus: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function deliverDailyReportForUser({ userId, localDate = null, reportType = 'daily_summary', force = false }) {
  const settings = await db.get(`SELECT * FROM user_settings WHERE user_id = ?`, [userId]);
  const user = await db.get(`SELECT id, name, email FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]);
  if (!user || !settings) throw new Error('User not found');

  const tz = settings.timezone || 'Asia/Kolkata';
  const targetDate = localDate || getDatePartsInTz(new Date(), tz).localDate;
  const recipient = settings.email_recipient || user.email;
  const idempotencyKey = `${userId}:${targetDate}:${reportType}`;

  if (!force && reportType === 'daily_summary') {
    const existingSent = await db.get(
      `SELECT id, status FROM daily_reports WHERE idempotency_key = ? AND status = 'sent'`,
      [idempotencyKey]
    );
    if (existingSent) {
      return { skipped: true, reason: 'Already sent for this local date', reportId: existingSent.id };
    }
  }

  const { summary, html, subject } = await buildDailySummaryData(userId, targetDate, tz);
  const now = new Date().toISOString();
  let reportId;

  const existingReport = await db.get(`SELECT id FROM daily_reports WHERE idempotency_key = ?`, [idempotencyKey]);
  if (existingReport) {
    reportId = existingReport.id;
    await db.run(
      `UPDATE daily_reports SET summary_json = ?, html_preview = ?, status = 'pending' WHERE id = ?`,
      [JSON.stringify(summary), html, reportId]
    );
  } else {
    reportId = newId('rep');
    await db.run(
      `INSERT INTO daily_reports (id, user_id, report_date, timezone, idempotency_key, summary_json, html_preview, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [reportId, userId, targetDate, tz, idempotencyKey, JSON.stringify(summary), html, now]
    );
  }

  const logId = newId('eml');
  await db.run(
    `INSERT INTO email_delivery_logs (id, user_id, daily_report_id, recipient_email, report_type, idempotency_key, provider, status, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'brevo', 'queued', 0, ?, ?)`,
    [logId, userId, reportId, recipient, reportType, idempotencyKey, now, now]
  );

  // Send with bounded exponential backoff retries for transient failures only
  let attempt = 0;
  let lastResult = null;
  const maxRetries = 3;

  while (attempt <= maxRetries) {
    lastResult = await sendViaBrevo({
      toEmail: recipient,
      toName: user.name,
      subject,
      htmlContent: html,
      idempotencyKey
    });
    if (lastResult.ok || !lastResult.transient || attempt === maxRetries) break;
    attempt++;
    await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)));
  }

  const doneAt = new Date().toISOString();
  if (lastResult.ok) {
    await db.run(`UPDATE daily_reports SET status = 'sent' WHERE id = ?`, [reportId]);
    await db.run(
      `UPDATE email_delivery_logs SET status = 'sent', provider_message_id = ?, http_status = ?, retry_count = ?, response_json = ?, updated_at = ? WHERE id = ?`,
      [lastResult.messageId, lastResult.httpStatus, attempt, JSON.stringify(lastResult.response || {}), doneAt, logId]
    );
    return { ok: true, reportId, logId, messageId: lastResult.messageId, recipient };
  }

  await db.run(`UPDATE daily_reports SET status = 'failed' WHERE id = ?`, [reportId]);
  await db.run(
    `UPDATE email_delivery_logs SET status = 'failed', http_status = ?, retry_count = ?, failure_reason = ?, response_json = ?, updated_at = ? WHERE id = ?`,
    [lastResult.httpStatus || 0, attempt, lastResult.error, JSON.stringify(lastResult.response || {}), doneAt, logId]
  );
  logger.warn('Brevo email delivery failed', { userId, reportType, httpStatus: lastResult.httpStatus, error: lastResult.error });
  return { ok: false, reportId, logId, error: lastResult.error, recipient };
}

async function dispatchImmediateEmail({ userId, recipient, recipientName, subject, html, reportType, idempotencyKey }) {
  const now = new Date().toISOString();
  const logId = newId('eml');
  await db.run(
    `INSERT INTO email_delivery_logs (id, user_id, daily_report_id, recipient_email, report_type, idempotency_key, provider, status, retry_count, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, 'brevo', 'queued', 0, ?, ?)`,
    [logId, userId, recipient, reportType, idempotencyKey, now, now]
  );

  const result = await sendViaBrevo({
    toEmail: recipient,
    toName: recipientName,
    subject,
    htmlContent: html,
    idempotencyKey
  });

  const doneAt = new Date().toISOString();
  if (result.ok) {
    await db.run(
      `UPDATE email_delivery_logs SET status = 'sent', provider_message_id = ?, http_status = ?, response_json = ?, updated_at = ? WHERE id = ?`,
      [result.messageId, result.httpStatus, JSON.stringify(result.response || {}), doneAt, logId]
    );
    return { ok: true, logId, messageId: result.messageId, recipient };
  }

  await db.run(
    `UPDATE email_delivery_logs SET status = 'failed', http_status = ?, failure_reason = ?, response_json = ?, updated_at = ? WHERE id = ?`,
    [result.httpStatus || 0, result.error, JSON.stringify(result.response || {}), doneAt, logId]
  );
  return { ok: false, logId, error: result.error, recipient };
}

function renderBudgetExceededHtml({ userName, scopeLabel, monthKey, spentPaise, limitPaise, overPaise, triggerMerchant, triggerAmountPaise, locale, currency, appUrl }) {
  const fmt = (p) => formatINR(p, locale, currency);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#0B1220;color:#E2E8F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#111827;border:1px solid #7F1D1D;border-radius:16px;padding:28px;">
    <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#F87171;font-weight:700;">PaisaPilot Budget Exceeded Alert</div>
    <h1 style="margin:6px 0 14px;font-size:20px;color:#F8FAFC;">${escapeHtml(scopeLabel)} exceeded for ${escapeHtml(monthKey)}</h1>
    <p style="margin:0 0 18px;color:#CBD5E1;font-size:14px;">Hi ${escapeHtml(userName)}, your spending just crossed the configured budget limit.</p>
    <div style="background:#0F172A;border:1px solid #1E293B;border-radius:12px;padding:16px;font-size:13px;line-height:1.7;">
      <div><strong>Budget Limit:</strong> ${escapeHtml(fmt(limitPaise))}</div>
      <div><strong>Total Spent (${escapeHtml(monthKey)}):</strong> <span style="color:#F87171;font-weight:700;">${escapeHtml(fmt(spentPaise))}</span></div>
      <div><strong>Exceeded By:</strong> <span style="color:#FBBF24;font-weight:700;">${escapeHtml(fmt(overPaise))}</span></div>
      ${triggerMerchant ? `<div style="margin-top:6px;"><strong>Latest Entry:</strong> ${escapeHtml(triggerMerchant)} (${escapeHtml(fmt(triggerAmountPaise))})</div>` : ''}
    </div>
    <div style="margin-top:22px;text-align:center;">
      <a href="${escapeHtml(appUrl)}/budgets" style="display:inline-block;background:#EF4444;color:#FFFFFF;font-weight:700;text-decoration:none;padding:11px 22px;border-radius:10px;font-size:14px;">Review Budgets in PaisaPilot</a>
    </div>
  </div>
</body>
</html>`;
}

async function checkAndSendBudgetExceededAlert({ userId, monthKey, categoryId = null, triggerMerchant = '', triggerAmountPaise = 0, timezone = null }) {
  const alerts = [];
  try {
    const user = await db.get(`SELECT id, name, email FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]);
    const settings = await db.get(`SELECT * FROM user_settings WHERE user_id = ?`, [userId]);
    if (!user) return { alerts };

    const tz = timezone || settings?.timezone || 'Asia/Kolkata';
    const locale = settings?.locale || 'en-IN';
    const currency = settings?.currency || 'INR';
    const recipient = settings?.email_recipient || user.email;
    const activeMonth = monthKey || getDatePartsInTz(new Date(), tz).monthKey;
    const appUrl = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

    const monthSummary = await getAnalyticsSummary(userId, { monthKey: activeMonth, timezone: tz });
    const fmt = (p) => formatINR(p, locale, currency);

    // 1. Check overall monthly budget exceedance
    const overallLimit = Number(monthSummary.overallBudgetPaise || 0);
    const overallSpent = Number(monthSummary.netSpentPaise || 0);
    if (overallLimit > 0 && overallSpent > overallLimit) {
      const idempotencyKey = `${userId}:${activeMonth}:overall_budget_exceeded`;
      const existing = await db.get(
        `SELECT status FROM email_delivery_logs WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1`,
        [idempotencyKey]
      );
      const alreadyHandled = existing && (existing.status === 'sent' || (existing.status === 'failed' && !isBrevoConfigured()));
      if (!alreadyHandled) {
        const overPaise = overallSpent - overallLimit;
        const subject = `PaisaPilot Budget Alert: Monthly budget (${fmt(overallLimit)}) exceeded`;
        const html = renderBudgetExceededHtml({
          userName: user.name || 'PaisaPilot User',
          scopeLabel: 'Overall Monthly Budget',
          monthKey: activeMonth,
          spentPaise: overallSpent,
          limitPaise: overallLimit,
          overPaise,
          triggerMerchant,
          triggerAmountPaise,
          locale,
          currency,
          appUrl
        });
        const delivery = await dispatchImmediateEmail({
          userId,
          recipient,
          recipientName: user.name,
          subject,
          html,
          reportType: 'budget_exceeded',
          idempotencyKey
        });
        alerts.push({ scope: 'overall', ...delivery });
      }
    }

    // 2. Check category-level budgets (if budget exists for month or 'default')
    let budgetRow = await db.get(`SELECT id FROM budgets WHERE user_id = ? AND month_key = ?`, [userId, activeMonth]);
    if (!budgetRow) {
      budgetRow = await db.get(`SELECT id FROM budgets WHERE user_id = ? AND month_key = 'default'`, [userId]);
    }
    if (budgetRow) {
      const catLimits = await db.query(
        `SELECT bc.category_id, bc.limit_paise, c.name AS category_name
         FROM budget_categories bc
         JOIN categories c ON c.id = bc.category_id
         WHERE bc.budget_id = ? AND bc.user_id = ? AND bc.limit_paise > 0`,
        [budgetRow.id, userId]
      );
      const spentByCat = new Map((monthSummary.categories || []).map((c) => [c.categoryId, Number(c.totalPaise || 0)]));
      for (const cl of catLimits) {
        if (categoryId && cl.category_id !== categoryId) continue;
        const catSpent = spentByCat.get(cl.category_id) || 0;
        if (catSpent > cl.limit_paise) {
          const idempotencyKey = `${userId}:${activeMonth}:cat_budget_exceeded:${cl.category_id}`;
          const existing = await db.get(
            `SELECT status FROM email_delivery_logs WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1`,
            [idempotencyKey]
          );
          const alreadyHandled = existing && (existing.status === 'sent' || (existing.status === 'failed' && !isBrevoConfigured()));
          if (!alreadyHandled) {
            const overPaise = catSpent - cl.limit_paise;
            const subject = `PaisaPilot Budget Alert: ${cl.category_name} budget (${fmt(cl.limit_paise)}) exceeded`;
            const html = renderBudgetExceededHtml({
              userName: user.name || 'PaisaPilot User',
              scopeLabel: `${cl.category_name} Category Budget`,
              monthKey: activeMonth,
              spentPaise: catSpent,
              limitPaise: cl.limit_paise,
              overPaise,
              triggerMerchant,
              triggerAmountPaise,
              locale,
              currency,
              appUrl
            });
            const delivery = await dispatchImmediateEmail({
              userId,
              recipient,
              recipientName: user.name,
              subject,
              html,
              reportType: 'budget_exceeded',
              idempotencyKey
            });
            alerts.push({ scope: 'category', categoryId: cl.category_id, ...delivery });
          }
        }
      }
    }
  } catch (err) {
    logger.warn('Budget exceeded immediate email check failed', { userId, error: err.message });
  }
  return { alerts };
}

module.exports = {
  isBrevoConfigured,
  buildDailySummaryData,
  deliverDailyReportForUser,
  checkAndSendBudgetExceededAlert
};
