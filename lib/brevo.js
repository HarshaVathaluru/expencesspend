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

function renderEmailStyles(accentHex = '#059669') {
  return `<style>
    @keyframes ppEmailShellIn {
      0% { opacity: 0; transform: perspective(1200px) translateY(20px) rotateX(6deg) scale(0.98); }
      100% { opacity: 1; transform: perspective(1200px) translateY(0) rotateX(0deg) scale(1); }
    }
    @keyframes ppCardRise3D {
      0% { opacity: 0; transform: perspective(900px) translateY(16px) translateZ(-24px) rotateX(7deg); }
      100% { opacity: 1; transform: perspective(900px) translateY(0) translateZ(0) rotateX(0deg); }
    }
    @keyframes ppBarGrow {
      0% { transform: scaleX(0); opacity: 0.35; }
      100% { transform: scaleX(1); opacity: 1; }
    }
    @keyframes ppPulseDot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.35); opacity: 0.55; }
    }
    @keyframes ppFloatGentle {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-3px); }
    }
    .pp-email-shell {
      animation: ppEmailShellIn 560ms cubic-bezier(0.22, 1, 0.36, 1) both;
      transform-style: preserve-3d;
    }
    .pp-kpi-1 { animation: ppCardRise3D 480ms 70ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-kpi-2 { animation: ppCardRise3D 480ms 140ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-kpi-3 { animation: ppCardRise3D 480ms 210ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-block-rise { animation: ppCardRise3D 520ms 260ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-addon-1 { animation: ppCardRise3D 500ms 300ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-addon-2 { animation: ppCardRise3D 500ms 360ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-addon-3 { animation: ppCardRise3D 500ms 420ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .pp-bar-fill {
      transform-origin: left center;
      animation: ppBarGrow 760ms 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .pp-pulse-dot {
      display: inline-block;
      animation: ppPulseDot 2.2s ease-in-out infinite;
    }
    .pp-logo-badge {
      animation: ppFloatGentle 3.6s ease-in-out infinite;
    }
    .pp-3d-tile {
      transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 240ms cubic-bezier(0.22, 1, 0.36, 1), border-color 240ms ease;
    }
    .pp-3d-tile:hover {
      transform: translateY(-3px) scale(1.015);
      box-shadow: 0 16px 30px -10px rgba(15, 23, 42, 0.14), 0 4px 10px -2px rgba(15, 23, 42, 0.06) !important;
      border-color: ${accentHex} !important;
    }
    .pp-cta-btn {
      transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 220ms ease, filter 220ms ease;
    }
    .pp-cta-btn:hover {
      filter: brightness(1.05);
      transform: translateY(-2px);
      box-shadow: 0 16px 28px -8px rgba(5, 150, 105, 0.42) !important;
    }
    .pp-num { font-variant-numeric: tabular-nums; }
    @media only screen and (max-width: 520px) {
      .pp-body-pad { padding: 12px !important; }
      .pp-card-pad { padding: 18px !important; }
      .pp-stack-col { display: block !important; width: 100% !important; box-sizing: border-box !important; margin-bottom: 10px !important; }
      .pp-stack-spacer { display: none !important; }
    }
    @media (prefers-reduced-motion: reduce) {
      .pp-email-shell, .pp-kpi-1, .pp-kpi-2, .pp-kpi-3, .pp-block-rise, .pp-addon-1, .pp-addon-2, .pp-addon-3, .pp-bar-fill, .pp-pulse-dot, .pp-logo-badge {
        animation: none !important;
      }
      .pp-3d-tile, .pp-cta-btn { transition: none !important; }
    }
  </style>`;
}

function renderDailyEmailHtml(s, locale = 'en-IN', currency = 'INR') {
  const fmt = (p) => formatINR(p, locale, currency);
  const hasTx = s.transactionCount > 0;
  const days = s.windowDays || 4;
  const daysLabel = `${days}-Day`;
  const dailyAvgPaise = Math.round((s.netSpentTodayPaise || 0) / Math.max(1, days));
  const remainingBudgetPaise = s.monthBudgetPaise > 0 ? Math.max(0, s.monthBudgetPaise - s.monthSpentPaise) : 0;
  const totalCatPaise = Math.max(1, s.categoryTotals.reduce((acc, c) => acc + c.totalPaise, 0));
  const budgetPct = s.monthBudgetPaise > 0 ? Math.min(100, Math.max(0, Math.round(s.budgetUsedPercent))) : 0;
  const budgetBarColor = s.budgetUsedPercent >= 100 ? '#DC2626' : s.budgetUsedPercent >= 75 ? '#D97706' : '#059669';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${renderEmailStyles('#059669')}
</head>
<body class="pp-body-pad" style="margin:0;padding:24px;background:#EEF2F7;color:#0F172A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div class="pp-email-shell pp-card-pad" style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:22px;padding:28px;box-shadow:0 24px 48px -14px rgba(15,23,42,0.12),0 4px 12px -2px rgba(15,23,42,0.05);">

    <!-- Top Brand Header -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-bottom:1px solid #E2E8F0;padding-bottom:18px;margin-bottom:20px;">
      <tr>
        <td style="vertical-align:middle;">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <td class="pp-logo-badge" style="width:42px;height:42px;border-radius:12px;background:linear-gradient(145deg,#10B981,#047857);text-align:center;vertical-align:middle;font-size:20px;font-weight:800;color:#FFFFFF;box-shadow:0 10px 20px -6px rgba(5,150,105,0.4),inset 0 1px 0 rgba(255,255,255,0.4);">₹</td>
              <td style="padding-left:12px;">
                <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#059669;font-weight:700;">PaisaPilot &middot; ${daysLabel} Digest</div>
                <h1 style="margin:3px 0 0;font-size:18px;font-weight:700;color:#0F172A;letter-spacing:-0.01em;">${escapeHtml(s.startDate)} &rarr; ${escapeHtml(s.endDate)}</h1>
              </td>
            </tr>
          </table>
        </td>
        <td style="text-align:right;vertical-align:middle;">
          <span style="display:inline-block;padding:5px 11px;border-radius:999px;background:#ECFDF5;border:1px solid #A7F3D0;font-size:11px;font-weight:600;color:#047857;">
            <span class="pp-pulse-dot" style="width:7px;height:7px;border-radius:999px;background:#10B981;margin-right:5px;vertical-align:middle;"></span>${escapeHtml(s.timezone)}
          </span>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 18px;color:#334155;font-size:14px;line-height:1.55;">Hi <strong style="color:#0F172A;">${escapeHtml(s.userName)}</strong>, here is your ${daysLabel.toLowerCase()} spending &amp; budget snapshot.</p>

    ${!hasTx ? `
      <div class="pp-kpi-1 pp-3d-tile" style="background:linear-gradient(135deg,#F0FDF4,#ECFDF5);border:1px solid #BBF7D0;border-radius:16px;padding:20px;margin-bottom:18px;box-shadow:0 10px 22px -10px rgba(5,150,105,0.16);">
        <div style="font-size:15px;font-weight:700;color:#047857;margin-bottom:6px;">No transactions recorded in this ${days}-day window</div>
        <div style="font-size:13px;color:#334155;line-height:1.55;">Your ledger has 0 entries between <strong>${escapeHtml(s.startDate)}</strong> and <strong>${escapeHtml(s.endDate)}</strong>. Upload a payment screenshot or bank statement anytime from <strong>Import &amp; Scan</strong>.</div>
      </div>

      <!-- Light 3D Snapshot Strip even on 0-tx window -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:18px;">
        <tr>
          <td class="pp-stack-col pp-kpi-2 pp-3d-tile" style="padding:14px;background:#F8FAFC;border-radius:14px;border:1px solid #E2E8F0;box-shadow:0 8px 18px -8px rgba(15,23,42,0.08);width:32%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.06em;color:#64748B;text-transform:uppercase;font-weight:700;">Window</div>
            <div class="pp-num" style="font-size:17px;font-weight:700;color:#0F172A;margin-top:6px;">${days} Days</div>
          </td>
          <td class="pp-stack-spacer" style="width:2%;"></td>
          <td class="pp-stack-col pp-kpi-2 pp-3d-tile" style="padding:14px;background:#F8FAFC;border-radius:14px;border:1px solid #E2E8F0;box-shadow:0 8px 18px -8px rgba(15,23,42,0.08);width:32%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.06em;color:#64748B;text-transform:uppercase;font-weight:700;">Daily Avg</div>
            <div class="pp-num" style="font-size:17px;font-weight:700;color:#059669;margin-top:6px;">${escapeHtml(fmt(0))}</div>
          </td>
          <td class="pp-stack-spacer" style="width:2%;"></td>
          <td class="pp-stack-col pp-kpi-3 pp-3d-tile" style="padding:14px;background:#F8FAFC;border-radius:14px;border:1px solid #E2E8F0;box-shadow:0 8px 18px -8px rgba(15,23,42,0.08);width:32%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.06em;color:#64748B;text-transform:uppercase;font-weight:700;">Budget Left</div>
            <div class="pp-num" style="font-size:17px;font-weight:700;color:#0F766E;margin-top:6px;">${s.monthBudgetPaise > 0 ? escapeHtml(fmt(remainingBudgetPaise)) : 'Not Set'}</div>
          </td>
        </tr>
      </table>
    ` : `
      <!-- 3D Elevated Light KPI Cards -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:16px;">
        <tr>
          <td class="pp-stack-col pp-kpi-1 pp-3d-tile" style="padding:14px;background:#FEF2F2;border-radius:14px;border:1px solid #FECACA;border-top:3px solid #EF4444;box-shadow:0 10px 20px -10px rgba(239,68,68,0.18);width:32%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.06em;color:#991B1B;text-transform:uppercase;font-weight:700;">Spent (${days} Days)</div>
            <div class="pp-num" style="font-size:18px;font-weight:800;color:#DC2626;margin-top:6px;">${escapeHtml(fmt(s.netSpentTodayPaise))}</div>
          </td>
          <td class="pp-stack-spacer" style="width:2%;"></td>
          <td class="pp-stack-col pp-kpi-2 pp-3d-tile" style="padding:14px;background:#ECFDF5;border-radius:14px;border:1px solid #A7F3D0;border-top:3px solid #10B981;box-shadow:0 10px 20px -10px rgba(16,185,129,0.18);width:32%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.06em;color:#065F46;text-transform:uppercase;font-weight:700;">Income</div>
            <div class="pp-num" style="font-size:18px;font-weight:800;color:#059669;margin-top:6px;">${escapeHtml(fmt(s.incomePaise))}</div>
          </td>
          <td class="pp-stack-spacer" style="width:2%;"></td>
          <td class="pp-stack-col pp-kpi-3 pp-3d-tile" style="padding:14px;background:#F8FAFC;border-radius:14px;border:1px solid #CBD5E1;border-top:3px solid #0F766E;box-shadow:0 10px 20px -10px rgba(15,23,42,0.1);width:32%;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.06em;color:#475569;text-transform:uppercase;font-weight:700;">Net Flow</div>
            <div class="pp-num" style="font-size:18px;font-weight:800;color:${s.netFlowPaise >= 0 ? '#059669' : '#D97706'};margin-top:6px;">${escapeHtml(fmt(s.netFlowPaise))}</div>
          </td>
        </tr>
      </table>

      <div class="pp-block-rise pp-3d-tile" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:12px 14px;font-size:12px;color:#334155;margin-bottom:18px;">
        <strong>Activity:</strong> <span class="pp-num" style="color:#0F172A;font-weight:700;">${s.transactionCount}</span> entry(s)
        &middot; <strong>Daily Avg:</strong> <span class="pp-num" style="color:#0F172A;font-weight:700;">${escapeHtml(fmt(dailyAvgPaise))}</span>
        ${s.largestExpense ? ` &middot; <strong>Largest:</strong> ${escapeHtml(s.largestExpense.merchant)} (<span class="pp-num" style="color:#DC2626;font-weight:700;">${escapeHtml(fmt(s.largestExpense.amountPaise))}</span>)` : ''}
      </div>

      ${s.categoryTotals.length ? `
        <div class="pp-block-rise pp-3d-tile" style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px;padding:16px;margin-bottom:18px;box-shadow:0 8px 18px -10px rgba(15,23,42,0.08);">
          <div style="font-size:11px;letter-spacing:0.08em;color:#64748B;text-transform:uppercase;font-weight:700;margin-bottom:12px;">Category Breakdown</div>
          ${s.categoryTotals.slice(0, 6).map((c) => {
            const pct = Math.max(4, Math.round((c.totalPaise / totalCatPaise) * 100));
            return `
              <div style="margin-bottom:10px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:12px;margin-bottom:4px;">
                  <tr>
                    <td style="color:#334155;font-weight:600;">${escapeHtml(c.name)}</td>
                    <td class="pp-num" style="text-align:right;font-weight:700;color:#0F172A;">${escapeHtml(fmt(c.totalPaise))}</td>
                  </tr>
                </table>
                <div style="height:7px;background:#E2E8F0;border-radius:999px;overflow:hidden;">
                  <div class="pp-bar-fill" style="height:7px;width:${pct}%;background:linear-gradient(90deg,#10B981,#0F766E);border-radius:999px;"></div>
                </div>
              </div>`;
          }).join('')}
        </div>` : ''}

      ${s.topMerchants.length ? `
        <div class="pp-block-rise pp-3d-tile" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;padding:14px 16px;margin-bottom:18px;">
          <div style="font-size:11px;letter-spacing:0.08em;color:#64748B;text-transform:uppercase;font-weight:700;margin-bottom:10px;">Top Merchants</div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:12px;">
            ${s.topMerchants.map((m, i) => `
              <tr>
                <td style="padding:6px 0;color:#334155;${i > 0 ? 'border-top:1px solid #E2E8F0;' : ''}">${i + 1}. ${escapeHtml(m.merchant)}</td>
                <td class="pp-num" style="padding:6px 0;text-align:right;font-weight:700;color:#0F172A;${i > 0 ? 'border-top:1px solid #E2E8F0;' : ''}">${escapeHtml(fmt(m.totalPaise))}</td>
              </tr>
            `).join('')}
          </table>
        </div>` : ''}
    `}

    <!-- Monthly Budget Status Gauge -->
    <div class="pp-block-rise pp-3d-tile" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px;padding:16px;font-size:13px;color:#334155;box-shadow:0 8px 18px -10px rgba(15,23,42,0.06);">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:8px;">
        <tr>
          <td style="font-weight:700;color:#0F172A;font-size:12px;">Monthly Budget Usage</td>
          <td class="pp-num" style="text-align:right;font-size:12px;font-weight:800;color:${budgetBarColor};">${s.monthBudgetPaise > 0 ? `${s.budgetUsedPercent}%` : 'Not set'}</td>
        </tr>
      </table>
      ${s.monthBudgetPaise > 0 ? `
        <div style="height:8px;background:#E2E8F0;border-radius:999px;overflow:hidden;margin-bottom:8px;">
          <div class="pp-bar-fill" style="height:8px;width:${budgetPct}%;background:${budgetBarColor};border-radius:999px;"></div>
        </div>
        <div class="pp-num" style="font-size:12px;color:#475569;">${escapeHtml(fmt(s.monthSpentPaise))} of ${escapeHtml(fmt(s.monthBudgetPaise))} &middot; <strong>${escapeHtml(fmt(remainingBudgetPaise))}</strong> remaining</div>
      ` : `<div style="font-size:12px;color:#64748B;">Set a monthly budget in PaisaPilot to enable immediate exceedance alerts.</div>`}
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid #E2E8F0;font-size:12px;color:#64748B;">
        <strong>Uncategorized / Needs Review:</strong> <span class="pp-num" style="color:#0F172A;font-weight:600;">${s.uncategorizedOrReview}</span> item(s)
      </div>
    </div>

    ${s.unusualInsights.length ? `
      <div class="pp-block-rise pp-3d-tile" style="margin-top:16px;padding:12px 14px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;font-size:12px;color:#92400E;">
        <strong>Highlights:</strong>
        <ul style="margin:6px 0 0;padding-left:18px;">
          ${s.unusualInsights.map((ins) => `<li>${escapeHtml(ins.title)}</li>`).join('')}
        </ul>
      </div>` : ''}

    <!-- Add-On Quick Action Tiles -->
    <div style="margin-top:18px;">
      <div style="font-size:10px;letter-spacing:0.08em;color:#64748B;text-transform:uppercase;font-weight:700;margin-bottom:8px;">Quick Actions</div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
        <tr>
          <td class="pp-stack-col pp-addon-1 pp-3d-tile" style="width:32%;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px;padding:11px;text-align:center;box-shadow:0 6px 14px -8px rgba(15,23,42,0.1);">
            <a href="${escapeHtml(s.appUrl)}/import" style="text-decoration:none;color:#0F172A;display:block;">
              <div style="font-size:11px;font-weight:700;color:#059669;">Scan Receipt</div>
              <div style="font-size:10px;color:#64748B;margin-top:2px;">Upload image / CSV</div>
            </a>
          </td>
          <td class="pp-stack-spacer" style="width:2%;"></td>
          <td class="pp-stack-col pp-addon-2 pp-3d-tile" style="width:32%;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px;padding:11px;text-align:center;box-shadow:0 6px 14px -8px rgba(15,23,42,0.1);">
            <a href="${escapeHtml(s.appUrl)}/transactions" style="text-decoration:none;color:#0F172A;display:block;">
              <div style="font-size:11px;font-weight:700;color:#0F766E;">Add Expense</div>
              <div style="font-size:10px;color:#64748B;margin-top:2px;">Log manual entry</div>
            </a>
          </td>
          <td class="pp-stack-spacer" style="width:2%;"></td>
          <td class="pp-stack-col pp-addon-3 pp-3d-tile" style="width:32%;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px;padding:11px;text-align:center;box-shadow:0 6px 14px -8px rgba(15,23,42,0.1);">
            <a href="${escapeHtml(s.appUrl)}/budgets" style="text-decoration:none;color:#0F172A;display:block;">
              <div style="font-size:11px;font-weight:700;color:#D97706;">Edit Budgets</div>
              <div style="font-size:10px;color:#64748B;margin-top:2px;">Limits &amp; alerts</div>
            </a>
          </td>
        </tr>
      </table>
    </div>

    <div style="margin-top:22px;text-align:center;">
      <a class="pp-cta-btn" href="${escapeHtml(s.appUrl)}/dashboard" style="display:inline-block;background:linear-gradient(135deg,#10B981,#059669);color:#FFFFFF;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:12px;font-size:13px;box-shadow:0 12px 24px -8px rgba(5,150,105,0.38),inset 0 1px 0 rgba(255,255,255,0.3);">Open PaisaPilot Dashboard</a>
    </div>

    <p style="margin:18px 0 0;font-size:11px;color:#64748B;text-align:center;">
      Automated every 4 days &middot; Full account numbers and raw payment references are omitted for privacy.
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
  ${renderEmailStyles('#DC2626')}
</head>
<body class="pp-body-pad" style="margin:0;padding:24px;background:#EEF2F7;color:#0F172A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div class="pp-email-shell pp-card-pad" style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #FECACA;border-radius:22px;padding:28px;box-shadow:0 24px 48px -14px rgba(220,38,38,0.14),0 4px 12px -2px rgba(15,23,42,0.05);">
    <div style="display:inline-block;padding:4px 10px;border-radius:999px;background:#FEF2F2;border:1px solid #FECACA;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#DC2626;font-weight:700;">
      <span class="pp-pulse-dot" style="width:7px;height:7px;border-radius:999px;background:#DC2626;margin-right:5px;vertical-align:middle;"></span>PaisaPilot &middot; Budget Alert
    </div>
    <h1 style="margin:10px 0 10px;font-size:20px;font-weight:700;color:#0F172A;">${escapeHtml(scopeLabel)} exceeded (${escapeHtml(monthKey)})</h1>
    <p style="margin:0 0 18px;color:#334155;font-size:14px;line-height:1.55;">Hi <strong style="color:#0F172A;">${escapeHtml(userName)}</strong>, your spending just crossed your configured budget limit.</p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:16px;">
      <tr>
        <td class="pp-stack-col pp-kpi-1 pp-3d-tile" style="padding:14px;background:#F8FAFC;border-radius:14px;border:1px solid #E2E8F0;box-shadow:0 8px 18px -8px rgba(15,23,42,0.08);width:32%;">
          <div style="font-size:10px;color:#64748B;text-transform:uppercase;font-weight:700;">Budget Limit</div>
          <div class="pp-num" style="font-size:17px;font-weight:800;color:#0F172A;margin-top:6px;">${escapeHtml(fmt(limitPaise))}</div>
        </td>
        <td class="pp-stack-spacer" style="width:2%;"></td>
        <td class="pp-stack-col pp-kpi-2 pp-3d-tile" style="padding:14px;background:#FEF2F2;border-radius:14px;border:1px solid #FECACA;border-top:3px solid #EF4444;box-shadow:0 8px 18px -8px rgba(239,68,68,0.16);width:32%;">
          <div style="font-size:10px;color:#991B1B;text-transform:uppercase;font-weight:700;">Total Spent</div>
          <div class="pp-num" style="font-size:17px;font-weight:800;color:#DC2626;margin-top:6px;">${escapeHtml(fmt(spentPaise))}</div>
        </td>
        <td class="pp-stack-spacer" style="width:2%;"></td>
        <td class="pp-stack-col pp-kpi-3 pp-3d-tile" style="padding:14px;background:#FFFBEB;border-radius:14px;border:1px solid #FDE68A;border-top:3px solid #F59E0B;box-shadow:0 8px 18px -8px rgba(245,158,11,0.16);width:32%;">
          <div style="font-size:10px;color:#92400E;text-transform:uppercase;font-weight:700;">Exceeded By</div>
          <div class="pp-num" style="font-size:17px;font-weight:800;color:#D97706;margin-top:6px;">+${escapeHtml(fmt(overPaise))}</div>
        </td>
      </tr>
    </table>

    <div class="pp-block-rise pp-3d-tile" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:12px 14px;font-size:12px;color:#334155;">
      <div style="height:7px;background:#E2E8F0;border-radius:999px;overflow:hidden;margin-bottom:8px;">
        <div class="pp-bar-fill" style="height:7px;width:100%;background:linear-gradient(90deg,#F59E0B,#DC2626);border-radius:999px;"></div>
      </div>
      ${triggerMerchant ? `<div><strong>Latest Entry:</strong> ${escapeHtml(triggerMerchant)} (<span class="pp-num" style="color:#DC2626;font-weight:700;">${escapeHtml(fmt(triggerAmountPaise))}</span>)</div>` : '<div>Monthly spending has exceeded the configured limit.</div>'}
    </div>

    <div style="margin-top:22px;text-align:center;">
      <a class="pp-cta-btn" href="${escapeHtml(appUrl)}/budgets" style="display:inline-block;background:linear-gradient(135deg,#EF4444,#DC2626);color:#FFFFFF;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:12px;font-size:13px;box-shadow:0 12px 24px -8px rgba(220,38,38,0.4),inset 0 1px 0 rgba(255,255,255,0.25);">Review Budgets in PaisaPilot</a>
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
