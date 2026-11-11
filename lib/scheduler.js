const db = require('./db');
const { getDatePartsInTz } = require('./money');
const { deliverDailyReportForUser } = require('./brevo');
const logger = require('./logger');

let timerHandle = null;
let running = false;

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

      // Fire when current local HH:MM >= configured HH:MM (idempotency key guarantees max 1 send per user per local date)
      if (parts.hhmm >= targetTime) {
        const key = `${row.user_id}:${parts.localDate}:daily_summary`;
        const alreadyAttempted = await db.get(
          `SELECT id, status FROM daily_reports WHERE idempotency_key = ?`,
          [key]
        );
        if (!alreadyAttempted) {
          logger.info('Scheduler triggering daily 11 PM digest', { userId: row.user_id, localDate: parts.localDate, tz });
          await deliverDailyReportForUser({
            userId: row.user_id,
            localDate: parts.localDate,
            reportType: 'daily_summary',
            force: false
          });
        }
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
