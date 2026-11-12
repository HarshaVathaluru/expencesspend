const { createApp } = require('../server');
const db = require('../lib/db');

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      try {
        await db.initDatabase();
      } catch (err) {
        appPromise = null; // allow retry on subsequent requests
        console.error('[PaisaPilot Vercel DB Init Error]:', err);
        throw err;
      }
      return createApp();
    })();
  }
  return appPromise;
}

module.exports = async (req, res) => {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    console.error('[PaisaPilot Vercel Handler Error]:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <div style="font-family:sans-serif;padding:32px;max-width:680px;margin:40px auto;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;color:#0f172a;">
        <h2 style="color:#dc2626;margin-top:0;">PaisaPilot Startup Diagnostic</h2>
        <p><strong>Error Message:</strong> ${err.message || 'Unknown error'}</p>
        <pre style="background:#0f172a;color:#f8fafc;padding:16px;border-radius:8px;overflow-x:auto;font-size:12px;">${err.stack || ''}</pre>
        <p style="font-size:13px;color:#64748b;">Check your Vercel Environment Variables: <code>DATABASE_URL</code>, <code>AUTH_SECRET</code>, <code>BREVO_API_KEY</code>, <code>GEMINI_API_KEY</code>.</p>
      </div>
    `);
  }
};
