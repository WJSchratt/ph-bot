const MAX_ENTRIES = 200;
const buffer = [];
let nextId = 1;

function log(stage, level, contact_id, message, data) {
  const entry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    stage,
    level,
    contact_id: contact_id || null,
    message,
    data: data ? JSON.parse(JSON.stringify(data)) : null
  };

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  // Compact console output for Vercel/Railway logs
  const tag = `[${stage}]`.padEnd(16);
  const lvl = level === 'error' ? 'ERR' : level === 'warn' ? 'WRN' : 'INF';
  const cid = contact_id ? ` (${contact_id})` : '';
  console.log(`${lvl} ${tag}${cid} ${message}`);
}

function getLogs({ contact_id, limit } = {}) {
  let entries = [...buffer];
  if (contact_id) {
    entries = entries.filter(e => e.contact_id === contact_id);
  }
  entries.reverse(); // newest first
  const max = Math.min(parseInt(limit, 10) || 200, 200);
  return entries.slice(0, max);
}

module.exports = { log, getLogs };
