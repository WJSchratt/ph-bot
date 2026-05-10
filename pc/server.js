const express = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const os = require('os');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const WORKDIR = process.env.WORKDIR || os.homedir();
const MODEL = process.env.MODEL || '';
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '600000', 10);

let currentSessionId = null;
let sessionPrimed = false;
let inFlight = false;

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const baseArgs = [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];
    if (MODEL) baseArgs.push('--model', MODEL);
    const sessionArgs = sessionPrimed
      ? ['--resume', currentSessionId]
      : ['--session-id', currentSessionId];
    const args = [...baseArgs, ...sessionArgs, prompt];

    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKDIR,
      env: process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(killTimer);
      reject(new Error(`spawn failed: ${err.message}. Is '${CLAUDE_BIN}' on PATH?`));
    });
    child.on('close', code => {
      clearTimeout(killTimer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}. stderr: ${stderr.slice(0, 1000)}`));
      }
      resolve(stdout);
    });
  });
}

function extractText(stdout) {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.result === 'string') return { text: parsed.result, raw: parsed };
    if (typeof parsed.text === 'string') return { text: parsed.text, raw: parsed };
    return { text: JSON.stringify(parsed), raw: parsed };
  } catch {
    return { text: trimmed, raw: null };
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sessionId: currentSessionId,
    sessionPrimed,
    inFlight,
    workdir: WORKDIR,
    claudeBin: CLAUDE_BIN,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.post('/start', (_req, res) => {
  currentSessionId = randomUUID();
  sessionPrimed = false;
  console.log(`[start] new session ${currentSessionId}`);
  res.json({ ok: true, sessionId: currentSessionId });
});

app.post('/chat', async (req, res) => {
  const message = ((req.body && req.body.message) || '').toString();
  if (!message.trim()) {
    return res.status(400).json({ error: 'empty message' });
  }
  if (inFlight) {
    return res.status(429).json({ error: 'a chat is already in flight; wait for it to finish' });
  }
  if (!currentSessionId) {
    currentSessionId = randomUUID();
    sessionPrimed = false;
    console.log(`[chat] auto-started session ${currentSessionId}`);
  }
  inFlight = true;
  const startedAt = Date.now();
  try {
    const stdout = await runClaude(message);
    const { text, raw } = extractText(stdout);
    sessionPrimed = true;
    const ms = Date.now() - startedAt;
    console.log(`[chat] ok in ${ms}ms (session ${currentSessionId})`);
    res.json({
      response: text,
      sessionId: currentSessionId,
      durationMs: ms,
      cost: raw && raw.total_cost_usd,
    });
  } catch (e) {
    const ms = Date.now() - startedAt;
    console.error(`[chat] FAIL in ${ms}ms: ${e.message}`);
    res.status(500).json({ error: e.message, durationMs: ms });
  } finally {
    inFlight = false;
  }
});

app.post('/reset', (_req, res) => {
  const old = currentSessionId;
  currentSessionId = null;
  sessionPrimed = false;
  res.json({ ok: true, clearedSessionId: old });
});

app.use((err, _req, res, _next) => {
  console.error('[err]', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`PC bridge listening on http://${HOST}:${PORT}`);
  console.log(`  workdir:   ${WORKDIR}`);
  console.log(`  claude:    ${CLAUDE_BIN}`);
  console.log(`  model:     ${MODEL || '(default)'}`);
  console.log(`  timeout:   ${REQUEST_TIMEOUT_MS}ms`);
});
