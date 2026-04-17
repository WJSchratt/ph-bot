const db = require('../db');
const logger = require('./logger');

/**
 * Lightweight background job runner. Spawns the task function asynchronously,
 * writes progress to the `jobs` table. UI polls GET /api/jobs/:id for status.
 *
 * No queue infra — runs in-process via setImmediate. Good enough for a
 * single-instance deploy (Railway's default). If we ever scale horizontally,
 * swap this out for Redis/BullMQ.
 */
async function createJob({ type, params = null, startedBy = null }) {
  const q = await db.query(
    `INSERT INTO jobs (job_type, status, params, started_by, created_at)
     VALUES ($1, 'queued', $2, $3, NOW())
     RETURNING id`,
    [type, params ? JSON.stringify(params) : null, startedBy]
  );
  return q.rows[0].id;
}

async function updateProgress(jobId, { current, total, message }) {
  const sets = ['updated_at = NOW()'];
  const params = [jobId];
  if (current !== undefined && current !== null) {
    params.push(current);
    sets.push(`progress_current = $${params.length}`);
  }
  if (total !== undefined && total !== null) {
    params.push(total);
    sets.push(`progress_total = $${params.length}`);
  }
  if (message !== undefined && message !== null) {
    params.push(message);
    sets.push(`progress_message = $${params.length}`);
  }
  await db.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $1`, params);
}

async function markRunning(jobId) {
  await db.query(
    `UPDATE jobs SET status = 'running', started_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [jobId]
  );
}

async function markCompleted(jobId, result = null) {
  await db.query(
    `UPDATE jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
                     result = $2,
                     progress_message = 'done'
     WHERE id = $1`,
    [jobId, result ? JSON.stringify(result) : null]
  );
}

async function markFailed(jobId, err) {
  const msg = (err && err.message) || String(err);
  await db.query(
    `UPDATE jobs SET status = 'failed', completed_at = NOW(), updated_at = NOW(), error = $2 WHERE id = $1`,
    [jobId, msg.slice(0, 2000)]
  );
}

/**
 * Spawn a job in the background. `workFn` receives a progress reporter and
 * should return the result (or throw). Don't await the returned promise from
 * an HTTP handler — return the job ID immediately so the client can poll.
 */
function spawn(jobId, workFn) {
  setImmediate(async () => {
    try {
      await markRunning(jobId);
      const reporter = {
        report: (p) => updateProgress(jobId, p).catch(() => {})
      };
      const result = await workFn(reporter);
      await markCompleted(jobId, result);
    } catch (err) {
      logger.log('jobs', 'error', null, 'job failed', { jobId, error: err.message, stack: err.stack });
      await markFailed(jobId, err).catch(() => {});
    }
  });
}

async function getJob(jobId) {
  const q = await db.query(
    `SELECT id, job_type, status, progress_current, progress_total, progress_message,
            params, result, error, started_by, started_at, completed_at, created_at, updated_at
       FROM jobs WHERE id = $1`,
    [jobId]
  );
  return q.rows[0] || null;
}

async function listRecent({ type, limit = 20 } = {}) {
  const params = [];
  let where = '';
  if (type) {
    params.push(type);
    where = `WHERE job_type = $${params.length}`;
  }
  params.push(limit);
  const q = await db.query(
    `SELECT id, job_type, status, progress_current, progress_total, progress_message,
            error, started_at, completed_at, created_at
       FROM jobs ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return q.rows;
}

module.exports = { createJob, spawn, getJob, listRecent, updateProgress, markRunning, markCompleted, markFailed };
