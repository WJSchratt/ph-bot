const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const JARVIS_PASSWORD = process.env.JARVIS_PASSWORD || 'profithexagon';
const PC_TAILSCALE_IP = process.env.PC_TAILSCALE_IP || '100.127.86.39';
const PC_PORT = process.env.PC_PORT || '8080';
const PC_URL = `http://${PC_TAILSCALE_IP}:${PC_PORT}`;

// Simple session store (in-memory, good enough for single user)
const sessions = new Map();

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Check if PC is online
async function checkPC() {
  return new Promise((resolve) => {
    const req = http.get(`${PC_URL}/health`, { timeout: 5000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Auth middleware for JARVIS routes
function jarvisAuth(req, res, next) {
  const token = req.headers['x-jarvis-token'] || req.query.token;
  if (token && sessions.has(token)) {
    req.jarvisSession = sessions.get(token);
    return next();
  }
  res.status(401).json({ error: 'unauthorized' });
}

// Serve JARVIS UI
router.get('/jarvis', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>JARVIS — Profit Hexagon</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #000;
      color: #00ff88;
      font-family: 'Courier New', monospace;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #login-screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 20px;
    }
    #login-screen h1 {
      font-size: 2.5em;
      letter-spacing: 8px;
      color: #00ff88;
      text-shadow: 0 0 20px #00ff88;
    }
    #login-screen p {
      color: #666;
      font-size: 0.9em;
      letter-spacing: 2px;
    }
    #password-input {
      background: #000;
      border: 1px solid #00ff88;
      color: #00ff88;
      padding: 12px 20px;
      font-family: 'Courier New', monospace;
      font-size: 1em;
      width: 280px;
      text-align: center;
      outline: none;
      border-radius: 4px;
    }
    #password-input::placeholder { color: #333; }
    .btn {
      background: transparent;
      border: 1px solid #00ff88;
      color: #00ff88;
      padding: 12px 30px;
      font-family: 'Courier New', monospace;
      font-size: 1em;
      letter-spacing: 3px;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.2s;
    }
    .btn:hover { background: #00ff8822; }
    .btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .btn.danger { border-color: #ff4444; color: #ff4444; }
    #main-screen { display: none; flex-direction: column; height: 100vh; }
    #header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 20px;
      border-bottom: 1px solid #111;
    }
    #header h2 { font-size: 1em; letter-spacing: 4px; }
    #status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #00ff88;
      box-shadow: 0 0 8px #00ff88;
      display: inline-block;
      margin-right: 8px;
    }
    #status-dot.offline { background: #ff4444; box-shadow: 0 0 8px #ff4444; }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .message {
      max-width: 85%;
      padding: 12px 16px;
      border-radius: 8px;
      line-height: 1.5;
      font-size: 0.9em;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .message.user {
      align-self: flex-end;
      background: #001a0d;
      border: 1px solid #00ff8844;
      color: #00ff88;
    }
    .message.jarvis {
      align-self: flex-start;
      background: #0a0a0a;
      border: 1px solid #333;
      color: #ccc;
    }
    .message.system {
      align-self: center;
      color: #444;
      font-size: 0.8em;
      border: none;
      background: none;
    }
    .typing { color: #444; font-style: italic; }
    #input-area {
      padding: 16px;
      border-top: 1px solid #111;
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }
    #chat-input {
      flex: 1;
      background: #0a0a0a;
      border: 1px solid #333;
      color: #ccc;
      padding: 12px;
      font-family: 'Courier New', monospace;
      font-size: 0.9em;
      border-radius: 4px;
      resize: none;
      max-height: 120px;
      outline: none;
    }
    #chat-input:focus { border-color: #00ff8844; }
    #mic-btn {
      width: 44px; height: 44px;
      border-radius: 50%;
      border: 1px solid #333;
      background: #0a0a0a;
      color: #666;
      font-size: 1.2em;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    #mic-btn.listening { border-color: #ff4444; color: #ff4444; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
    #send-btn { height: 44px; padding: 0 20px; flex-shrink: 0; }
    #start-screen {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 24px;
    }
    #start-screen h2 { font-size: 1.5em; letter-spacing: 4px; }
    #pc-status { color: #666; font-size: 0.85em; }
    .error-msg { color: #ff4444; font-size: 0.85em; }
  </style>
</head>
<body>

<!-- LOGIN -->
<div id="login-screen">
  <h1>JARVIS</h1>
  <p>PROFIT HEXAGON — PRIVATE ACCESS</p>
  <input type="password" id="password-input" placeholder="enter password" autocomplete="off" />
  <button class="btn" id="login-btn">ACCESS</button>
  <p class="error-msg" id="login-error"></p>
</div>

<!-- START SESSION -->
<div id="start-screen">
  <h2>JARVIS ONLINE</h2>
  <p id="pc-status">Checking PC status...</p>
  <button class="btn" id="start-btn" disabled>START SESSION</button>
  <p class="error-msg" id="start-error"></p>
</div>

<!-- MAIN CHAT -->
<div id="main-screen">
  <div id="header">
    <div><span id="status-dot"></span><span style="letter-spacing:3px;font-size:0.9em;">JARVIS</span></div>
    <button class="btn danger" id="end-btn" style="padding:6px 14px;font-size:0.8em;letter-spacing:2px;">END</button>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="chat-input" rows="1" placeholder="Message JARVIS..."></textarea>
    <button id="mic-btn" title="Voice input">🎤</button>
    <button class="btn" id="send-btn">SEND</button>
  </div>
</div>

<script>
  let token = localStorage.getItem('jarvis_token');
  let recognition = null;
  let sessionActive = false;

  // Auto-login if token exists
  if (token) checkTokenAndShow();

  document.getElementById('login-btn').onclick = login;
  document.getElementById('password-input').addEventListener('keypress', e => { if(e.key==='Enter') login(); });

  async function login() {
    const pw = document.getElementById('password-input').value;
    const res = await fetch('/jarvis/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({password: pw})
    });
    const data = await res.json();
    if (data.token) {
      token = data.token;
      localStorage.setItem('jarvis_token', token);
      showStartScreen();
    } else {
      document.getElementById('login-error').textContent = 'Access denied.';
    }
  }

  async function checkTokenAndShow() {
    const res = await fetch('/jarvis/ping', { headers: {'x-jarvis-token': token} });
    if (res.ok) showStartScreen();
    else { token = null; localStorage.removeItem('jarvis_token'); }
  }

  async function showStartScreen() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('start-screen').style.display = 'flex';
    checkPC();
  }

  async function checkPC() {
    document.getElementById('pc-status').textContent = 'Checking if your PC is online...';
    document.getElementById('start-btn').disabled = true;
    const res = await fetch('/jarvis/check-pc', { headers: {'x-jarvis-token': token} });
    const data = await res.json();
    if (data.online) {
      document.getElementById('pc-status').textContent = '✅ PC is online and ready';
      document.getElementById('start-btn').disabled = false;
    } else {
      document.getElementById('pc-status').textContent = '❌ PC is offline or unreachable';
      document.getElementById('start-error').textContent = 'Make sure your PC is on and Tailscale is running.';
    }
  }

  document.getElementById('start-btn').onclick = async () => {
    document.getElementById('start-btn').disabled = true;
    document.getElementById('pc-status').textContent = 'Starting session...';
    const res = await fetch('/jarvis/start', {
      method: 'POST',
      headers: {'x-jarvis-token': token}
    });
    const data = await res.json();
    if (data.ok) {
      showMainScreen();
      addMessage('jarvis', data.greeting || 'JARVIS online. How can I help you, Walt?');
    } else {
      document.getElementById('start-error').textContent = data.error || 'Failed to start session.';
      document.getElementById('start-btn').disabled = false;
    }
  };

  function showMainScreen() {
    document.getElementById('start-screen').style.display = 'none';
    document.getElementById('main-screen').style.display = 'flex';
    sessionActive = true;
  }

  document.getElementById('end-btn').onclick = () => {
    sessionActive = false;
    document.getElementById('main-screen').style.display = 'none';
    document.getElementById('start-screen').style.display = 'flex';
    checkPC();
  };

  document.getElementById('send-btn').onclick = sendMessage;
  document.getElementById('chat-input').addEventListener('keypress', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Auto-resize textarea
  document.getElementById('chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  async function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    addMessage('user', text);
    const typing = addMessage('jarvis', '...', true);
    try {
      const res = await fetch('/jarvis/chat', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-jarvis-token': token},
        body: JSON.stringify({message: text})
      });
      const data = await res.json();
      typing.remove();
      addMessage('jarvis', data.response || data.error || 'No response.');
      if (data.response) speak(data.response);
    } catch(e) {
      typing.remove();
      addMessage('jarvis', 'Connection error. Is your PC still online?');
    }
  }

  function addMessage(role, text, typing=false) {
    const div = document.createElement('div');
    div.className = 'message ' + role + (typing ? ' typing' : '');
    div.textContent = text;
    document.getElementById('messages').appendChild(div);
    document.getElementById('messages').scrollTop = 99999;
    return div;
  }

  // Voice input
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = e => {
      document.getElementById('chat-input').value = e.results[0][0].transcript;
      document.getElementById('mic-btn').classList.remove('listening');
      sendMessage();
    };
    recognition.onend = () => document.getElementById('mic-btn').classList.remove('listening');
  }

  document.getElementById('mic-btn').onclick = () => {
    if (!recognition) return;
    document.getElementById('mic-btn').classList.add('listening');
    recognition.start();
  };

  // Voice output (free browser TTS)
  function speak(text) {
    if (!window.speechSynthesis) return;
    // Strip markdown-ish chars for cleaner speech
    const clean = text.replace(/[#*\`]/g, '').substring(0, 500);
    const utt = new SpeechSynthesisUtterance(clean);
    utt.rate = 1.0;
    utt.pitch = 0.9;
    window.speechSynthesis.speak(utt);
  }
</script>
</body>
</html>`);
});

// Login endpoint
router.post('/jarvis/login', express.json(), (req, res) => {
  const { password } = req.body;
  if (password === JARVIS_PASSWORD) {
    const token = generateToken();
    sessions.set(token, { created: Date.now(), user: 'walt' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'invalid password' });
  }
});

// Ping (token check)
router.get('/jarvis/ping', jarvisAuth, (req, res) => {
  res.json({ ok: true });
});

// Check if PC is online
router.get('/jarvis/check-pc', jarvisAuth, async (req, res) => {
  const online = await checkPC();
  res.json({ online });
});

// Start session — wake up the PC bridge
router.post('/jarvis/start', jarvisAuth, async (req, res) => {
  try {
    const online = await checkPC();
    if (!online) return res.json({ ok: false, error: 'PC is offline. Make sure your PC is on and Tailscale is running.' });
    
    // Call PC to start a Claude session
    const startRes = await new Promise((resolve) => {
      const reqBody = JSON.stringify({});
      const options = {
        hostname: PC_TAILSCALE_IP,
        port: PC_PORT,
        path: '/start',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
        timeout: 15000
      };
      const r = http.request(options, (response) => {
        let body = '';
        response.on('data', d => body += d);
        response.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve({ ok: true }); }
        });
      });
      r.on('error', () => resolve({ ok: false, error: 'Could not reach PC' }));
      r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'PC timed out' }); });
      r.write(reqBody);
      r.end();
    });

    res.json({ ok: true, greeting: "JARVIS online. What do you need, Walt?" });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Chat — proxy to PC
router.post('/jarvis/chat', jarvisAuth, express.json(), async (req, res) => {
  const { message } = req.body;
  if (!message) return res.json({ error: 'no message' });

  try {
    const response = await new Promise((resolve) => {
      const reqBody = JSON.stringify({ message });
      const options = {
        hostname: PC_TAILSCALE_IP,
        port: PC_PORT,
        path: '/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
        timeout: 120000
      };
      const r = http.request(options, (httpRes) => {
        let body = '';
        httpRes.on('data', d => body += d);
        httpRes.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve({ response: body }); }
        });
      });
      r.on('error', (err) => resolve({ error: 'PC connection lost: ' + err.message }));
      r.on('timeout', () => { r.destroy(); resolve({ error: 'PC timed out — response may have been too long' }); });
      r.write(reqBody);
      r.end();
    });
    res.json(response);
  } catch (err) {
    res.json({ error: err.message });
  }
});

module.exports = router;
