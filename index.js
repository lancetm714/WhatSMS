const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');
const db = require('./db');
const vendel = require('./textbee');
const log = require('./logger');

function cleanupStaleLocks() {
  const authDir = path.join(config.dataDir, 'auth');
  if (!fs.existsSync(authDir)) return;
  for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'chrome_debug.log']) {
    try {
      const p = path.join(authDir, file);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
  try {
    execSync('taskkill /f /im brave.exe /fi "WINDOWTITLE eq " 2>nul', { stdio: 'ignore' });
    execSync('taskkill /f /im chrome.exe /fi "WINDOWTITLE eq " 2>nul', { stdio: 'ignore' });
  } catch {}
}

function createSmsProvider() {
  if (config.textbee.apiKey && config.textbee.deviceId) {
    log.info('system', 'SMS provider: textbee.dev');
    return async (to, body) => {
      const result = await vendel.sendSms({ to, body, apiKey: config.textbee.apiKey, deviceId: config.textbee.deviceId, baseUrl: config.textbee.baseUrl });
      if (result.success) {
        log.info('sms-out', `To: ${to} | IDs: ${result.messageIds.join(', ')}`);
      } else {
        log.error('sms-out', `To: ${to} | FAILED: ${JSON.stringify(result.error)}`);
      }
      return result;
    };
  }

  log.info('system', 'SMS provider: offline (set TEXBEE_API_KEY and TEXBEE_DEVICE_ID in environment)');
  return async (to, body) => {
    log.info('sms-out', `To: ${to}`);
    log.info('sms-out', `Body: ${body}`);
    log.info('sms-out', 'Status: SENT (offline - no SMS provider)');
    return { success: true, offline: true };
  };
}

async function main() {
  await db.init();

  cleanupStaleLocks();

  const sendSms = createSmsProvider();
  const puppeteerOpts = {
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--disable-default-apps',
      '--disable-notifications',
    ],
  };
  if (config.puppeteerExecutablePath) {
    puppeteerOpts.executablePath = config.puppeteerExecutablePath;
  }

  log.info('system', `Browser: ${config.puppeteerExecutablePath || 'puppeteer default'}`);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.dataDir + '/auth' }),
    puppeteer: puppeteerOpts,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1040051030-alpha.html',
    },
  });

  client.on('qr', (qr) => {
    log.setQr(qr);
    log.info('whatsapp', 'QR code received — scan with WhatsApp');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    log.setStatus('authenticated');
    log.info('whatsapp', 'Authenticated');
  });

  client.on('auth_failure', (msg) => {
    log.setStatus('auth_failure');
    log.error('whatsapp', `Auth failure: ${msg}`);
  });

  client.on('disconnected', (reason) => {
    log.setStatus('disconnected');
    log.warn('whatsapp', `Disconnected: ${reason}`);
  });

  client.on('message', async (msg) => {
    const from = msg.from;
    const number = from.split('@')[0];
    const body = msg.body;
    const hasMedia = msg.hasMedia;

    log.info('wa-in', `From: ${number}${from.endsWith('@g.us') ? ' (group)' : ''}${body ? ' | ' + body.slice(0, 120) : ''}`);

    if (body.startsWith('!')) {
      await handleCommand(msg, from, number, client);
      return;
    }

    const conv = db.getConversation(number);
    let destinations = db.getDestinations(number);
    if (destinations.length === 0) {
      destinations = db.getGlobalDestinations();
    }
    if (destinations.length === 0 && config.defaultDestination) {
      destinations = [config.defaultDestination];
    }

    if (destinations.length === 0) {
      await client.sendMessage(from, 'No SMS destination set. Use:\n!dest add +1234567890');
      return;
    }

    let mediaType = null;
    if (hasMedia) {
      const media = await msg.downloadMedia();
      mediaType = media.mimetype;
      log.info('media', `${mediaType} (${media.data.length}b)`);
    }

    db.logMessage(conv.id, 'whatsapp_in', body, mediaType);

    let groupContext = '';
    if (from.endsWith('@g.us')) {
      let chatName = '';
      let senderName = '';
      try {
        const contact = await msg.getContact();
        senderName = contact.pushname || contact.name || contact.number || msg.author?.split('@')[0] || number;
        log.info('wa-in', `Sender: ${senderName}`);
      } catch (e) {
        log.warn('wa-in', `getContact: ${e.message}`);
      }
      try {
        const chat = await client.getChatById(from);
        chatName = chat.name;
        log.info('wa-in', `Chat name: ${chatName}`);
      } catch (e) {
        log.warn('wa-in', `getChatById: ${e.message}`);
        try {
          const chatNameFound = await client.pupPage.evaluate((gid) => {
            try {
              const Chat = window.require('WAWebCollections').Chat;
              if (Chat._index) {
                for (const key in Chat._index) {
                  const entry = Chat._index[key];
                  if (entry && (entry.id === gid || entry._serialized === gid)) {
                    return entry.name || entry.formattedTitle || '';
                  }
                }
              }
              if (Chat._models) {
                for (const m of Chat._models) {
                  const id = m.id;
                  const s = (typeof id === 'object' && id) ? (id._serialized || '') : String(id || '');
                  if (s === gid) {
                    return m.name || m.formattedTitle || '';
                  }
                }
              }
            } catch (e) { return 'ERR:' + e.message; }
            return '';
          }, from);
          if (chatNameFound) {
            chatName = chatNameFound;
            log.info('wa-in', `Chat name: ${chatName}`);
          } else {
            log.warn('wa-in', 'Chat not found in _index or _models');
          }
        } catch (e2) {
          log.warn('wa-in', `chat eval: ${e2.message}`);
        }
      }
      if (!chatName) {
        chatName = number;
        log.warn('wa-in', 'Using group ID as name');
      }
      groupContext = senderName ? `(${chatName}) ${senderName}: ` : `(${chatName}) `;
    }

    const smsBody = groupContext + buildSmsBody(body, mediaType);
    for (const dest of destinations) {
      const result = await sendSms(dest, smsBody);
      db.logMessage(conv.id, 'sms_out', smsBody);
    }
    log.sendStats(db.getStats());

  });

  async function handleCommand(msg, from, number) {
    const parts = msg.body.slice(1).trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'dest':
      case 'destination': {
        const sub = parts[1] ? parts[1].toLowerCase() : 'list';
        const phone = parts.slice(2).join(' ');

        if (sub === 'list') {
          const dests = db.getDestinations(number);
          const list = dests.length
            ? dests.map((d, i) => `${i + 1}. ${d}`).join('\n')
            : 'No destinations set';
          await client.sendMessage(from, `*Destinations*\n${list}`);
          return;
        }

        if (sub === 'add') {
          if (!phone) {
            await client.sendMessage(from, 'Usage: !dest add +1234567890');
            return;
          }
          db.addDestination(number, phone);
          await client.sendMessage(from, `\u2713 Added destination: ${phone}`);
          log.info('system', `Destination added: ${phone}`);
          return;
        }

        if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
          if (!phone) {
            await client.sendMessage(from, 'Usage: !dest remove +1234567890');
            return;
          }
          db.removeDestination(number, phone);
          await client.sendMessage(from, `\u2713 Removed destination: ${phone}`);
          log.info('system', `Destination removed: ${phone}`);
          return;
        }

        await client.sendMessage(from,
          'Usage:\n' +
          '!dest list - Show all destinations\n' +
          '!dest add +1234567890 - Add destination\n' +
          '!dest remove +1234567890 - Remove destination'
        );
        break;
      }
      case 'status':
      case 'stats': {
        const stats = db.getStats();
        const dests = db.getDestinations(number);
        const destList = dests.length
          ? dests.map((d, i) => `${i + 1}. ${d}`).join('\n')
          : config.defaultDestination || 'NOT SET';
        await client.sendMessage(from,
          `*Relay Status*\n` +
          `Destinations:\n${destList}\n\n` +
          `Total messages: ${stats.total_messages}\n` +
          `Received: ${stats.received}\n` +
          `Relayed: ${stats.relayed}\n` +
          `Active conversations: ${stats.active_conversations}`
        );
        break;
      }
      case 'help':
        await client.sendMessage(from,
          `*Commands*\n` +
          `!dest list \u2013 Show destinations\n` +
          `!dest add +1234567890 \u2013 Add destination\n` +
          `!dest remove +1234567890 \u2013 Remove destination\n` +
          `!status \u2013 Relay statistics\n` +
          `!help \u2013 This message`
        );
        break;
      default:
        await client.sendMessage(from, 'Unknown command. Try !help');
    }
  }

  function buildSmsBody(textBody, mediaType) {
    const parts = [];
    if (textBody) parts.push(textBody);
    if (mediaType) {
      if (mediaType.startsWith('image/')) parts.push('[Image]');
      else if (mediaType.startsWith('video/')) parts.push('[Video]');
      else if (mediaType.startsWith('audio/')) parts.push('[Voice message]');
      else parts.push(`[${mediaType}]`);
    }
    return parts.join(' ');
  }

  // ── Express ──────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  let currentNumber = '';

  client.on('ready', () => {
    log.setStatus('connected');
    log.info('whatsapp', 'Client ready!');
    log.info('whatsapp', `Default destination: ${config.defaultDestination || 'NOT SET (!dest command)'}`);
    // Store the client's own number from the first known contact
    if (client.info && client.info.wid && client.info.wid.user) {
      currentNumber = client.info.wid.user;
    }
  });

  app.get('/api/status', (req, res) => {
    res.json({
      service: 'WhatsApp \u2192 SMS Relay',
      status: 'running',
      whatsapp: log.whatsappStatus,
      provider: config.textbee.apiKey ? 'textbee' : 'offline',
      stats: db.getStats(),
      defaultDestination: config.defaultDestination || null,
    });
  });

  app.get('/api/destinations', (req, res) => {
    res.json(db.getGlobalDestinations());
  });

  app.post('/api/destinations', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    db.addGlobalDestination(phone);
    log.info('system', `Destination added via GUI: ${phone}`);
    res.json({ success: true, destinations: db.getGlobalDestinations() });
  });

  app.delete('/api/destinations/:phone', (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    db.removeGlobalDestination(phone);
    log.info('system', `Destination removed via GUI: ${phone}`);
    res.json({ success: true, destinations: db.getGlobalDestinations() });
  });

  app.get('/api/logs', log.sseHandler.bind(log));

  app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(GUI_HTML);
  });

  app.listen(config.port, () => {
    log.info('system', `GUI at http://localhost:${config.port}`);
  });

  log.info('system', 'Starting WhatsApp client...');
  log.sendConfig(config);
  client.initialize();

  process.on('SIGINT', () => {
    log.info('system', 'Shutting down...');
    client.destroy();
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    client.destroy();
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

const GUI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatSMS</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --cyan: #58a6ff;
    --font: 'SFMono-Regular', 'Consolas', 'Liberation Mono', monospace;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 10px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  header h1 { font-size: 15px; font-weight: 600; }
  header .status-row { display: flex; align-items: center; gap: 16px; }
  .indicator {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--text-dim);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.green { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .dot.yellow { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
  .dot.red { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .dot.gray { background: var(--text-dim); }
  .main { display: flex; flex: 1; overflow: hidden; }
  .logs-panel { flex: 1; overflow-y: auto; padding: 8px 0; }
  .logs-panel .entry {
    padding: 2px 16px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 12px;
  }
  .entry .time { color: var(--text-dim); margin-right: 8px; }
  .entry .tag {
    display: inline-block; min-width: 60px; margin-right: 8px;
    font-weight: 600;
  }
  .entry.info .tag { color: var(--cyan); }
  .entry.warn .tag { color: var(--yellow); }
  .entry.error .tag { color: var(--red); }
  .sidebar {
    width: 320px; flex-shrink: 0;
    border-left: 1px solid var(--border);
    background: var(--surface);
    display: flex; flex-direction: column;
    overflow-y: auto;
  }
  .sidebar section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar section:last-child { border-bottom: none; }
  .sidebar h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); margin-bottom: 8px; }
  .sidebar .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .sidebar .stat { text-align: center; padding: 8px; background: var(--bg); border-radius: 6px; }
  .sidebar .stat .value { font-size: 22px; font-weight: 700; }
  .sidebar .stat .label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; margin-top: 2px; }
  #qr-container {
    text-align: center; min-height: 120px;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  #qr-container img { width: 180px; height: 180px; image-rendering: pixelated; }
  #qr-container .hint { font-size: 11px; color: var(--text-dim); margin-top: 6px; }
  .config-row { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
  .config-row .key { color: var(--text-dim); }
  .config-row .val { color: var(--text); }
  .dest-list { list-style: none; font-size: 12px; max-height: 160px; overflow-y: auto; }
  .dest-list li { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border); }
  .dest-list li:last-child { border-bottom: none; }
  .dest-list .remove-btn { cursor: pointer; color: var(--red); font-size: 14px; line-height: 1; background: none; border: none; padding: 0 4px; }
  .dest-list .remove-btn:hover { opacity: .7; }
  .dest-add-row { display: flex; gap: 6px; margin-top: 8px; }
  .dest-add-row input { flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 4px; font-size: 12px; font-family: var(--font); }
  .dest-add-row button { background: var(--cyan); color: #fff; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .dest-add-row button:hover { opacity: .8; }
  .dest-empty { font-size: 12px; color: var(--text-dim); font-style: italic; }
  @media (max-width: 720px) {
    .main { flex-direction: column; }
    .sidebar { width: 100%; border-left: none; border-top: 1px solid var(--border); max-height: 40vh; }
  }
</style>
</head>
<body>
<header>
  <h1 style="display:flex;align-items:center;gap:10px">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    WhatSMS
  </h1>
  <div class="status-row">
    <span class="indicator"><span class="dot gray" id="wa-dot"></span><span id="wa-label">disconnected</span></span>
    <span class="indicator" id="provider-label">offline</span>
  </div>
</header>
<div class="main">
  <div class="logs-panel" id="log-container"></div>
  <div class="sidebar">
    <section>
      <h2>QR Code</h2>
      <div id="qr-container">
        <div class="hint">Waiting for QR code...</div>
      </div>
    </section>
    <section>
      <h2>Statistics</h2>
      <div class="stat-grid">
        <div class="stat"><div class="value" id="stat-total">0</div><div class="label">Total</div></div>
        <div class="stat"><div class="value" id="stat-received" style="color:var(--cyan)">0</div><div class="label">Received</div></div>
        <div class="stat"><div class="value" id="stat-relayed" style="color:var(--green)">0</div><div class="label">Relayed</div></div>
        <div class="stat"><div class="value" id="stat-convos">0</div><div class="label">Convos</div></div>
      </div>
    </section>
    <section>
      <h2>Destinations</h2>
      <ul class="dest-list" id="dest-list"><li class="dest-empty">No destinations</li></ul>
      <div class="dest-add-row">
        <input type="text" id="dest-input" placeholder="+1234567890" />
        <button id="dest-add-btn">Add</button>
      </div>
    </section>
    <section>
      <h2>Config</h2>
      <div class="config-row"><span class="key">Provider</span><span class="val" id="cfg-provider">-</span></div>
      <div class="config-row"><span class="key">Destination</span><span class="val" id="cfg-dest">-</span></div>
    </section>
  </div>
</div>
<script>
(function() {
  const logContainer = document.getElementById('log-container');
  const waDot = document.getElementById('wa-dot');
  const waLabel = document.getElementById('wa-label');
  const providerLabel = document.getElementById('provider-label');
  const qrContainer = document.getElementById('qr-container');
  const statTotal = document.getElementById('stat-total');
  const statReceived = document.getElementById('stat-received');
  const statRelayed = document.getElementById('stat-relayed');
  const statConvos = document.getElementById('stat-convos');
  const cfgProvider = document.getElementById('cfg-provider');
  const cfgDest = document.getElementById('cfg-dest');
  const destList = document.getElementById('dest-list');
  const destInput = document.getElementById('dest-input');
  const destAddBtn = document.getElementById('dest-add-btn');

  const statusMap = {
    connected: ['green', 'Connected'],
    authenticated: ['yellow', 'Authenticated'],
    disconnected: ['gray', 'Disconnected'],
    auth_failure: ['red', 'Auth Failed'],
  };

  function setStatus(s) {
    const [color, label] = statusMap[s] || ['gray', s || 'disconnected'];
    waDot.className = 'dot ' + color;
    waLabel.textContent = label;
  }

  function appendLog(entry) {
    const el = document.createElement('div');
    el.className = 'entry ' + (entry.level || 'info');
    el.innerHTML = '<span class="time">' + escapeHtml(entry.time) + '</span>'
      + '<span class="tag">[' + escapeHtml(entry.tag) + ']</span>'
      + escapeHtml(entry.message);
    logContainer.appendChild(el);
    logContainer.scrollTop = logContainer.scrollHeight;
    // keep last 500 entries in DOM
    while (logContainer.children.length > 500) logContainer.removeChild(logContainer.firstChild);
  }

  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function showQr(url) {
    if (url) {
      qrContainer.innerHTML = '<img src="' + url + '" alt="QR Code"><div class="hint">Scan with WhatsApp</div>';
    } else {
      qrContainer.innerHTML = '<div class="hint">Waiting for QR code...</div>';
    }
  }

  function updateStats(stats) {
    if (!stats) return;
    statTotal.textContent = stats.total_messages ?? 0;
    statReceived.textContent = stats.received ?? 0;
    statRelayed.textContent = stats.relayed ?? 0;
    statConvos.textContent = stats.active_conversations ?? 0;
  }

  function updateConfig(cfg) {
    if (!cfg) return;
    cfgProvider.textContent = cfg.provider || '-';
    cfgDest.textContent = cfg.hasDestination ? 'Set' : 'Not set';
    providerLabel.textContent = cfg.provider || 'offline';
  }

  function loadDestinations() {
    fetch('/api/destinations')
      .then(r => r.json())
      .then(dests => {
        if (!dests.length) {
          destList.innerHTML = '<li class="dest-empty">No destinations</li>';
          return;
        }
        destList.innerHTML = dests.map(p =>
          '<li><span>' + escapeHtml(p) + '</span><button class="remove-btn" data-phone="' + escapeHtml(p) + '">&times;</button></li>'
        ).join('');
        destList.querySelectorAll('.remove-btn').forEach(btn => {
          btn.addEventListener('click', function() {
            const phone = this.dataset.phone;
            fetch('/api/destinations/' + encodeURIComponent(phone), { method: 'DELETE' })
              .then(r => r.json())
              .then(data => { if (data.success) loadDestinations(); })
              .catch(() => {});
          });
        });
      })
      .catch(() => {});
  }

  destAddBtn.addEventListener('click', function() {
    const phone = destInput.value.trim();
    if (!phone) return;
    fetch('/api/destinations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success) { destInput.value = ''; loadDestinations(); }
      })
      .catch(() => {});
  });
  destInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') destAddBtn.click();
  });

  const evtSource = new EventSource('/api/logs');
  evtSource.onmessage = function(e) {
    try {
      const data = JSON.parse(e.data);
      switch (data.type) {
        case 'init':
          if (data.logs) data.logs.forEach(appendLog);
          if (data.status) setStatus(data.status);
          if (data.qr) showQr(data.qr);
          loadDestinations();
          break;
        case 'log':
          appendLog(data.entry);
          break;
        case 'status':
          setStatus(data.status);
          if (data.status === 'connected') loadDestinations();
          break;
        case 'qr':
          showQr(data.dataUrl);
          break;
        case 'stats':
          updateStats(data.stats);
          break;
        case 'config':
          updateConfig(data);
          break;
      }
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };
  evtSource.onerror = function() {
    setStatus('disconnected');
  };
})();
</script>
</body>
</html>`;
