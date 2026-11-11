const db = require('./db');
const { newId } = require('./crypto');
const logger = require('./logger');

async function recordAudit({ userId = null, action, resourceType, resourceId = null, req = null, metadata = {} }) {
  try {
    const ip = req ? (req.ip || req.headers['x-forwarded-for'] || 'unknown') : 'system';
    const ua = req ? String(req.headers['user-agent'] || '').slice(0, 200) : 'system';
    await db.run(
      `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, ip_address, user_agent, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('aud'),
        userId,
        action,
        resourceType,
        resourceId,
        String(ip).slice(0, 64),
        ua,
        JSON.stringify(logger.redact(metadata)),
        new Date().toISOString()
      ]
    );
  } catch (err) {
    logger.warn('Failed to write audit log', { error: err.message, action });
  }
}

module.exports = { recordAudit };
