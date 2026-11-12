const { createApp } = require('../server');
const db = require('../lib/db');

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      await db.initDatabase();
      return createApp();
    })();
  }
  return appPromise;
}

module.exports = async (req, res) => {
  const app = await getApp();
  return app(req, res);
};
