const db = require('./db');
const { newId } = require('./crypto');
const { formatINR, getDatePartsInTz } = require('./money');
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

async function buildDailySummaryData(userId, localDate, timezone = 'Asia/Kolkata') {
  const settings = await db.get(`SELECT * FROM user_settings WHERE user_id = ?`, [userId]);
  const user = await db.get(`SELECT id, name, email FROM users WHERE id = ?`, [userId]);
  const locale = settings?.locale || 'en-IN';
  const currency = settings?.currency || 'INR';
  const monthKey = localDate.slice(0, 7);

  const dayTxs = await db.query(
    `SELECT t.id, t.amount_paise, t.type, t.merchant, t.payment_method, t.reconciliation_status,
            c.name AS category_name, c.slug AS category_slug
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? AND t.local_date = ?`,
    [userId, localDate]
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
    if (!largestExpense || t.amount_paise > largestExpense.amount_paise) {
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
    .slice(0, 3)
    .map(([merchant, totalPaise]) => ({ merchant, totalPaise }));

  const monthSummary = await getAnalyticsSummary(userId, { monthKey, timezone });
  const insightsResp = await generateInsights(userId, { monthKey, timezone });
  const connections = await db.query(
    `SELECT provider, display_name, status, last_sync_at, last_error, pending_count FROM ingestion_connections WHERE user_id = ?`,
    [userId]
  );

  const appUrl = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const summary = {
    userName: user?.name || 'PaisaPilot User',
    localDate,
    timezone,
    transactionCount: dayTxs.length,
    netSpentTodayPaise,
    incomePaise,
    netFlowPaise,
    categoryTotals,
    topMerchants,
    largestExpense,
    monthBudgetPaise: monthSummary.overallBudgetPaise,
    monthSpentPaise: monthSummary.netSpentPaise,
    budgetUsedPercent: monthSummary.budgetUsedPercent,
    uncategorizedOrReview,
    reconciliationHealth: monthSummary.reconciliationCounts,
    unusualInsights: insightsResp.insights.filter((i) => i.id.startsWith('unusual_') || i.kind === 'warning').slice(0, 3),
    connections,
    appUrl
  };

  const html = renderDailyEmailHtml(summary, locale, currency);
  const subject = dayTxs.length === 0
    ? `PaisaPilot Daily Digest (${localDate}): No transactions recorded`
    : `PaisaPilot Daily Digest (${localDate}): ${formatINR(netSpentTodayPaise, locale, currency)} spent`;

  return { summary, html, subject };
}

function renderDailyEmailHtml(s, locale = 'en-IN', currency = 'INR') {
  const fmt = (p) => formatINR(p, locale, currency);
  const hasTx = s.transactionCount > 0;
  const syncHealthy = s.connections.length === 0
    ? 'Manual & Statement Import mode (no live mobile listener connected)'
    : s.connections.map((c) => `${escapeHtml(c.display_name)}: ${escapeHtml(c.status)}`).join(' · ');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#0B1220;color:#E2E8F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#111827;border:1px solid #1F2937;border-radius:16px;padding:28px;">
    <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1F2937;padding-bottom:16px;margin-bottom:20px;">
      <div>
        <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#38BDF8;font-weight:700;">PaisaPilot Daily Digest</div>
        <h1 style="margin:4px 0 0;font-size:20px;color:#F8FAFC;">${escapeHtml(s.localDate)} (${escapeHtml(s.timezone)})</h1>
      </div>
    </div>

    <p style="margin:0 0 18px;color:#CBD5E1;font-size:14px;">Hi ${escapeHtml(s.userName)}, here is your calm end-of-day summary.</p>

    ${!hasTx ? `
      <div style="background:#0F172A;border:1px solid #1E293B;border-radius:12px;padding:18px;margin-bottom:18px;">
        <div style="font-size:16px;font-weight:600;color:#34D399;margin-bottom:6px;">No transactions recorded today</div>
        <div style="font-size:13px;color:#94A3B8;">Your ledger has 0 entries for ${escapeHtml(s.localDate)}. Source status: ${syncHealthy}. If you paid via PhonePe/UPI with notifications off, remember to upload a statement when convenient.</div>
      </div>
    ` : `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:20px;">
        <tr>
          <td style="padding:12px;background:#0F172A;border-radius:10px;border:1px solid #1E293B;width:32%;">
            <div style="font-size:11px;color:#94A3B8;text-transform:uppercase;">Spent Today</div>
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
        <strong>Transactions today:</strong> ${s.transactionCount}
        ${s.largestExpense ? ` · <strong>Largest:</strong> ${escapeHtml(s.largestExpense.merchant)} (${escapeHtml(fmt(s.largestExpense.amountPaise))})` : ''}
      </div>

      ${s.categoryTotals.length ? `
        <h3 style="font-size:13px;color:#94A3B8;text-transform:uppercase;margin:16px 0 8px;">Categories</h3>
        <ul style="margin:0;padding-left:18px;font-size:13px;color:#E2E8F0;">
          ${s.categoryTotals.map((c) => `<li>${escapeHtml(c.name)}: <strong>${escapeHtml(fmt(c.totalPaise))}</strong></li>`).join('')}
        </ul>` : ''}

      ${s.topMerchants.length ? `
        <h3 style="font-size:13px;color:#94A3B8;text-transform:uppercase;margin:16px 0 8px;">Top 3 Merchants</h3>
        <ul style="margin:0;padding-left:18px;font-size:13px;color:#E2E8F0;">
          ${s.topMerchants.map((m) => `<li>${escapeHtml(m.merchant)}: <strong>${escapeHtml(fmt(m.totalPaise))}</strong></li>`).join('')}
        </ul>` : ''}
    `}

    <div style="background:#0F172A;border:1px solid #1E293B;border-radius:12px;padding:14px;margin-top:18px;font-size:13px;color:#CBD5E1;">
      <div><strong>Monthly Budget Usage:</strong> ${s.monthBudgetPaise > 0 ? `${s.budgetUsedPercent}% (${escapeHtml(fmt(s.monthSpentPaise))} of ${escapeHtml(fmt(s.monthBudgetPaise))})` : 'No monthly budget set'}</div>
      <div style="margin-top:6px;"><strong>Pending Review / Uncategorized:</strong> ${s.uncategorizedOrReview} item(s)</div>
      <div style="margin-top:6px;"><strong>Sync & Reconciliation Health:</strong> ${syncHealthy}</div>
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

module.exports = {
  isBrevoConfigured,
  buildDailySummaryData,
  deliverDailyReportForUser
};
