const express = require('express');
const router = express.Router();
const http = require('http');

const JARVIS_PASSWORD = process.env.JARVIS_PASSWORD || 'profithexagon';
const PC_TAILSCALE_IP = process.env.PC_TAILSCALE_IP || '100.127.86.39';
const PC_PORT = process.env.PC_PORT || '8080';
const PC_BASE = `http://${PC_TAILSCALE_IP}:${PC_PORT}`;

// Simple session store
const sessions = new Map();

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Auth middleware
function jarvisAuth(req, res, next) {
  const token = req.headers['x-jarvis-token'] || req.query.token;
  if (token && sessions.has(token)) {
    req.jarvisSession = sessions.get(token);
    return next();
  }
  res.status(401).json({ error: 'unauthorized' });
}

// Helper: proxy a request to the PC
function proxyToPC(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = `${PC_BASE}${path}`;
    const method = options.method || 'GET';
    const body = options.body ? JSON.stringify(options.body) : null;
    const reqOptions = {
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: options.timeout || 10000
    };
    const urlObj = new URL(url);
    const nodeOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method,
      headers: reqOptions.headers
    };
    if (body) nodeOptions.headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(nodeOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.setTimeout(options.timeout || 10000);
    if (body) req.write(body);
    req.end();
  });
}

// Login
router.post('/jarvis/login', (req, res) => {
  const { password } = req.body;
  if (password === JARVIS_PASSWORD) {
    const token = generateToken();
    sessions.set(token, { created: Date.now() });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'invalid password' });
  }
});

// Ping (token check)
router.get('/jarvis/ping', jarvisAuth, (req, res) => {
  res.json({ ok: true });
});

// PROXY: Check PC health (Railway calls PC, no mixed content)
router.get('/jarvis/pc/health', jarvisAuth, async (req, res) => {
  const debug = {
    attempting: `${PC_BASE}/health`,
    timestamp: new Date().toISOString()
  };
  try {
    const result = await proxyToPC('/health', { timeout: 6000 });
    debug.status = result.status;
    debug.response = result.data;
    res.json({ ok: true, debug });
  } catch(e) {
    debug.error = e.message;
    res.json({ ok: false, debug });
  }
});

// PROXY: Start session
router.post('/jarvis/pc/start', jarvisAuth, async (req, res) => {
  try {
    const result = await proxyToPC('/start', { method: 'POST', timeout: 20000 });
    res.json(result.data);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PROXY: Chat
router.post('/jarvis/pc/chat', jarvisAuth, async (req, res) => {
  try {
    const result = await proxyToPC('/chat', { method: 'POST', body: req.body, timeout: 60000 });
    res.json(result.data);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve JARVIS UI
router.get('/jarvis', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>JARVIS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; color: #00ff88; font-family: 'Courier New', monospace; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    #login-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 20px; }
    #login-screen h1 { font-size: 2.5em; letter-spacing: 8px; color: #00ff88; text-shadow: 0 0 20px #00ff88; }
    #login-screen p { color: #666; font-size: 0.9em; letter-spacing: 2px; }
    #password-input { background: #000; border: 1px solid #00ff88; color: #00ff88; padding: 12px 20px; font-family: 'Courier New', monospace; font-size: 1em; width: 280px; text-align: center; outline: none; border-radius: 4px; }
    #password-input::placeholder { color: #333; }
    .btn { background: transparent; border: 1px solid #00ff88; color: #00ff88; padding: 12px 30px; font-family: 'Courier New', monospace; font-size: 1em; letter-spacing: 3px; cursor: pointer; border-radius: 4px; transition: all 0.2s; }
    .btn:hover { background: #00ff8822; }
    .btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .btn.danger { border-color: #ff4444; color: #ff4444; }
    #main-screen { display: none; flex-direction: column; height: 100vh; }
    #header { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; border-bottom: 1px solid #111; }
    #status-dot { width: 8px; height: 8px; border-radius: 50%; background: #00ff88; box-shadow: 0 0 8px #00ff88; display: inline-block; margin-right: 8px; }
    #status-dot.offline { background: #ff4444; box-shadow: 0 0 8px #ff4444; }
    #messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
    .message { max-width: 85%; padding: 12px 16px; border-radius: 8px; line-height: 1.5; font-size: 0.9em; white-space: pre-wrap; word-wrap: break-word; }
    .message.user { align-self: flex-end; background: #001a0d; border: 1px solid #00ff8844; color: #00ff88; }
    .message.jarvis { align-self: flex-start; background: #0a0a0a; border: 1px solid #333; color: #ccc; }
    .message.system { align-self: center; color: #444; font-size: 0.8em; border: none; background: none; }
    #input-area { padding: 16px; border-top: 1px solid #111; display: flex; gap: 10px; align-items: flex-end; }
    #chat-input { flex: 1; background: #0a0a0a; border: 1px solid #333; color: #ccc; padding: 12px; font-family: 'Courier New', monospace; font-size: 0.9em; border-radius: 4px; resize: none; max-height: 120px; outline: none; }
    #chat-input:focus { border-color: #00ff8844; }
    #mic-btn { width: 44px; height: 44px; border-radius: 50%; border: 1px solid #333; background: #0a0a0a; color: #666; font-size: 1.2em; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    #mic-btn.listening { border-color: #ff4444; color: #ff4444; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
    #send-btn { height: 44px; padding: 0 20px; flex-shrink: 0; }
    #start-screen { display: none; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 24px; }
    #start-screen h2 { font-size: 1.5em; letter-spacing: 4px; }
    #pc-status { color: #666; font-size: 0.85em; text-align: center; padding: 0 20px; }
    .error-msg { color: #ff4444; font-size: 0.85em; text-align: center; padding: 0 20px; }
    #debug-panel { background: #0a0a0a; border: 1px solid #222; padding: 12px; margin: 0 20px; border-radius: 4px; font-size: 0.75em; color: #555; max-width: 340px; width: 100%; word-break: break-all; max-height: 120px; overflow-y: auto; }
    #debug-panel.has-error { border-color: #ff444433; color: #ff4444; }
    #debug-panel.has-success { border-color: #00ff8833; color: #00ff8877; }
  </style>
</head>
<body>

<div id="login-screen">
  <h1>JARVIS</h1>
  <p>PROFIT HEXAGON</p>
  <input type="password" id="password-input" placeholder="enter password" autocomplete="off" />
  <button class="btn" id="login-btn">ACCESS</button>
  <p class="error-msg" id="login-error"></p>
</div>

<div id="start-screen">
  <h2>JARVIS ONLINE</h2>
  <p id="pc-status">Checking PC status...</p>
  <button class="btn" id="start-btn" disabled>START SESSION</button>
  <p class="error-msg" id="start-error"></p>
  <div id="debug-panel">Initializing...</div>
</div>

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
  let authToken = localStorage.getItem('jarvis_token');
  let recognition = null;

  function debug(msg, isError, isSuccess) {
    const el = document.getElementById('debug-panel');
    if (!el) return;
    el.textContent = msg;
    el.className = isError ? 'has-error' : isSuccess ? 'has-success' : '';
  }

  if (authToken) checkTokenAndShow();

  document.getElementById('login-btn').onclick = login;
  document.getElementById('password-input').addEventListener('keypress', e => { if(e.key==='Enter') login(); });

  async function login() {
    const pw = document.getElementById('password-input').value;
    try {
      const res = await fetch('/jarvis/login', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({password: pw})
      });
      const data = await res.json();
      if (data.token) {
        authToken = data.token;
        localStorage.setItem('jarvis_token', authToken);
        showStartScreen();
      } else {
        document.getElementById('login-error').textContent = 'Access denied.';
      }
    } catch(e) {
      document.getElementById('login-error').textContent = 'Connection error: ' + e.message;
    }
  }

  async function checkTokenAndShow() {
    try {
      const res = await fetch('/jarvis/ping', { headers: {'x-jarvis-token': authToken} });
      if (res.ok) showStartScreen();
      else { authToken = null; localStorage.removeItem('jarvis_token'); }
    } catch(e) {
      authToken = null; localStorage.removeItem('jarvis_token');
    }
  }

  async function showStartScreen() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('start-screen').style.display = 'flex';
    checkPC();
  }

  async function checkPC() {
    document.getElementById('pc-status').textContent = 'Checking if your PC is online...';
    document.getElementById('start-btn').disabled = true;
    debug('Calling /jarvis/pc/health via Railway proxy...');
    try {
      const res = await fetch('/jarvis/pc/health', {
        headers: {'x-jarvis-token': authToken},
        signal: AbortSignal.timeout(12000)
      });
      const data = await res.json();
      debug(JSON.stringify(data.debug, null, 2), !data.ok, data.ok);
      if (data.ok) {
        document.getElementById('pc-status').textContent = 'PC is online and ready';
        document.getElementById('start-error').textContent = '';
        document.getElementById('start-btn').disabled = false;
      } else {
        document.getElementById('pc-status').textContent = 'PC is offline or unreachable';
        document.getElementById('start-error').textContent = 'Make sure your PC is on and Tailscale is running.';
      }
    } catch(e) {
      debug('Fetch error: ' + e.message, true);
      document.getElementById('pc-status').textContent = 'PC check failed';
      document.getElementById('start-error').textContent = e.message;
    }
  }

  document.getElementById('start-btn').onclick = async () => {
    document.getElementById('start-btn').disabled = true;
    document.getElementById('pc-status').textContent = 'Starting session...';
    debug('Starting Claude session on PC...');
    try {
      const res = await fetch('/jarvis/pc/start', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-jarvis-token': authToken},
        signal: AbortSignal.timeout(25000)
      });
      const data = await res.json();
      if (data.ok) {
        showMainScreen();
        addMessage('jarvis', data.greeting || 'JARVIS online. How can I help?');
      } else {
        document.getElementById('start-btn').disabled = false;
        document.getElementById('start-error').textContent = data.error || 'Failed to start session.';
        debug('Start error: ' + JSON.stringify(data), true);
      }
    } catch(e) {
      document.getElementById('start-btn').disabled = false;
      document.getElementById('start-error').textContent = 'Error: ' + e.message;
      debug('Start exception: ' + e.message, true);
    }
  };

  function showMainScreen() {
    document.getElementById('start-screen').style.display = 'none';
    document.getElementById('main-screen').style.display = 'flex';
  }

  function addMessage(type, text) {
    const msgs = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'message ' + type;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  document.getElementById('end-btn').onclick = () => {
    document.getElementById('main-screen').style.display = 'none';
    document.getElementById('start-screen').style.display = 'flex';
    checkPC();
  };

  document.getElementById('send-btn').onclick = sendMessage;
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  async function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    addMessage('user', text);
    const typingDiv = addMessage('jarvis', 'thinking...');
    typingDiv.style.color = '#444';
    try {
      const res = await fetch('/jarvis/pc/chat', {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-jarvis-token': authToken},
        body: JSON.stringify({ message: text }),
        signal: AbortSignal.timeout(120000)
      });
      const data = await res.json();
      typingDiv.textContent = data.response || data.error || 'No response.';
      typingDiv.style.color = '';
      speak(data.response);
    } catch(e) {
      typingDiv.textContent = 'Error: ' + e.message;
      typingDiv.style.color = '#ff4444';
    }
  }

  document.getElementById('chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  document.getElementById('mic-btn').onclick = toggleMic;
  function toggleMic() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      alert('Speech recognition not supported on this browser.'); return;
    }
    if (recognition) {
      recognition.stop(); recognition = null;
      document.getElementById('mic-btn').classList.remove('listening'); return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = e => {
      document.getElementById('chat-input').value = e.results[0][0].transcript;
      recognition = null;
      document.getElementById('mic-btn').classList.remove('listening');
      sendMessage();
    };
    recognition.onerror = () => { recognition = null; document.getElementById('mic-btn').classList.remove('listening'); };
    recognition.onend = () => { recognition = null; document.getElementById('mic-btn').classList.remove('listening'); };
    recognition.start();
    document.getElementById('mic-btn').classList.add('listening');
  }

  function speak(text) {
    if (!text || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.0; utt.pitch = 0.9;
    window.speechSynthesis.speak(utt);
  }
</script>
</body>
</html>\`);
});

module.exports = router;
