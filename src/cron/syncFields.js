require('dotenv').config();
const { syncDirtyFields } = require('../routes/cron');
const { pool } = require('../db');

(async () => {
  try {
    const result = await syncDirtyFields();
    console.log('[cron:sync] done', result);
  } catch (err) {
    console.error('[cron:sync] failed', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
