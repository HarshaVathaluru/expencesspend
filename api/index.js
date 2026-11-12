const { createApp } = require('../server');
const db = require('../lib/db');

let app = null;
let dbError = null;

async function setup() {
  if (!app) {
    try {
      await db.initDatabase();
      dbError = null;
    } catch (err) {
      dbError = err;
      console.error('[PaisaPilot DB Init Error]:', err.message);
    }
    app = createApp();
  }
}

module.exports = async (req, res) => {
  await setup();
  if (dbError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>PaisaPilot - Database Configuration Required</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f17; color: #f1f5f9; padding: 40px 20px; }
          .card { max-width: 640px; margin: 0 auto; background: #161e2e; border: 1px solid #2d3748; border-radius: 16px; padding: 32px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
          h2 { color: #f87171; margin-top: 0; font-size: 22px; }
          .error-box { background: #1e1014; border: 1px solid #7f1d1d; color: #fca5a5; padding: 14px 18px; border-radius: 8px; font-family: monospace; font-size: 13px; margin: 16px 0; word-break: break-all; }
          p { line-height: 1.6; color: #cbd5e1; font-size: 14px; }
          code { background: #242f3d; padding: 2px 6px; border-radius: 4px; color: #38bdf8; font-family: monospace; }
          .tip { background: #172554; border: 1px solid #1e40af; padding: 12px 16px; border-radius: 8px; margin-top: 16px; font-size: 13px; color: #93c5fd; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>⚠️ PaisaPilot Database Connection Issue</h2>
          <p>The app started successfully on Vercel, but cannot connect to the PostgreSQL database:</p>
          <div class="error-box">${dbError.message || dbError}</div>
          <p><strong>Common causes:</strong></p>
          <ul>
            <li>Supabase Direct vs Pooler URL: Use the Supabase <strong>Session</strong> or <strong>Transaction Pooler</strong> (port 6543 or 5432) with host <code>aws-0-[region].pooler.supabase.com</code>.</li>
            <li>Password encoding: If your password has an <code>@</code> symbol, encode it as <code>%40</code>.</li>
          </ul>
          <div class="tip">
            Update <code>DATABASE_URL</code> in your Vercel Project Settings ➔ Environment Variables, then redeploy.
          </div>
        </div>
      </body>
      </html>
    `);
  }
  return app(req, res);
};
