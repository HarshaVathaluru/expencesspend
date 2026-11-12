require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

const db = require('./lib/db');
const logger = require('./lib/logger');
const { getAiStatus } = require('./lib/ai');
const { isBrevoConfigured } = require('./lib/brevo');
const { startScheduler, stopScheduler } = require('./lib/scheduler');

const authRoutes = require('./routes/auth');
const txRoutes = require('./routes/transactions');
const ingestionRoutes = require('./routes/ingestion');
const planningRoutes = require('./routes/planning');
const aiRoutes = require('./routes/ai');
const reportsEmailSettingsRoutes = require('./routes/reportsEmailSettings');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"]
        }
      },
      crossOriginEmbedderPolicy: false
    })
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  // Static assets & local Three.js vendor bundle (same origin, zero CDN dependency)
  const publicDir = fs.existsSync(path.join(__dirname, 'public'))
    ? path.join(__dirname, 'public')
    : path.resolve(process.cwd(), 'public');
  app.use(express.static(publicDir, {
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (/\.(css|js|html)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  const vendorThreeDir = fs.existsSync(path.join(__dirname, 'node_modules/three/build'))
    ? path.join(__dirname, 'node_modules/three/build')
    : path.resolve(process.cwd(), 'node_modules/three/build');
  app.use('/vendor/three', express.static(vendorThreeDir, { maxAge: '7d' }));

  // Health endpoint (verifies readiness without exposing any secrets)
  app.get('/health', async (req, res) => {
    const dbHealth = await db.healthCheck();
    const ai = getAiStatus();
    const status = dbHealth.ok ? 200 : 503;
    res.status(status).json({
      ok: dbHealth.ok,
      app: process.env.APP_NAME || 'PaisaPilot',
      env: process.env.NODE_ENV || 'development',
      database: dbHealth,
      ai: { enabled: ai.geminiConfigured, mode: ai.mode },
      brevoConfigured: isBrevoConfigured(),
      uptimeSeconds: Math.floor(process.uptime())
    });
  });

  // Versioned API v1
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1', txRoutes);
  app.use('/api/v1', ingestionRoutes);
  app.use('/api/v1', planningRoutes);
  app.use('/api/v1/ai', aiRoutes);
  app.use('/api/v1', reportsEmailSettingsRoutes);

  // Unknown API routes return consistent JSON 404
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  // Serve unified single-origin UI shell for all app views
  const indexHtml = fs.existsSync(path.join(__dirname, 'views', 'index.html'))
    ? path.join(__dirname, 'views', 'index.html')
    : path.resolve(process.cwd(), 'views', 'index.html');
  const spaRoutes = [
    '/',
    '/auth',
    '/dashboard',
    '/transactions',
    '/transactions/new',
    '/import',
    '/sources',
    '/reconciliation',
    '/budgets',
    '/goals',
    '/recurring',
    '/insights',
    '/reports',
    '/email-settings',
    '/settings'
  ];
  app.get(spaRoutes, (req, res) => {
    res.sendFile(indexHtml);
  });

  // Centralized error handler (never leaks stack traces or secrets in production)
  app.use((err, req, res, next) => {
    const status = err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    logger.error('Request error', {
      method: req.method,
      path: req.originalUrl,
      status,
      error: err.message
    });
    res.status(status).json({
      error: status >= 500 && process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message || 'Request failed'
    });
  });

  return app;
}

async function startServer() {
  try {
    await db.initDatabase();
    const app = createApp();
    const port = Number(process.env.PORT || 3000);
    const server = app.listen(port, () => {
      const baseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
      logger.info('PaisaPilot server listening', {
        port,
        env: process.env.NODE_ENV || 'development',
        url: baseUrl,
        dbEngine: db.getEngine(),
        geminiAiEnabled: getAiStatus().geminiConfigured,
        brevoConfigured: isBrevoConfigured()
      });
      console.log(`\n  PaisaPilot running at ${baseUrl} (port ${port}, env=${process.env.NODE_ENV || 'development'})\n`);
    });

    startScheduler();

    const shutdown = async () => {
      stopScheduler();
      server.close(async () => {
        await db.closeDatabase();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return server;
  } catch (err) {
    console.error('\n[PaisaPilot] Startup failed:', err.message);
    console.error('Check DATABASE_URL and environment configuration in .env (see .env.example).\n');
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };
