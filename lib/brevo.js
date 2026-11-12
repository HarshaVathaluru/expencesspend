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

function renderEmailStyles(accentHex = '#10B981') {
  return `<style>
    @keyframes ppEmailShellIn {
      0% { opacity: 0; transform: perspective(1100px) translateY(18px) rotateX(6deg) scale(0.98); }
      100% { opacity: 1; transform: perspective(1100px) translateY(0) rotateX(0deg) scale(1); }
    }
    @keyframes ppCardRise3D {
      0% { opacity: 0; transform: perspective(900px) translateY(14px) translateZ(-20px) rotateX(7deg); }
      100% { opacity: 1; transform: perspective(900px) translateY(0) translateZ(0) rotateX(0deg); }
    }
    @keyframes ppBarGrow {
      0% { transform: scaleX(0); opacity: 0.4; }
      100% { transform: scaleX(1); opacity: 1; }
    }
    .pp-email-shell {
      animation: ppEmailShellIn 520ms cubic-bezier(0.22, 1, 0.36, 1) both;
      transform-style: preserve-3d;
    }
    .pp-kpi-1 { animation: ppCardRise3D 480ms 60ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-kpi-2 { animation: ppCardRise3D 480ms 130ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-kpi-3 { animation: ppCardRise3D 480ms 200ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-block-rise { animation: ppCardRise3D 520ms 240ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-bar-fill {
      transform-origin: left center;
      animation: ppBarGrow 700ms 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .pp-cta-btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
    .pp-num { font-variant-numeric: tabular-nums; }
    @media only screen and (max-width: 520px) {
      .pp-body-pad { padding: 14px !important; }
      .pp-card-pad { padding: 18px !important; }
      .pp-stack-col { display: block !important; width: 100% !important; box-sizing: border-box !important; margin-bottom: 10px !important; }
      .pp-stack-spacer { display: none !important; }
    }
    @media (prefers-reduced-motion: reduce) {
      .pp-email-shell, .pp-kpi-1, .pp-kpi-2, .pp-kpi-3, .pp-block-rise, .pp-bar-fill {
        animation: none !important;
      }
    }
  </style>`;
}

function renderDailyEmailHtml(s, locale = 'en-IN', currency = 'INR') {
  const fmt = (p) => formatINR(p, locale, currency);
  const hasTx = s.transactionCount > 0;
  const daysLabel = `${s.windowDays || 4}-Day`;
  const totalCatPaise = Math.max(1, s.categoryTotals.reduce((acc, c) => acc + c.totalPaise, 0));
  const budgetPct = s.monthBudgetPaise > 0 ? Math.min(100, Math.max(0, Math.round(s.budgetUsedPercent))) : 0;
  const budgetBarColor = s.budgetUsedPercent >= 100 ? '#EF4444' : s.budgetUsedPercent >= 75 ? '#F59E0B' : '#10B981';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${renderEmailStyles('#10B981')}
</head>
<body class="pp-body-pad" style="margin:0;padding:24px;background:#090B0F;color:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div class="pp-email-shell pp-card-pad" style="max-width:600px;margin:0 auto;background:#11151D;border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:28px;box-shadow:0 28px 56px -16px rgba(0,0,0,0.75),inset 0 1px 0 rgba(255,255,255,0.08);">

    <!-- Top Brand Header -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:18px;margin-bottom:20px;">
      <tr>
        <td style="vertical-align:middle;">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <td style="width:38px;height:38px;border-radius:11px;background:linear-gradient(145deg,#10B981,#0F766E);text-align:center;vertical-align:middle;font-size:18px;font-weight:800;color:#052E16;box-shadow:0 8px 18px -4px rgba(16,185,129,0.4),inset 0 1px 0 rgba(255,255,255,0.35);">₹</td>
              <td style="padding-left:12px;">
                <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#10B981;font-weight:700;">PaisaPilot · ${daysLabel} Expenses</div>
                <h1 style="margin:3px 0 0;font-size:18px;font-weight:700;color:#F9FAFB;letter-spacing:-0.01em;">${escapeHtml(s.startDate)} &rarr; ${escapeHtml(s.endDate)}</h1>
              </td>
            </tr>
          </table>
        </td>
        <td style="text-align:right;vertical-align:middle;">
          <span style="display:inline-block;padding:5px 10px;border-radius:999px;background:#161B25;border:1px solid rgba(255,255,255,0.1);font-size:11px;color:#9CA3AF;">${escapeHtml(s.timezone)}</span>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 18px;color:#D1D5DB;font-size:14px;line-height:1.5;">Hi <strong style="color:#F9FAFB;">${escapeHtml(s.userName)}</strong>, here is your ${daysLabel.toLowerCase()} spending ledger summary.</p>

    ${!hasTx ? `
      <div class="pp-kpi-1" style="background:#161B25;border:1px solid rgba(16,185,129,0.25);border-radius:14px;padding:20px;margin-bottom:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.06);">
        <div style="font-size:15px;font-weight:700;color:#10B981;margin-bottom:6px;">No expenses recorded in this 4-day window</div>
        <div style="font-size:13px;color:#9CA3AF;line-height:1.55;">Your ledger has 0 entries between ${escapeHtml(s.startDate)} and ${escapeHtml(s.endDate)}. Upload a payment screenshot or statement anytime from <strong>Import &amp; Scan</strong>.</div>
      </div>
    ` : `
      <!-- 3D Elevated KPI Cards -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:18px;">
        <tr>
          <td class="pp-stack-col pp-kpi-1" style="padding:14px;background:#161B25;border-radius:14px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 24px -10px rgba(0,0,0,0.55),inset 0 1px 0 rgba(255,255,255,0.07);width:32%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.06em;color:#9CA3AF;text-transform:uppercase;font-weight:600;">Spent (4 Days)</div>
            <div class="pp-num" style="font-size:18px;font-weight:700;color:#F87171;margin-top:6px;">${escapeHtml(fmt(s.netSpentTodayPaise))}</div>
          </td>
          <td class="pp-stack-spacer" style="width:2%;"></td>
          <td class="pp-stack-col pp-kpi-2" style="padding:14px;background:#161B25;border-radius:14px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 24px -10px rgba(0,0,0,0.55),inset 0 1px 0 rgba(255,255,255,0.07);width:32%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.06em;color:#9CA3AF;text-transform:uppercase;font-weight:600;">Income</div>
            <div class="pp-num" style="font-size:18px;font-weight:700;color:#10B981;margin-top:6px;">${escapeHtml(fmt(s.incomePaise))}</div>
          </td>
          <td class="pp-stack-spacer" style="width:2%;"></td>
          <td class="pp-stack-col pp-kpi-3" style="padding:14px;background:#161B25;border-radius:14px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 24px -10px rgba(0,0,0,0.55),inset 0 1px 0 rgba(255,255,255,0.07);width:32%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.06em;color:#9CA3AF;text-transform:uppercase;font-weight:600;">Net Flow</div>
            <div class="pp-num" style="font-size:18px;font-weight:700;color:${s.netFlowPaise >= 0 ? '#34D399' : '#FBBF24'};margin-top:6px;">${escapeHtml(fmt(s.netFlowPaise))}</div>
          </td>
        </tr>
      </table>

      <div class="pp-block-rise" style="background:#161B25;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:12px 14px;font-size:12px;color:#D1D5DB;margin-bottom:18px;">
        <strong>Activity:</strong> <span class="pp-num">${s.transactionCount}</span> transaction(s)
        ${s.largestExpense ? ` &middot; <strong>Largest:</strong> ${escapeHtml(s.largestExpense.merchant)} (<span class="pp-num" style="color:#F9FAFB;">${escapeHtml(fmt(s.largestExpense.amountPaise))}</span>)` : ''}
      </div>

      ${s.categoryTotals.length ? `
        <div class="pp-block-rise" style="margin-bottom:18px;">
          <div style="font-size:11px;letter-spacing:0.08em;color:#9CA3AF;text-transform:uppercase;font-weight:700;margin-bottom:10px;">Category Breakdown</div>
          ${s.categoryTotals.slice(0, 6).map((c) => {
            const pct = Math.max(4, Math.round((c.totalPaise / totalCatPaise) * 100));
            return `
              <div style="margin-bottom:10px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:12px;margin-bottom:4px;">
                  <tr>
                    <td style="color:#E5E7EB;">${escapeHtml(c.name)}</td>
                    <td class="pp-num" style="text-align:right;font-weight:700;color:#F9FAFB;">${escapeHtml(fmt(c.totalPaise))}</td>
                  </tr>
                </table>
                <div style="height:6px;background:#1F2937;border-radius:999px;overflow:hidden;">
                  <div class="pp-bar-fill" style="height:6px;width:${pct}%;background:linear-gradient(90deg,#10B981,#34D399);border-radius:999px;"></div>
                </div>
              </div>`;
          }).join('')}
        </div>` : ''}

      ${s.topMerchants.length ? `
        <div class="pp-block-rise" style="background:#161B25;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:14px 16px;margin-bottom:18px;">
          <div style="font-size:11px;letter-spacing:0.08em;color:#9CA3AF;text-transform:uppercase;font-weight:700;margin-bottom:10px;">Top Merchants</div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:12px;">
            ${s.topMerchants.map((m, i) => `
              <tr>
                <td style="padding:5px 0;color:#E5E7EB;${i > 0 ? 'border-top:1px solid rgba(255,255,255,0.06);' : ''}">${i + 1}. ${escapeHtml(m.merchant)}</td>
                <td class="pp-num" style="padding:5px 0;text-align:right;font-weight:700;color:#F9FAFB;${i > 0 ? 'border-top:1px solid rgba(255,255,255,0.06);' : ''}">${escapeHtml(fmt(m.totalPaise))}</td>
              </tr>
            `).join('')}
          </table>
        </div>` : ''}
    `}

    <!-- Monthly Budget Status Gauge -->
    <div class="pp-block-rise" style="background:#161B25;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;font-size:13px;color:#D1D5DB;box-shadow:inset 0 1px 0 rgba(255,255,255,0.05);">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:8px;">
        <tr>
          <td style="font-weight:700;color:#F9FAFB;font-size:12px;">Monthly Budget Usage</td>
          <td class="pp-num" style="text-align:right;font-size:12px;font-weight:700;color:${budgetBarColor};">${s.monthBudgetPaise > 0 ? `${s.budgetUsedPercent}%` : 'Not set'}</td>
        </tr>
      </table>
      ${s.monthBudgetPaise > 0 ? `
        <div style="height:7px;background:#1F2937;border-radius:999px;overflow:hidden;margin-bottom:8px;">
          <div class="pp-bar-fill" style="height:7px;width:${budgetPct}%;background:${budgetBarColor};border-radius:999px;"></div>
        </div>
        <div class="pp-num" style="font-size:12px;color:#9CA3AF;">${escapeHtml(fmt(s.monthSpentPaise))} of ${escapeHtml(fmt(s.monthBudgetPaise))}</div>
      ` : `<div style="font-size:12px;color:#9CA3AF;">Set a monthly budget in PaisaPilot to enable automatic exceedance alerts.</div>`}
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#9CA3AF;">
        <strong>Uncategorized / Needs Review:</strong> ${s.uncategorizedOrReview} item(s)
      </div>
    </div>

    ${s.unusualInsights.length ? `
      <div class="pp-block-rise" style="margin-top:16px;padding:12px 14px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:12px;font-size:12px;color:#FCD34D;">
        <strong>Highlights:</strong>
        <ul style="margin:6px 0 0;padding-left:18px;">
          ${s.unusualInsights.map((ins) => `<li>${escapeHtml(ins.title)}</li>`).join('')}
        </ul>
      </div>` : ''}

    <div style="margin-top:24px;text-align:center;">
      <a class="pp-cta-btn" href="${escapeHtml(s.appUrl)}/dashboard" style="display:inline-block;background:linear-gradient(135deg,#10B981,#059669);color:#052E16;font-weight:700;text-decoration:none;padding:12px 26px;border-radius:12px;font-size:13px;box-shadow:0 12px 24px -8px rgba(16,185,129,0.5),inset 0 1px 0 rgba(255,255,255,0.35);">Open PaisaPilot Dashboard</a>
    </div>

    <p style="margin:20px 0 0;font-size:11px;color:#6B7280;text-align:center;">
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
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${renderEmailStyles('#EF4444')}
</head>
<body class="pp-body-pad" style="margin:0;padding:24px;background:#090B0F;color:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div class="pp-email-shell pp-card-pad" style="max-width:600px;margin:0 auto;background:#11151D;border:1px solid rgba(239,68,68,0.35);border-radius:20px;padding:28px;box-shadow:0 28px 56px -16px rgba(0,0,0,0.75),inset 0 1px 0 rgba(255,255,255,0.08);">
    <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#F87171;font-weight:700;">PaisaPilot · Budget Alert</div>
    <h1 style="margin:6px 0 12px;font-size:20px;font-weight:700;color:#F9FAFB;">${escapeHtml(scopeLabel)} exceeded (${escapeHtml(monthKey)})</h1>
    <p style="margin:0 0 18px;color:#D1D5DB;font-size:14px;line-height:1.5;">Hi <strong style="color:#F9FAFB;">${escapeHtml(userName)}</strong>, your spending just crossed your configured budget limit.</p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:16px;">
      <tr>
        <td class="pp-stack-col pp-kpi-1" style="padding:14px;background:#161B25;border-radius:14px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 24px -10px rgba(0,0,0,0.55),inset 0 1px 0 rgba(255,255,255,0.06);width:32%;">
          <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;font-weight:600;">Budget Limit</div>
          <div class="pp-num" style="font-size:17px;font-weight:700;color:#F9FAFB;margin-top:6px;">${escapeHtml(fmt(limitPaise))}</div>
        </td>
        <td class="pp-stack-spacer" style="width:2%;"></td>
        <td class="pp-stack-col pp-kpi-2" style="padding:14px;background:#161B25;border-radius:14px;border:1px solid rgba(239,68,68,0.28);box-shadow:0 12px 24px -10px rgba(0,0,0,0.55),inset 0 1px 0 rgba(255,255,255,0.06);width:32%;">
          <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;font-weight:600;">Total Spent</div>
          <div class="pp-num" style="font-size:17px;font-weight:700;color:#F87171;margin-top:6px;">${escapeHtml(fmt(spentPaise))}</div>
        </td>
        <td class="pp-stack-spacer" style="width:2%;"></td>
        <td class="pp-stack-col pp-kpi-3" style="padding:14px;background:#161B25;border-radius:14px;border:1px solid rgba(245,158,11,0.28);box-shadow:0 12px 24px -10px rgba(0,0,0,0.55),inset 0 1px 0 rgba(255,255,255,0.06);width:32%;">
          <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;font-weight:600;">Exceeded By</div>
          <div class="pp-num" style="font-size:17px;font-weight:700;color:#FBBF24;margin-top:6px;">+${escapeHtml(fmt(overPaise))}</div>
        </td>
      </tr>
    </table>

    <div class="pp-block-rise" style="background:#161B25;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px 14px;font-size:12px;color:#D1D5DB;">
      <div style="height:6px;background:#1F2937;border-radius:999px;overflow:hidden;margin-bottom:8px;">
        <div class="pp-bar-fill" style="height:6px;width:100%;background:linear-gradient(90deg,#F59E0B,#EF4444);border-radius:999px;"></div>
      </div>
      ${triggerMerchant ? `<div><strong>Latest Entry:</strong> ${escapeHtml(triggerMerchant)} (<span class="pp-num">${escapeHtml(fmt(triggerAmountPaise))}</span>)</div>` : '<div>Monthly spending has exceeded the configured limit.</div>'}
    </div>

    <div style="margin-top:22px;text-align:center;">
      <a class="pp-cta-btn" href="${escapeHtml(appUrl)}/budgets" style="display:inline-block;background:linear-gradient(135deg,#EF4444,#DC2626);color:#FFFFFF;font-weight:700;text-decoration:none;padding:12px 26px;border-radius:12px;font-size:13px;box-shadow:0 12px 24px -8px rgba(239,68,68,0.5),inset 0 1px 0 rgba(255,255,255,0.25);">Review Budgets in PaisaPilot</a>
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
