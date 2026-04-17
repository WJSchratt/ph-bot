const crypto = require('crypto');
const db = require('../db');
const { callAnthropic } = require('./anthropic');
const logger = require('./logger');

const MODEL = 'claude-sonnet-4-20250514';
const LABEL_BATCH_SIZE = 20;         // clusters labeled per Claude call
const LABEL_SAMPLES_PER_CLUSTER = 3; // example variants sent per cluster
const MIN_CLUSTER_SIZE = 2;          // don't label one-off templates

/**
 * Normalize a message to its template form so near-identical sends collapse
 * into one cluster. Strips personalization (names, numbers, times, URLs) and
 * collapses whitespace/punctuation.
 */
function normalizeMessage(text) {
  if (!text || typeof text !== 'string') return '';
  let t = text.toLowerCase().trim();
  t = t.replace(/https?:\/\/\S+/g, '{url}');
  t = t.replace(/\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/g, '{time}');
  t = t.replace(/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/g, '{day}');
  t = t.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g, '{month}');
  t = t.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, '{date}');
  t = t.replace(/\$\d+(\.\d{2})?/g, '{money}');
  t = t.replace(/\b\d{3,}\b/g, '{num}');
  t = t.replace(/\b\d+\b/g, '{n}');
  // Strip likely first-name tokens after common greetings.
  t = t.replace(/\b(hey|hi|hello|good morning|good afternoon|morning|afternoon)[,\s]+[a-z]+\b/g, '$1 {name}');
  // Generic capitalized-word stripping is too aggressive; skip to avoid false merges.
  t = t.replace(/[^\w\s{}]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function hashNormalized(normalized) {
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 40);
}

/**
 * First-pass: for every unclustered outbound ghl_message, compute normalized
 * hash. Bucket by hash → create/attach clusters for buckets of size >= min.
 */
async function assignHashClusters({ limit = 5000 } = {}) {
  const q = await db.query(
    `SELECT m.id, m.content, gc.source, m.created_at
       FROM ghl_messages m
       JOIN ghl_conversations gc ON gc.ghl_conversation_id = m.ghl_conversation_id AND gc.location_id = m.location_id
      WHERE m.direction = 'outbound'
        AND m.cluster_id IS NULL
      ORDER BY m.created_at DESC
      LIMIT $1`,
    [limit]
  );

  const buckets = new Map();  // hash -> { hash, source, messages: [{id, content, created_at}] }
  for (const row of q.rows) {
    const norm = normalizeMessage(row.content || '');
    if (!norm) continue;
    const hash = hashNormalized(norm);
    if (!buckets.has(hash)) buckets.set(hash, { hash, normalized: norm, sources: new Set(), messages: [] });
    const b = buckets.get(hash);
    if (row.source) b.sources.add(row.source);
    b.messages.push({ id: row.id, content: row.content, created_at: row.created_at });
  }

  // Write normalized_hash for every processed row so we can avoid re-normalizing later.
  const updates = [];
  for (const [hash, b] of buckets.entries()) {
    for (const m of b.messages) updates.push([m.id, hash]);
  }
  // Batch-update the hash column.
  if (updates.length) {
    const CHUNK = 500;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      const valuesSql = chunk.map((_, j) => `($${j * 2 + 1}::int, $${j * 2 + 2}::varchar)`).join(', ');
      const params = chunk.flat();
      await db.query(
        `UPDATE ghl_messages SET normalized_hash = u.hash
           FROM (VALUES ${valuesSql}) AS u(id, hash)
          WHERE ghl_messages.id = u.id`,
        params
      );
    }
  }

  // For each bucket >= MIN_CLUSTER_SIZE: upsert cluster, link all messages.
  let createdClusters = 0;
  let attachedMessages = 0;
  for (const [hash, b] of buckets.entries()) {
    if (b.messages.length < MIN_CLUSTER_SIZE) continue;
    const source = b.sources.size === 1 ? [...b.sources][0] : 'mixed';
    const firstMsg = b.messages[b.messages.length - 1];
    const lastMsg = b.messages[0];
    const upsert = await db.query(
      `INSERT INTO word_track_clusters (label, description, source, example_text, normalized_hash, cluster_size, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (normalized_hash) DO UPDATE
         SET cluster_size = word_track_clusters.cluster_size + EXCLUDED.cluster_size,
             last_seen_at = GREATEST(word_track_clusters.last_seen_at, EXCLUDED.last_seen_at),
             updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        'unlabeled',
        null,
        source,
        b.messages[0].content.slice(0, 500),
        hash,
        b.messages.length,
        firstMsg.created_at,
        lastMsg.created_at
      ]
    );
    const clusterId = upsert.rows[0].id;
    if (upsert.rows[0].inserted) createdClusters++;

    const ids = b.messages.map((m) => m.id);
    // Link messages to cluster.
    await db.query(
      `UPDATE ghl_messages SET cluster_id = $1 WHERE id = ANY($2) AND cluster_id IS NULL`,
      [clusterId, ids]
    );
    attachedMessages += ids.length;
  }

  return { scanned: q.rows.length, buckets: buckets.size, created_clusters: createdClusters, attached_messages: attachedMessages };
}

/**
 * Second pass: batch-label unlabeled clusters via Claude. One call labels up
 * to LABEL_BATCH_SIZE clusters at a time.
 */
async function labelUnlabeledClusters({ maxBatches = 5 } = {}) {
  let totalLabeled = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const { rows: clusters } = await db.query(
      `SELECT id, example_text, source, cluster_size
         FROM word_track_clusters
        WHERE label = 'unlabeled' OR labeled_at IS NULL
        ORDER BY cluster_size DESC, id ASC
        LIMIT $1`,
      [LABEL_BATCH_SIZE]
    );
    if (!clusters.length) break;

    // Pull additional examples per cluster (up to LABEL_SAMPLES_PER_CLUSTER).
    const clusterBlocks = [];
    for (const c of clusters) {
      const samplesQ = await db.query(
        `SELECT content FROM ghl_messages WHERE cluster_id = $1 AND direction = 'outbound' LIMIT $2`,
        [c.id, LABEL_SAMPLES_PER_CLUSTER]
      );
      const samples = samplesQ.rows.map((r) => r.content).filter(Boolean);
      if (!samples.length) samples.push(c.example_text);
      clusterBlocks.push({ id: c.id, samples });
    }

    const prompt = `You are labeling SMS bot message templates for a life-insurance qualification funnel.
For each numbered cluster below, assign:
  • label: a short kebab-case label (<=40 chars) describing the message's function/stage (examples: "greeting-aged-lead", "budget-objection-response", "tie-down-confirmation", "ai-disclosure", "dnc-confirmation", "spouse-decision-probe", "rescheduling-offer").
  • description: a one-sentence plain-English description.

Return ONLY JSON: { "clusters": [{ "id": <n>, "label": "...", "description": "..." }, ...] }

CLUSTERS:
${clusterBlocks.map((c, i) => `--- CLUSTER ${c.id} ---\n${c.samples.map((s, j) => `ex${j + 1}: ${s}`).join('\n')}`).join('\n\n')}
`;

    const resp = await callAnthropic(
      {
        model: MODEL,
        max_tokens: 2500,
        system: 'You label SMS message templates. Output only valid JSON. Be consistent: similar templates should get the same label across calls when possible.',
        messages: [{ role: 'user', content: prompt }]
      },
      { category: 'word_track_clustering', location_id: null, meta: { cluster_count: clusters.length, batch: batch + 1 } }
    );

    const text = (resp.content.find((b) => b.type === 'text')?.text || '').trim();
    let parsed = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (err) {
      logger.log('wordtrack_cluster', 'warn', null, 'Label JSON parse failed', { batch: batch + 1, error: err.message, raw: text.slice(0, 500) });
    }
    const items = parsed?.clusters || [];

    for (const item of items) {
      if (!item.id || !item.label) continue;
      await db.query(
        `UPDATE word_track_clusters
            SET label = $1,
                description = $2,
                labeled_at = NOW(),
                updated_at = NOW()
          WHERE id = $3`,
        [String(item.label).slice(0, 200), item.description || null, item.id]
      );
      totalLabeled++;
    }
  }
  return { labeled: totalLabeled };
}

async function runFullPipeline(opts = {}) {
  const assign = await assignHashClusters({ limit: opts.scan_limit || 5000 });
  const label = await labelUnlabeledClusters({ maxBatches: opts.max_label_batches || 5 });
  logger.log('wordtrack_cluster', 'info', null, 'Clustering pipeline run', { ...assign, ...label });
  return { ...assign, ...label };
}

module.exports = {
  normalizeMessage,
  hashNormalized,
  assignHashClusters,
  labelUnlabeledClusters,
  runFullPipeline
};
