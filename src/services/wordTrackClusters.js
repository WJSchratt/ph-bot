const crypto = require('crypto');
const db = require('../db');
const { callAnthropic } = require('./anthropic');
const logger = require('./logger');

const MODEL = 'claude-sonnet-4-20250514';
const LABEL_BATCH_SIZE = 20;            // workflows or word-track clusters labeled per Claude call
const LABEL_SAMPLES_PER_CLUSTER = 3;    // example variants sent per cluster
const MIN_WORKFLOW_SIZE = 2;            // openers bucket >= N to form a workflow
const MIN_WT_CLUSTER_SIZE = 2;          // word-track bucket >= N to form a cluster (except position 1 which inherits the workflow)

/**
 * Two-layer word track model:
 *
 *   LAYER 1 — Workflow identity
 *     The first outbound message of every ghl_conversation is the "opener".
 *     Normalize + hash → bucket. Buckets of >= MIN_WORKFLOW_SIZE become
 *     workflow_clusters. Each conversation is then mapped to its workflow
 *     via conversation_workflow_assignment.
 *
 *   LAYER 2 — Per-position word tracks
 *     For each workflow, enumerate outbound messages by their outbound-index
 *     within the conversation (strict outbound position: 1, 2, 3, ...).
 *     Reason for strict outbound index vs turn-relative: drip sequences
 *     that fire multiple messages before any reply should still be tracked
 *     by their send order, not user-interleaved turns. Inbound interleaving
 *     varies; the agent's message cadence does not.
 *     Position 1 clusters = the openers (already identified by workflow
 *     cluster). Positions 2+ are clustered within each workflow bucket.
 *     Each word_track_cluster is uniquely keyed by
 *     (workflow_cluster_id, position, normalized_hash).
 */

function normalizeMessage(text) {
  if (!text || typeof text !== 'string') return '';
  let t = text.toLowerCase().trim();
  t = t.replace(/https?:\/\/\S+/g, '{url}');
  t = t.replace(/\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/g, '{time}');
  t = t.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/g, '{day}');
  t = t.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g, '{month}');
  t = t.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, '{date}');
  t = t.replace(/\$\d+(\.\d{2})?/g, '{money}');
  t = t.replace(/\b\d{3,}\b/g, '{num}');
  t = t.replace(/\b\d+\b/g, '{n}');
  // Strip name tokens after a greeting only when followed by sentence punctuation —
  // avoids eating legitimate words in "hey, just here" constructions.
  t = t.replace(/\b(hey|hi|hello|good morning|good afternoon)\s+[a-z]+(?=[,.!?])/g, '$1 {name}');
  t = t.replace(/[^\w\s{}]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function hashNormalized(normalized) {
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 40);
}

// ────────────────────────────────────────────────────────────────────────
// Reset: clear clustering state before a full rebuild.
// ────────────────────────────────────────────────────────────────────────

async function resetClusteringState() {
  await db.query(`UPDATE ghl_messages SET cluster_id = NULL WHERE cluster_id IS NOT NULL`);
  await db.query(`DELETE FROM conversation_workflow_assignment`);
  await db.query(`DELETE FROM word_track_clusters`);
  await db.query(`DELETE FROM workflow_clusters`);
}

// ────────────────────────────────────────────────────────────────────────
// Layer 1: workflow clusters from conversation openers.
// ────────────────────────────────────────────────────────────────────────

async function buildWorkflowClusters(reporter) {
  // First outbound message per conversation (the opener).
  const openersQ = await db.query(
    `SELECT DISTINCT ON (m.ghl_conversation_id, m.location_id)
            m.id AS msg_id,
            m.ghl_conversation_id,
            m.location_id,
            m.content,
            m.created_at
       FROM ghl_messages m
      WHERE m.direction = 'outbound'
        AND COALESCE(m.content, '') <> ''
      ORDER BY m.ghl_conversation_id, m.location_id, m.created_at ASC`
  );

  const buckets = new Map(); // hash → { normalized, example, convs: [{ghlConvId, locationId, msgId, ts}] }
  for (const r of openersQ.rows) {
    const norm = normalizeMessage(r.content || '');
    if (!norm) continue;
    const hash = hashNormalized(norm);
    if (!buckets.has(hash)) {
      buckets.set(hash, { normalized: norm, example: r.content.slice(0, 500), convs: [] });
    }
    buckets.get(hash).convs.push({
      ghlConvId: r.ghl_conversation_id,
      locationId: r.location_id,
      msgId: r.msg_id,
      ts: r.created_at
    });
  }

  if (reporter) reporter.report({ message: `Layer 1: ${buckets.size} opener buckets from ${openersQ.rows.length} conversations` });

  let workflowsCreated = 0;
  let convsAssigned = 0;
  for (const [hash, b] of buckets.entries()) {
    if (b.convs.length < MIN_WORKFLOW_SIZE) continue;
    const firstTs = b.convs.reduce((a, c) => !a || c.ts < a ? c.ts : a, null);
    const lastTs = b.convs.reduce((a, c) => !a || c.ts > a ? c.ts : a, null);
    const insert = await db.query(
      `INSERT INTO workflow_clusters (label, normalized_opener, opener_hash, example_opener, conversation_count, first_seen_at, last_seen_at)
       VALUES ('unlabeled', $1, $2, $3, $4, $5, $6)
       ON CONFLICT (opener_hash) DO UPDATE
         SET conversation_count = EXCLUDED.conversation_count,
             last_seen_at = GREATEST(workflow_clusters.last_seen_at, EXCLUDED.last_seen_at),
             updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [b.normalized, hash, b.example, b.convs.length, firstTs, lastTs]
    );
    const wfId = insert.rows[0].id;
    if (insert.rows[0].inserted) workflowsCreated++;

    // Assign every conversation in this bucket to the workflow.
    const CHUNK = 500;
    for (let i = 0; i < b.convs.length; i += CHUNK) {
      const chunk = b.convs.slice(i, i + CHUNK);
      const values = chunk.map((_, j) => `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5})`).join(',');
      const params = [];
      for (const c of chunk) params.push(c.ghlConvId, c.locationId, wfId, c.msgId, new Date());
      await db.query(
        `INSERT INTO conversation_workflow_assignment
           (ghl_conversation_id, location_id, workflow_cluster_id, opener_message_id, assigned_at)
         VALUES ${values}
         ON CONFLICT (ghl_conversation_id, location_id) DO UPDATE
           SET workflow_cluster_id = EXCLUDED.workflow_cluster_id,
               opener_message_id = EXCLUDED.opener_message_id,
               assigned_at = EXCLUDED.assigned_at`,
        params
      );
      convsAssigned += chunk.length;
    }
  }
  return { opener_buckets: buckets.size, workflows_created: workflowsCreated, conversations_assigned: convsAssigned };
}

// ────────────────────────────────────────────────────────────────────────
// Layer 2: per-position word tracks within each workflow.
// ────────────────────────────────────────────────────────────────────────

async function buildPerPositionClusters(reporter) {
  const workflowsQ = await db.query(`SELECT id, example_opener FROM workflow_clusters`);
  let totalClustersCreated = 0;
  let totalMessagesAttached = 0;

  for (const wf of workflowsQ.rows) {
    if (reporter) reporter.report({ message: `Layer 2: clustering positions for workflow ${wf.id}` });

    // All outbound messages in conversations assigned to this workflow,
    // grouped by (ghl_conversation_id, location_id) and ordered by time.
    // We use ROW_NUMBER() to compute strict outbound position within
    // each conversation.
    const posQ = await db.query(
      `WITH scoped AS (
         SELECT m.id AS msg_id, m.ghl_conversation_id, m.location_id,
                m.content, m.created_at,
                ROW_NUMBER() OVER (PARTITION BY m.ghl_conversation_id, m.location_id ORDER BY m.created_at ASC) AS position
           FROM ghl_messages m
           JOIN conversation_workflow_assignment cwa
             ON cwa.ghl_conversation_id = m.ghl_conversation_id
            AND cwa.location_id = m.location_id
          WHERE cwa.workflow_cluster_id = $1
            AND m.direction = 'outbound'
            AND COALESCE(m.content, '') <> ''
       )
       SELECT msg_id, ghl_conversation_id, location_id, content, created_at, position
         FROM scoped
        ORDER BY position ASC, created_at ASC`,
      [wf.id]
    );

    // Group by (position, normalized_hash).
    const byKey = new Map(); // key = `${position}:${hash}` → { position, hash, normalized, example, messages: [...] }
    for (const r of posQ.rows) {
      const norm = normalizeMessage(r.content || '');
      if (!norm) continue;
      const hash = hashNormalized(norm);
      const key = `${r.position}:${hash}`;
      if (!byKey.has(key)) {
        byKey.set(key, { position: r.position, hash, normalized: norm, example: r.content.slice(0, 500), messages: [] });
      }
      byKey.get(key).messages.push({ id: r.msg_id, created_at: r.created_at });
    }

    for (const [, b] of byKey.entries()) {
      // Always cluster position 1 (it's the workflow opener itself).
      if (b.position > 1 && b.messages.length < MIN_WT_CLUSTER_SIZE) continue;
      const firstTs = b.messages[b.messages.length - 1]?.created_at || null;
      const lastTs = b.messages[0]?.created_at || null;
      const insert = await db.query(
        `INSERT INTO word_track_clusters
           (label, source, example_text, normalized_hash, cluster_size, first_seen_at, last_seen_at, workflow_cluster_id, position)
         VALUES ('unlabeled', 'mixed', $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workflow_cluster_id, position, normalized_hash) WHERE workflow_cluster_id IS NOT NULL
         DO UPDATE SET cluster_size = word_track_clusters.cluster_size + EXCLUDED.cluster_size,
                       last_seen_at = GREATEST(word_track_clusters.last_seen_at, EXCLUDED.last_seen_at),
                       updated_at = NOW()
         RETURNING id, (xmax = 0) AS inserted`,
        [b.example, b.hash, b.messages.length, firstTs, lastTs, wf.id, b.position]
      );
      const clusterId = insert.rows[0].id;
      if (insert.rows[0].inserted) totalClustersCreated++;
      const ids = b.messages.map((m) => m.id);
      await db.query(
        `UPDATE ghl_messages SET cluster_id = $1 WHERE id = ANY($2) AND cluster_id IS NULL`,
        [clusterId, ids]
      );
      totalMessagesAttached += ids.length;
    }
  }

  return { clusters_created: totalClustersCreated, messages_attached: totalMessagesAttached };
}

// ────────────────────────────────────────────────────────────────────────
// Batch-labeling via Claude.
// ────────────────────────────────────────────────────────────────────────

async function labelWorkflowClusters(reporter) {
  let totalLabeled = 0;
  const MAX_BATCHES = 10;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const q = await db.query(
      `SELECT id, example_opener, conversation_count
         FROM workflow_clusters
        WHERE label = 'unlabeled' OR labeled_at IS NULL
        ORDER BY conversation_count DESC, id ASC
        LIMIT $1`,
      [LABEL_BATCH_SIZE]
    );
    if (!q.rows.length) break;

    if (reporter) reporter.report({ message: `Labeling ${q.rows.length} workflows (batch ${batch + 1})` });

    const prompt = `You are labeling WORKFLOW IDENTITIES from SMS drip openers in a life-insurance / marketplace funnel.
Each numbered workflow below is the first-message template used by a single drip campaign.

For each: return a short kebab-case label (<=40 chars) that is ALSO readable when the
dashes are converted to spaces. The UI humanizes slugs at render time
(mp-aged-lead-reengagement → "MP Aged Lead Reengagement"), so write slugs as if
they were a short, specific title — 2-5 lowercase words separated by hyphens.

Rules:
  - Do NOT append "-opener", "-followup", "-drip" or any other boilerplate suffix.
    The context already makes clear these are workflow openers.
  - Use acronyms uppercase-friendly: mp (mortgage protection), fex (final expense),
    aca (affordable care act), ca/nv/tx/... (states).
  - Prefer the product + intent + hook pattern, e.g. "mp-aged-lead-reengagement",
    "fex-rate-drop-pitch", "aca-renewal-reminder", "mp-ai-tool-intro".
  - Same opener across batches must get the same label when possible.

Output ONLY JSON: { "workflows": [{ "id": <n>, "label": "...", "description": "..." }, ...] }

WORKFLOWS:
${q.rows.map((r) => `--- WORKFLOW ${r.id} (${r.conversation_count} conversations) ---\n${r.example_opener}`).join('\n\n')}
`;

    const resp = await callAnthropic(
      {
        model: MODEL,
        max_tokens: 2500,
        system: 'You label SMS workflow opener templates. Output only valid JSON. Similar openers across batches should get the same label whenever possible.',
        messages: [{ role: 'user', content: prompt }]
      },
      { category: 'word_track_clustering', location_id: null, meta: { layer: 'workflow', batch: batch + 1, count: q.rows.length } }
    );

    const text = (resp.content.find((b) => b.type === 'text')?.text || '').trim();
    let parsed = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (err) {
      logger.log('wordtrack_cluster', 'warn', null, 'Workflow label parse failed', { batch: batch + 1, error: err.message });
    }
    const items = parsed?.workflows || [];
    for (const item of items) {
      if (!item.id || !item.label) continue;
      await db.query(
        `UPDATE workflow_clusters SET label = $1, description = $2, labeled_at = NOW(), updated_at = NOW() WHERE id = $3`,
        [String(item.label).slice(0, 200), item.description || null, item.id]
      );
      totalLabeled++;
    }
  }
  return { workflows_labeled: totalLabeled };
}

async function labelWordTrackClusters(reporter) {
  let totalLabeled = 0;
  const MAX_BATCHES = 20;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const q = await db.query(
      `SELECT wtc.id, wtc.example_text, wtc.position, wtc.cluster_size,
              wf.label AS workflow_label
         FROM word_track_clusters wtc
         LEFT JOIN workflow_clusters wf ON wf.id = wtc.workflow_cluster_id
        WHERE (wtc.label = 'unlabeled' OR wtc.labeled_at IS NULL)
          AND wtc.workflow_cluster_id IS NOT NULL
        ORDER BY wtc.cluster_size DESC, wtc.id ASC
        LIMIT $1`,
      [LABEL_BATCH_SIZE]
    );
    if (!q.rows.length) break;

    if (reporter) reporter.report({ message: `Labeling ${q.rows.length} word tracks (batch ${batch + 1})` });

    const prompt = `Label these per-position SMS message templates within specific workflows. Each has its workflow label and the position in the drip sequence.

For each: return a short kebab-case label (<=40 chars) describing the message's role
at that position within that workflow. The UI humanizes slugs at render time
(budget-objection-response → "Budget Objection Response"), so write slugs as if they
were a short readable title — 2-4 lowercase words separated by hyphens.

Examples: "budget-objection-response", "tie-down-confirmation", "health-probe-smoker",
"ai-disclosure", "decision-maker-check", "rescheduling-offer", "dnc-acknowledgment",
"delivery-check", "coverage-target-probe", "value-prop-followup".

Output ONLY JSON: { "clusters": [{ "id": <n>, "label": "...", "description": "..." }, ...] }

CLUSTERS:
${q.rows.map((r) => `--- CLUSTER ${r.id}  [workflow=${r.workflow_label || '?'}, position=${r.position}, n=${r.cluster_size}] ---\n${r.example_text}`).join('\n\n')}
`;

    const resp = await callAnthropic(
      {
        model: MODEL,
        max_tokens: 2500,
        system: 'You label per-position SMS bot templates within workflows. Output only valid JSON.',
        messages: [{ role: 'user', content: prompt }]
      },
      { category: 'word_track_clustering', location_id: null, meta: { layer: 'word_track', batch: batch + 1, count: q.rows.length } }
    );

    const text = (resp.content.find((b) => b.type === 'text')?.text || '').trim();
    let parsed = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (err) {
      logger.log('wordtrack_cluster', 'warn', null, 'WT label parse failed', { batch: batch + 1, error: err.message });
    }
    const items = parsed?.clusters || [];
    for (const item of items) {
      if (!item.id || !item.label) continue;
      await db.query(
        `UPDATE word_track_clusters SET label = $1, description = $2, labeled_at = NOW(), updated_at = NOW() WHERE id = $3`,
        [String(item.label).slice(0, 200), item.description || null, item.id]
      );
      totalLabeled++;
    }
  }
  return { word_tracks_labeled: totalLabeled };
}

// ────────────────────────────────────────────────────────────────────────
// Entry point.
// ────────────────────────────────────────────────────────────────────────

async function runFullPipeline(opts = {}) {
  const reporter = opts.reporter || { report: () => {} };
  reporter.report({ message: 'Resetting clustering state…' });
  await resetClusteringState();

  reporter.report({ message: 'Layer 1: identifying workflows from openers…' });
  const layer1 = await buildWorkflowClusters(reporter);

  reporter.report({ message: 'Labeling workflows via Claude…' });
  const wfLabel = await labelWorkflowClusters(reporter);

  reporter.report({ message: 'Layer 2: per-position word tracks…' });
  const layer2 = await buildPerPositionClusters(reporter);

  reporter.report({ message: 'Labeling word tracks via Claude…' });
  const wtLabel = await labelWordTrackClusters(reporter);

  const result = { ...layer1, ...wfLabel, ...layer2, ...wtLabel };
  logger.log('wordtrack_cluster', 'info', null, 'Two-layer clustering complete', result);
  reporter.report({ message: 'Done' });
  return result;
}

module.exports = {
  normalizeMessage,
  hashNormalized,
  runFullPipeline,
  resetClusteringState
};
