const express = require('express');
const db = require('../db');

const router = express.Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function today() {
  return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ── routes ───────────────────────────────────────────────────────────────────

router.get('/ep-review', async (req, res) => {
  try {
    const callsRes = await db.query(`
      SELECT conversation_id,
             external_number,
             start_time,
             duration_secs,
             day_of_week_called,
             audio_bytes IS NOT NULL AS has_audio,
             COALESCE(review_status, 'pending') AS review_status,
             review_notes,
             video_url
      FROM elevenlabs_calls
      WHERE is_ep = TRUE
        AND call_result = 'voicemail'
        AND start_time > NOW() - INTERVAL '7 days'
      ORDER BY
        (CASE WHEN COALESCE(review_status,'pending') = 'pending' THEN 0 ELSE 1 END),
        start_time DESC
      LIMIT 300
    `);

    const statsRes = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(review_status,'pending') = 'pending') AS pending,
        COUNT(*) FILTER (WHERE review_status = 'approved')                    AS approved,
        COUNT(*) FILTER (WHERE review_status = 'disqualified')                AS disqualified
      FROM elevenlabs_calls
      WHERE is_ep = TRUE
        AND call_result = 'voicemail'
        AND start_time > NOW() - INTERVAL '7 days'
    `);

    const calls = callsRes.rows;
    const stats = statsRes.rows[0];
    const total = Number(stats.pending) + Number(stats.approved) + Number(stats.disqualified);
    const done  = Number(stats.approved) + Number(stats.disqualified);
    const pct   = total ? ((done / total) * 100).toFixed(1) : '0';

    const cardsHtml = calls.length === 0
      ? `<div class="empty"><h2>All caught up</h2><p>No calls pending for the last 7 days.</p></div>`
      : calls.map(c => `
        <div class="card ${c.review_status}" id="card-${c.conversation_id}" data-id="${c.conversation_id}" onclick="selectCard('${c.conversation_id}')">
          <div>
            <div class="phone">${c.external_number || ''}</div>
            <div class="meta">
              ${c.day_of_week_called || ''} &middot; ${fmtDate(c.start_time)} &middot; ${c.duration_secs || 0}s
            </div>
            <div class="status-label ${c.review_status}" id="lbl-${c.conversation_id}">
              ${c.review_status !== 'pending' ? c.review_status : ''}
            </div>
            ${c.video_url ? `<a class="video-link" href="${c.video_url}" target="_blank">Watch video</a>` : ''}
          </div>
          <div class="audio-wrap">
            ${c.has_audio
              ? `<audio id="audio-${c.conversation_id}" controls preload="none" src="/ep-review/audio/${c.conversation_id}"></audio>`
              : `<span class="no-audio">No audio on file</span>`}
            <textarea class="notes" id="notes-${c.conversation_id}" placeholder="Notes (optional)" rows="2">${c.review_notes || ''}</textarea>
          </div>
          <div class="actions">
            <button class="btn-approve"     onclick="decide(event,'${c.conversation_id}','approved')">Approve</button>
            <button class="btn-disqualify"  onclick="decide(event,'${c.conversation_id}','disqualified')">Disqualify</button>
          </div>
        </div>`).join('\n');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EP Review</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #f9fafb; color: #111827; font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; }
.bar { background: #fff; border-bottom: 1px solid #e5e7eb; height: 52px; padding: 0 28px; display: flex; align-items: center; gap: 20px; position: sticky; top: 0; z-index: 10; }
.bar-title { font-size: 14px; font-weight: 600; color: #111827; margin-right: 4px; }
.bar-date { font-size: 13px; color: #9ca3af; }
.divider { width: 1px; height: 18px; background: #e5e7eb; }
.stat { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #6b7280; }
.stat b { color: #111827; font-weight: 600; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #d1d5db; }
.dot.g { background: #16a34a; }
.dot.r { background: #dc2626; }
.bar-right { margin-left: auto; display: flex; align-items: center; gap: 20px; }
.hints { display: flex; gap: 14px; font-size: 12px; color: #9ca3af; }
.hints span { display: flex; align-items: center; gap: 4px; }
kbd { background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 3px; padding: 0 4px; font-size: 11px; font-family: inherit; color: #374151; }
.btn-text { font-size: 12px; color: #9ca3af; background: none; border: none; cursor: pointer; font-family: inherit; }
.btn-text:hover { color: #6b7280; }
.progress { height: 2px; background: #e5e7eb; }
.progress-fill { height: 2px; background: #111827; transition: width .3s; }
.list { max-width: 960px; margin: 20px auto; padding: 0 20px 80px; display: flex; flex-direction: column; gap: 6px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 18px; display: grid; grid-template-columns: 180px 1fr 180px; gap: 18px; align-items: center; cursor: pointer; transition: border-color .1s, box-shadow .1s; position: relative; }
.card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; border-radius: 8px 0 0 8px; background: transparent; transition: background .1s; }
.card:hover { border-color: #9ca3af; }
.card.active { border-color: #111827; box-shadow: 0 0 0 1px #111827; }
.card.approved::before { background: #16a34a; }
.card.disqualified::before { background: #dc2626; }
.phone { font-size: 14px; font-weight: 600; color: #111827; letter-spacing: .1px; }
.meta { font-size: 12px; color: #9ca3af; margin-top: 3px; }
.status-label { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .5px; margin-top: 4px; color: #d1d5db; }
.status-label.approved { color: #16a34a; }
.status-label.disqualified { color: #dc2626; }
.video-link { font-size: 11px; color: #3b82f6; text-decoration: none; margin-top: 3px; display: block; }
.audio-wrap { display: flex; flex-direction: column; gap: 6px; }
audio { width: 100%; height: 30px; }
.no-audio { font-size: 12px; color: #9ca3af; }
.notes { width: 100%; border: 1px solid #e5e7eb; border-radius: 5px; background: #f9fafb; padding: 6px 8px; font-size: 12px; font-family: inherit; color: #374151; resize: none; outline: none; }
.notes:focus { border-color: #9ca3af; }
.actions { display: flex; flex-direction: column; gap: 7px; }
.btn-approve, .btn-disqualify { width: 100%; padding: 8px 0; border-radius: 6px; font-size: 13px; font-weight: 500; font-family: inherit; cursor: pointer; border: 1px solid transparent; transition: opacity .1s; }
.btn-approve:hover, .btn-disqualify:hover { opacity: .82; }
.btn-approve { background: #111827; color: #fff; border-color: #111827; }
.btn-disqualify { background: #fff; color: #dc2626; border-color: #fca5a5; }
.empty { text-align: center; padding: 80px 0; color: #9ca3af; }
.empty h2 { font-size: 15px; font-weight: 500; color: #374151; margin-bottom: 4px; }
</style>
</head>
<body>

<div class="bar">
  <span class="bar-title">EP Review</span>
  <span class="bar-date">${today()}</span>
  <div class="divider"></div>
  <div class="stat"><span class="dot"></span>Pending <b id="cnt-p">${stats.pending}</b></div>
  <div class="stat"><span class="dot g"></span>Approved <b id="cnt-a">${stats.approved}</b></div>
  <div class="stat"><span class="dot r"></span>Disqualified <b id="cnt-d">${stats.disqualified}</b></div>
  <div class="bar-right">
    <div class="hints">
      <span><kbd>Space</kbd> play</span>
      <span><kbd>A</kbd> approve</span>
      <span><kbd>D</kbd> disqualify</span>
      <span><kbd>&uarr;&darr;</kbd> navigate</span>
    </div>
    <button class="btn-text" onclick="cleanup()">Clean old audio</button>
  </div>
</div>

<div class="progress">
  <div class="progress-fill" id="prog" style="width:${pct}%"></div>
</div>

<div class="list">
${cardsHtml}
</div>

<script>
let active = null;
function allCards() { return Array.from(document.querySelectorAll('.card')); }
function selectCard(id) {
  if (active) document.getElementById('card-' + active)?.classList.remove('active');
  active = id;
  document.getElementById('card-' + id)?.classList.add('active');
}
const first = allCards().find(c => c.classList.contains('pending'));
if (first) selectCard(first.dataset.id);
else if (allCards()[0]) selectCard(allCards()[0].dataset.id);

async function decide(evt, id, status) {
  evt.stopPropagation();
  const notes = document.getElementById('notes-' + id)?.value || '';
  const r = await fetch('/ep-review/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conv_id: id, status, notes }),
  });
  if (!r.ok) { alert('Save failed'); return; }
  const card = document.getElementById('card-' + id);
  card.className = 'card ' + status + (active === id ? ' active' : '');
  const lbl = document.getElementById('lbl-' + id);
  if (lbl) { lbl.textContent = status; lbl.className = 'status-label ' + status; }
  await refreshStats();
  advanceNext(id);
}

function advanceNext(fromId) {
  const all = allCards();
  const idx = all.findIndex(c => c.dataset.id === fromId);
  for (let i = idx + 1; i < all.length; i++) {
    if (all[i].classList.contains('pending')) {
      selectCard(all[i].dataset.id);
      all[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
}

async function refreshStats() {
  const r = await fetch('/ep-review/api/stats');
  const s = await r.json();
  document.getElementById('cnt-p').textContent = s.pending;
  document.getElementById('cnt-a').textContent = s.approved;
  document.getElementById('cnt-d').textContent = s.disqualified;
  const total = s.pending + s.approved + s.disqualified;
  const done  = s.approved + s.disqualified;
  document.getElementById('prog').style.width = total ? ((done / total * 100).toFixed(1) + '%') : '0%';
}

async function cleanup() {
  if (!confirm('Remove audio older than 14 days from the database?')) return;
  const r = await fetch('/ep-review/api/cleanup', { method: 'POST' });
  const d = await r.json();
  alert('Cleaned ' + d.cleaned + ' rows.');
}

document.addEventListener('keydown', e => {
  if (!active) return;
  if (['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  const card  = document.getElementById('card-' + active);
  const audio = document.getElementById('audio-' + active);
  const all   = allCards();
  const idx   = all.findIndex(c => c.dataset.id === active);
  if (e.code === 'Space') {
    e.preventDefault();
    audio && (audio.paused ? audio.play() : audio.pause());
  } else if (e.key === 'a' || e.key === 'A') {
    card?.querySelector('.btn-approve')?.click();
  } else if (e.key === 'd' || e.key === 'D') {
    card?.querySelector('.btn-disqualify')?.click();
  } else if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    if (idx < all.length - 1) { selectCard(all[idx+1].dataset.id); all[idx+1].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    if (idx > 0) { selectCard(all[idx-1].dataset.id); all[idx-1].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
});
</script>
</body>
</html>`);
  } catch (err) {
    console.error('[ep-review]', err);
    res.status(500).send('Error loading EP review');
  }
});

router.get('/ep-review/audio/:conv_id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT audio_bytes, audio_mime FROM elevenlabs_calls WHERE conversation_id = $1',
      [req.params.conv_id]
    );
    const row = result.rows[0];
    if (!row || !row.audio_bytes) return res.status(404).send('No audio');
    const data = Buffer.from(row.audio_bytes);
    res.setHeader('Content-Type', row.audio_mime || 'audio/mpeg');
    res.setHeader('Content-Length', data.length);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(data);
  } catch (err) {
    res.status(500).send('Error');
  }
});

router.post('/ep-review/api/review', async (req, res) => {
  const { conv_id, status, notes } = req.body;
  if (!conv_id || !status) return res.status(400).json({ ok: false });
  try {
    await db.query(
      `UPDATE elevenlabs_calls SET review_status=$1, review_notes=$2 WHERE conversation_id=$3`,
      [status, notes || '', conv_id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/ep-review/api/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(review_status,'pending') = 'pending') AS pending,
        COUNT(*) FILTER (WHERE review_status = 'approved')                    AS approved,
        COUNT(*) FILTER (WHERE review_status = 'disqualified')                AS disqualified
      FROM elevenlabs_calls
      WHERE is_ep = TRUE
        AND call_result = 'voicemail'
        AND start_time > NOW() - INTERVAL '7 days'
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

router.post('/ep-review/api/cleanup', async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE elevenlabs_calls SET audio_bytes = NULL
      WHERE start_time < NOW() - INTERVAL '14 days' AND audio_bytes IS NOT NULL
    `);
    res.json({ cleaned: result.rowCount });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// Public prospect landing page — no auth, linked from email
const BUNNY_LIBRARY_ID = process.env.BUNNY_LIBRARY_ID || '650848';

router.get('/watch/:video_id', (req, res) => {
  const { video_id } = req.params;
  if (!/^[a-f0-9-]{36}$/i.test(video_id)) return res.status(404).send('Not found');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>We Called Your Business — Watch What Happened</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0a0a0a;
  color: #f5f5f5;
  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 20px 80px;
}
.wordmark {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: #737373;
  margin-bottom: 40px;
}
.headline {
  text-align: center;
  max-width: 600px;
  margin-bottom: 36px;
}
.headline h1 {
  font-size: clamp(1.5rem, 4vw, 2rem);
  font-weight: 700;
  line-height: 1.25;
  color: #fff;
  letter-spacing: -.3px;
}
.headline p {
  font-size: 15px;
  color: #737373;
  margin-top: 10px;
}
.player {
  width: 100%;
  max-width: 800px;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 0 0 1px rgba(255,255,255,.06), 0 24px 60px rgba(0,0,0,.6);
}
.player iframe {
  display: block;
  width: 100%;
  aspect-ratio: 16/9;
  border: none;
}
.cta {
  margin-top: 40px;
  text-align: center;
}
.cta p { font-size: 14px; color: #737373; margin-bottom: 16px; }
.cta a {
  display: inline-block;
  background: #fff;
  color: #0a0a0a;
  font-weight: 600;
  font-size: 14px;
  padding: 13px 36px;
  border-radius: 7px;
  text-decoration: none;
  letter-spacing: -.1px;
  transition: opacity .12s;
}
.cta a:hover { opacity: .88; }
footer {
  margin-top: 60px;
  font-size: 12px;
  color: #404040;
}
</style>
</head>
<body>
<div class="wordmark">Profit Hexagon</div>
<div class="headline">
  <h1>We called your business last night.<br>Here's what happened.</h1>
  <p>Watch the recording — it takes about 3 minutes.</p>
</div>
<div class="player">
  <iframe
    src="https://iframe.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${video_id}?autoplay=true&loop=false&muted=false&preload=true&responsive=true"
    loading="lazy"
    allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
    allowfullscreen>
  </iframe>
</div>
<div class="cta">
  <p>Ready to stop missing after-hours revenue?</p>
  <a href="https://links.profithexagon.com/widget/bookings/implementation-call-automation" target="_blank">Book Your Free Audit</a>
</div>
<footer>Profit Hexagon &nbsp;&middot;&nbsp; profithexagon.com</footer>
</body>
</html>`);
});

// JSON endpoint for SPA
router.get('/ep-review/api/calls', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT conversation_id,
             external_number,
             start_time,
             duration_secs,
             day_of_week_called,
             audio_bytes IS NOT NULL AS has_audio,
             COALESCE(review_status, 'pending') AS review_status,
             review_notes,
             video_url
      FROM elevenlabs_calls
      WHERE is_ep = TRUE
        AND call_result = 'voicemail'
        AND start_time > NOW() - INTERVAL '7 days'
      ORDER BY
        (CASE WHEN COALESCE(review_status,'pending') = 'pending' THEN 0 ELSE 1 END),
        start_time DESC
      LIMIT 300
    `);
    const statsRes = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(review_status,'pending') = 'pending') AS pending,
        COUNT(*) FILTER (WHERE review_status = 'approved')                    AS approved,
        COUNT(*) FILTER (WHERE review_status = 'disqualified')                AS disqualified
      FROM elevenlabs_calls
      WHERE is_ep = TRUE
        AND call_result = 'voicemail'
        AND start_time > NOW() - INTERVAL '7 days'
    `);
    res.json({ ok: true, calls: result.rows, stats: statsRes.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
