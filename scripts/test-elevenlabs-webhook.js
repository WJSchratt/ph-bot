#!/usr/bin/env node
// Hit /api/elevenlabs/webhook against a running server with a sample payload.
// Auth: we use ADMIN_API_KEY + ?dryRun=1 to bypass HMAC and GHL writes.
//
// Usage:
//   BASE_URL=https://phbot.up.railway.app ADMIN_API_KEY=... node scripts/test-elevenlabs-webhook.js
//
// Optional flags:
//   --scenario voicemail|live_pickup|dispatcher_blown   mutate eval criteria
//   --sync        hit /webhook/sync (blocks, returns processing result)
//   --ep-agent    keep EP agent_id (default)
//   --non-ep      rewrite agent_id/agent_name so it's treated as non-EP

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const BASE = (process.env.BASE_URL || process.env.RAILWAY_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.ADMIN_API_KEY;
if (!KEY) {
  console.error('ADMIN_API_KEY env var is required.');
  process.exit(2);
}

const args = process.argv.slice(2);
const scenarioIdx = args.indexOf('--scenario');
const scenario = scenarioIdx >= 0 ? args[scenarioIdx + 1] : 'live_pickup';
const sync = args.includes('--sync');
const nonEp = args.includes('--non-ep');

const samplePath = path.join(__dirname, 'test-data', 'elevenlabs-ep-sample.json');
const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

function applyScenario(s) {
  const crit = s.analysis.evaluation_criteria_results;
  const setAll = (vm, lp, db) => {
    crit.VOICEMAIL_HIT.result = vm;
    crit.LIVE_PICKUP.result = lp;
    crit.DISPATCHER_BLOWN.result = db;
  };
  if (scenario === 'voicemail')         setAll('success', 'failure', 'failure');
  else if (scenario === 'live_pickup')  setAll('failure', 'success', 'failure');
  else if (scenario === 'dispatcher_blown') setAll('failure', 'failure', 'success');
  else if (scenario === 'unknown')      setAll('failure', 'failure', 'failure');
  // Vary conversation_id per scenario so every test upserts a distinct row
  s.conversation_id = `${s.conversation_id}_${scenario}_${Date.now().toString(36)}`;
  // Stamp a fresh call start time so findRecentByPhone's 10-min window sees
  // sequential test runs as siblings (the checked-in sample is frozen at Apr 2026).
  if (s.metadata) s.metadata.start_time_unix_secs = Math.floor(Date.now() / 1000);
}

applyScenario(sample);

if (nonEp) {
  sample.agent_id = 'agent_fx_mp_example';
  sample.agent_name = 'FX & MP Insurance Callback';
}

const envelope = { type: 'post_call_transcription', event_timestamp: Math.floor(Date.now() / 1000), data: sample };
const body = JSON.stringify(envelope);

const url = new URL(BASE + `/api/elevenlabs/webhook${sync ? '/sync' : ''}?dryRun=1`);
const client = url.protocol === 'https:' ? https : http;

const req = client.request({
  method: 'POST',
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: url.pathname + url.search,
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: `Bearer ${KEY}`
  }
}, (res) => {
  let raw = '';
  res.on('data', (c) => { raw += c; });
  res.on('end', () => {
    console.log(`[${res.statusCode}] ${url}`);
    try { console.log(JSON.stringify(JSON.parse(raw), null, 2)); }
    catch { console.log(raw); }
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  });
});
req.on('error', (err) => { console.error('Request failed:', err.message); process.exit(1); });
req.write(body);
req.end();
