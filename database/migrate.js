require('dotenv').config();
const { initDatabase, closeDatabase } = require('../lib/db');

(async () => {
  try {
    await initDatabase();
    console.log('[PaisaPilot] Database migrations completed successfully.');
    await closeDatabase();
    process.exit(0);
  } catch (err) {
    console.error('[PaisaPilot] Migration failed:', err.message);
    process.exit(1);
  }
})();
