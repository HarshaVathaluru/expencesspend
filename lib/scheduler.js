const db = require('./db');
const { getDatePartsInTz } = require('./money');
const { deliverDailyReportForUser } = require('./brevo');
const logger = require('./logger');

let timerHandle = null;
let running = false;

function daysBetweenYmd(startYmd, endYmd) {
  const [y1, m1, d1] = String(startYmd).split('-').map(Number);
  const [y2, m2, d2] = String(endYmd).split('-').map(Number);
  const t1 = Date.UTC(y1, (m1 || 1) - 1, d1 || 1);
  const t2 = Date.UTC(y2, (m2 || 1) - 1, d2 || 1);
  return Math.floor((t2 - t1) / 86400000);
}

async function tickDailyScheduler() {
  if (running) return;
  running = true;
  try {
    const enabledUsers = await db.query(
      `SELECT us.user_id, us.timezone, us.daily_email_time, us.email_verified
       FROM user_settings us
       JOIN users u ON u.id = us.user_id
       WHERE us.daily_email_enabled = 1 AND us.email_verified = 1 AND u.deleted_at IS NULL`
    );

    const now = new Date();
    for (const row of enabledUsers) {
      const tz = row.timezone || 'Asia/Kolkata';
      const targetTime = row.daily_email_time || '23:00';
      const parts = getDatePartsInTz(now, tz);

      // Fire when current local HH:MM >= configured HH:MM AND at least 4 days elapsed since last 4-day report
      if (parts.hhmm >= targetTime) {
        const key = `${row.user_id}:${parts.localDate}:daily_summary`;
        const alreadyAttempted = await db.get(
          `SELECT id, status FROM daily_reports WHERE idempotency_key = ?`,
          [key]
        );
        if (alreadyAttempted) continue;

        const lastSent = await db.get(
          `SELECT report_date FROM daily_reports
           WHERE user_id = ? AND status = 'sent' AND idempotency_key LIKE ?
           ORDER BY report_date DESC LIMIT 1`,
          [row.user_id, '%:daily_summary']
        );
        if (lastSent && daysBetweenYmd(lastSent.report_date, parts.localDate) < 4) {
          continue;
        }

        logger.info('Scheduler triggering 4-day expenses digest', { userId: row.user_id, localDate: parts.localDate, tz });
        await deliverDailyReportForUser({
          userId: row.user_id,
          localDate: parts.localDate,
          reportType: 'daily_summary',
          force: false
        });
      }
    }
  } catch (err) {
    logger.error('Scheduler tick failed', { error: err.message });
  } finally {
    running = false;
  }
}

function startScheduler() {
  if (timerHandle) return;
  // Check every 60 seconds; safe & lightweight in single-node server.js
  timerHandle = setInterval(() => {
    tickDailyScheduler().catch((e) => logger.error('Unhandled scheduler error', { error: e.message }));
  }, 60 * 1000);
  if (timerHandle.unref) timerHandle.unref();
  logger.info('Daily email scheduler started', { intervalSeconds: 60 });
}

function stopScheduler() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  tickDailyScheduler
};
