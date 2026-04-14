require('dotenv').config();
const { aggregateAnalytics } = require('../routes/cron');
const { pool } = require('../db');

(async () => {
  try {
    await aggregateAnalytics(process.argv[2]);
    console.log('[cron:aggregate] done');
  } catch (err) {
    console.error('[cron:aggregate] failed', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
