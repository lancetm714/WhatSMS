const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const pptrPath = require.resolve('puppeteer');
const origPptr = require.cache[pptrPath].exports;
puppeteerExtra.executablePath = origPptr.executablePath;
require.cache[pptrPath].exports = puppeteerExtra;

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');
const db = require('./db');
const { sendSms, getSmsBatch } = require('./textbee');
const log = require('./logger');

function cleanupStaleLocks() {
  const authDir = path.join(config.dataDir, 'auth');
  if (!fs.existsSync(authDir)) return;
  const targets = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'chrome_debug.log'];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (targets.includes(entry.name)) { try { fs.unlinkSync(p); } catch {} }
    }
  };
  walk(authDir);
}

function smsConfigured() {
  return !!(config.textbee.apiKey && config.textbee.deviceId);
}

function normalizePhone(raw) {
  if (typeof raw !== 'string') return raw;
  let n = raw.trim().replace(/[\s\-().]/g, '');
  const cc = String(config.sms.countryCode || '').replace(/[^0-9]/g, '');
  if (!cc) return n;
  n = n.replace(/^\+/, '');
  if (n.length > 10 && n.startsWith(cc)) {
    n = n.slice(cc.length);
  }
  return n;
}

function isInvalidNumber(err) {
  if (!err) return false;
  const s = String(err).toLowerCase();
  return /invalid number/.test(s) ||
    /valid short code/.test(s) ||
    /valid mobile number/.test(s) ||
    /valid 10[- ]?digit/.test(s) ||
    /cannot route/.test(s);
}

function nowPlus(ms) {
  return new Date(Date.now() + ms).toISOString();
}

let lastSendAt = 0;

async function paceSend() {
  const delay = config.sms.sendDelayMs;
  if (!delay) return;
  const now = Date.now();
  const wait = lastSendAt + delay - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastSendAt = Date.now();
}

function deriveDelivery(batch, messages) {
  const msg = messages && messages.length ? messages[0] : null;
  const msgStatus = msg?.status;
  const batchStatus = batch?.status;
  const successCount = batch?.successCount || 0;
  const failureCount = batch?.failureCount || 0;

  if (msgStatus === 'failed' || batchStatus === 'failed') return 'failed';
  if (msgStatus === 'delivered' || msgStatus === 'sent') return 'success';
  if (batchStatus === 'completed' || batchStatus === 'delivered' || batchStatus === 'sent') {
    return failureCount > 0 && successCount === 0 ? 'failed' : 'success';
  }
  return 'pending';
}

function handleRetry(row, error) {
  const attempts = row.attempts + 1;
  if (attempts >= config.sms.maxAttempts) {
    db.markOutboxFailed(row.id, error);
    log.error('sms-out', `Failed after ${attempts} attempts: To ${row.destination} | ${error}`);
  } else {
    const backoff = Math.min(config.sms.retryBaseMs * Math.pow(2, attempts - 1), config.sms.retryMaxMs);
    db.retryOutbox(row.id, attempts, error, nowPlus(backoff));
    log.warn('sms-out', `Retry ${attempts}/${config.sms.maxAttempts} in ${Math.round(backoff / 1000)}s: To ${row.destination} | ${error}`);
  }
}

async function attemptSend(row) {
  const target = normalizePhone(row.destination);
  await paceSend();
  const result = await sendSms({
    to: target,
    body: row.body,
    apiKey: config.textbee.apiKey,
    deviceId: config.textbee.deviceId,
    baseUrl: config.textbee.baseUrl,
    timeoutMs: config.textbee.timeoutMs,
  });

  if (result.ok) {
    if (result.smsBatchId) {
      db.setOutboxBatch(row.id, result.smsBatchId);
      db.scheduleOutbox(row.id, nowPlus(config.sms.deliveryFirstCheckMs));
      log.info('sms-out', `Queued (batch ${result.smsBatchId}): To ${target}`);
    } else if ((result.successCount || 0) > 0 && (result.failureCount || 0) === 0) {
      db.markOutboxSent(row.id);
      log.info('sms-out', `Sent: To ${target}`);
    } else if ((result.failureCount || 0) > 0) {
      handleRetry(row, 'Could not push to device');
    } else {
      db.markOutboxSent(row.id);
      log.info('sms-out', `Sent: To ${target}`);
    }
  } else if (result.retryable) {
    handleRetry(row, result.error || 'SMS send failed');
  } else {
    db.markOutboxFailed(row.id, result.error || 'Non-retryable error');
    log.error('sms-out', `Failed permanently: To ${target} | ${result.error}`);
  }
}

async function checkDelivery(row) {
  const result = await getSmsBatch({
    apiKey: config.textbee.apiKey,
    deviceId: config.textbee.deviceId,
    baseUrl: config.textbee.baseUrl,
    smsBatchId: row.sms_batch_id,
    timeoutMs: config.textbee.timeoutMs,
  });

  if (!result.ok) {
    if (result.statusCode === 404) {
      db.clearOutboxBatch(row.id);
      db.scheduleOutbox(row.id, nowPlus(config.sms.retryBaseMs));
      return;
    }
    if (result.retryable) {
      db.scheduleOutbox(row.id, nowPlus(config.sms.pollIntervalMs));
      return;
    }
    db.markOutboxFailed(row.id, result.error || 'Status check failed');
    log.error('sms-out', `Status check failed: To ${row.destination} | ${result.error}`);
    return;
  }

  const delivery = deriveDelivery(result.batch, result.messages);
  if (delivery === 'success') {
    const smsId = result.messages?.[0]?._id || null;
    db.markOutboxSent(row.id, smsId);
    log.info('sms-out', `Delivered: To ${row.destination}`);
  } else if (delivery === 'failed') {
    const err = result.messages?.[0]?.errorMessage || result.messages?.[0]?.errorCode || result.batch?.error || 'Delivery failed';
    const normalized = normalizePhone(row.destination);
    if (isInvalidNumber(err) && normalized === row.destination) {
      db.clearOutboxBatch(row.id);
      db.markOutboxFailed(row.id, err);
      log.error('sms-out', `Permanent failure (no retry): To ${row.destination} | ${err}`);
    } else {
      db.clearOutboxBatch(row.id);
      handleRetry(row, err);
    }
  } else {
    db.scheduleOutbox(row.id, nowPlus(config.sms.pollIntervalMs));
  }
}

async function processOutboxRow(row) {
  try {
    if (row.sms_batch_id) {
      await checkDelivery(row);
    } else {
      await attemptSend(row);
    }
  } catch (err) {
    log.error('outbox', `Row ${row.id} error: ${err.message}`);
    handleRetry(row, err.message);
  }
}

function startOutboxWorker() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const rows = db.getPendingOutbox(new Date().toISOString(), 20);
      for (const row of rows) {
        await processOutboxRow(row);
      }
      log.sendStats(db.getStats());
    } catch (err) {
      log.error('outbox', `Worker error: ${err.message}`);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, config.sms.workerIntervalMs);
  tick();
}

async function main() {
  await db.init();

  cleanupStaleLocks();

  if (smsConfigured()) {
    log.info('system', 'SMS provider: textbee.dev');
    startOutboxWorker();
  } else {
    log.info('system', 'SMS provider: offline (set TEXBEE_API_KEY and TEXBEE_DEVICE_ID in environment)');
  }

  const puppeteerOpts = {
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
  if (config.puppeteerExecutablePath) {
    puppeteerOpts.executablePath = config.puppeteerExecutablePath;
  }

  log.info('system', `Browser: ${config.puppeteerExecutablePath || 'puppeteer default'}`);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.dataDir + '/auth' }),
    puppeteer: puppeteerOpts,
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

  let wasConnected = false;
  let reconnectAttempts = 0;
  client.on('ready', () => { wasConnected = true; });
  client.on('disconnected', async (reason) => {
    log.setStatus('disconnected');
    log.warn('whatsapp', `Disconnected: ${reason}`);
    if (!wasConnected) return;
    const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
    reconnectAttempts++;
    log.info('whatsapp', `Reconnecting in ${delay / 1000}s...`);
    await new Promise(r => setTimeout(r, delay));
    try {
      await client.destroy().catch(() => {});
      try { execSync('pkill -f "chromium" 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
      await new Promise(r => setTimeout(r, 2000));
      await client.initialize();
      reconnectAttempts = 0;
    } catch (e) {
      log.error('whatsapp', `Reconnect failed: ${e.message}`);
    }
  });

  client.on('message', async (msg) => {
    if (msg.fromMe) return;

    const from = msg.from;
    const number = from.split('@')[0];
    const body = msg.body;
    const hasMedia = msg.hasMedia;

    log.info('wa-in', `From: ${number}${from.endsWith('@g.us') ? ' (group)' : ''}${body ? ' | ' + body.slice(0, 120) : ''}`);

    const hasText = typeof body === 'string' && body.trim().length > 0;
    if (!hasText && !hasMedia) {
      log.info('wa-in', 'Skipping: message has no text and no media');
      return;
    }

    if (hasText && body.startsWith('!')) {
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
      try {
        const media = await msg.downloadMedia();
        if (media) {
          mediaType = media.mimetype;
          log.info('media', `${mediaType} (${media.data.length}b)`);
        }
      } catch (e) {
        log.warn('media', `Download failed: ${e.message}`);
      }
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
      const target = normalizePhone(dest);
      if (smsConfigured()) {
        db.enqueue(conv.id, target, smsBody);
        log.info('sms-out', `Queued: To ${target} | ${smsBody.slice(0, 80)}`);
      } else {
        log.info('sms-out', `To: ${target}`);
        log.info('sms-out', `Body: ${smsBody}`);
        log.info('sms-out', 'Status: SENT (offline - no SMS provider)');
      }
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
          const normalized = normalizePhone(phone);
          db.addDestination(number, normalized);
          await client.sendMessage(from, `\u2713 Added destination: ${normalized}`);
          log.info('system', `Destination added: ${normalized}`);
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
          `Pending: ${stats.pending}\n` +
          `Failed: ${stats.failed}\n` +
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
      provider: config.textbee.apiKey ? 'textbee' : '',
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
    const normalized = normalizePhone(String(phone));
    db.addGlobalDestination(normalized);
    log.info('system', `Destination added via GUI: ${normalized}`);
    res.json({ success: true, destinations: db.getGlobalDestinations() });
  });

  app.delete('/api/destinations/:phone', (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    db.removeGlobalDestination(phone);
    log.info('system', `Destination removed via GUI: ${phone}`);
    res.json({ success: true, destinations: db.getGlobalDestinations() });
  });

  app.get('/api/outbox', (req, res) => {
    const statuses = String(req.query.status || 'pending,failed').split(',').map((s) => s.trim()).filter(Boolean);
    res.json(db.getOutbox(statuses));
  });

  app.post('/api/outbox/:id/requeue', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    db.requeueOutbox(id);
    log.info('system', `Outbox item ${id} requeued for resend`);
    res.json({ success: true });
  });

  app.delete('/api/outbox/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    db.deleteOutbox(id);
    res.json({ success: true });
  });

  app.post('/api/send-test', (req, res) => {
    const to = normalizePhone(String(req.body?.to || '').trim());
    const message = String(req.body?.message || '').trim();
    if (!to) return res.status(400).json({ error: 'number required' });
    if (!message) return res.status(400).json({ error: 'message required' });
    if (!smsConfigured()) return res.status(400).json({ error: 'no SMS provider configured' });
    const conv = db.getConversation('__test__');
    db.enqueue(conv.id, to, message);
    log.info('system', `Test SMS queued: To ${to} | ${message.slice(0, 60)}`);
    res.json({ success: true });
  });

  app.get('/api/logs', log.sseHandler.bind(log));

  app.get('/whatsms-logo.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'whatsms-logo.png'));
  });

  app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(GUI_HTML);
  });

  app.listen(config.port, () => {
    log.info('system', `GUI at http://localhost:${config.port}`);
  });

  log.info('system', 'Starting WhatsApp client...');
  log.sendConfig(config);
  async function initClient(retries = 5) {
    for (let i = 0; i < retries; i++) {
      try {
        await client.initialize();
        return;
      } catch (err) {
        if (i >= retries - 1) throw err;
        log.warn('whatsapp', `Init failed (${err.message}), retrying (${i + 2}/${retries})...`);
        await client.destroy().catch(() => {});
        try { execSync('pkill -f "chromium" 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  await initClient();

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
<link rel="icon" type="image/png" href="/whatsms-logo.png">
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
    <img src="/whatsms-logo.png" alt="WhatSMS" style="height:28px;width:28px;border-radius:6px;object-fit:contain">
    WhatSMS
  </h1>
  <div class="status-row">
    <span class="indicator"><span class="dot gray" id="wa-dot"></span><span id="wa-label">disconnected</span></span>
    <span class="indicator" id="provider-container"><span class="dot" id="provider-dot"></span><span id="provider-label"></span></span>
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
        <div class="stat"><div class="value" id="stat-pending" style="color:var(--yellow)">0</div><div class="label">Pending</div></div>
        <div class="stat"><div class="value" id="stat-failed" style="color:var(--red)">0</div><div class="label">Failed</div></div>
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
      <h2>Outbox</h2>
      <ul class="dest-list" id="outbox-list"><li class="dest-empty">No pending/failed messages</li></ul>
    </section>
    <section>
      <h2>Config</h2>
      <div class="config-row"><span class="key">Provider</span><span class="val" id="cfg-provider">-</span></div>
      <div class="config-row"><span class="key">Destination</span><span class="val" id="cfg-dest">-</span></div>
    </section>
    <section>
      <h2>Test SMS</h2>
      <div class="dest-add-row">
        <input type="text" id="test-number" placeholder="Number to send test to" />
      </div>
      <div class="dest-add-row" style="margin-top:6px">
        <input type="text" id="test-message" placeholder="Test message" />
        <button id="test-send-btn">Send</button>
      </div>
      <div id="test-result" class="dest-empty" style="margin-top:6px"></div>
    </section>
  </div>
</div>
<script>
(function() {
  const logContainer = document.getElementById('log-container');
  const waDot = document.getElementById('wa-dot');
  const waLabel = document.getElementById('wa-label');
  const providerDot = document.getElementById('provider-dot');
  const providerLabel = document.getElementById('provider-label');
  const qrContainer = document.getElementById('qr-container');
  const statTotal = document.getElementById('stat-total');
  const statReceived = document.getElementById('stat-received');
  const statRelayed = document.getElementById('stat-relayed');
  const statPending = document.getElementById('stat-pending');
  const statFailed = document.getElementById('stat-failed');
  const statConvos = document.getElementById('stat-convos');
  const cfgProvider = document.getElementById('cfg-provider');
  const cfgDest = document.getElementById('cfg-dest');
  const destList = document.getElementById('dest-list');
  const destInput = document.getElementById('dest-input');
  const destAddBtn = document.getElementById('dest-add-btn');
  const outboxList = document.getElementById('outbox-list');
  const testNumber = document.getElementById('test-number');
  const testMessage = document.getElementById('test-message');
  const testSendBtn = document.getElementById('test-send-btn');
  const testResult = document.getElementById('test-result');

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

  function formatTime(entry) {
    if (entry.ts) return new Date(entry.ts).toLocaleTimeString();
    return entry.time || '';
  }

  function appendLog(entry) {
    const el = document.createElement('div');
    el.className = 'entry ' + (entry.level || 'info');
    el.innerHTML = '<span class="time">' + escapeHtml(formatTime(entry)) + '</span>'
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
    statPending.textContent = stats.pending ?? 0;
    statFailed.textContent = stats.failed ?? 0;
    statConvos.textContent = stats.active_conversations ?? 0;
  }

  function updateConfig(cfg) {
    if (!cfg) return;
    cfgProvider.textContent = cfg.provider || '-';
    cfgDest.textContent = cfg.hasDestination ? 'Set' : 'Not set';
    if (cfg.provider) {
      providerLabel.textContent = cfg.provider;
      providerDot.className = 'dot green';
    } else {
      providerLabel.textContent = '';
      providerDot.className = 'dot';
    }
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

  function loadOutbox() {
    fetch('/api/outbox')
      .then(r => r.json())
      .then(items => {
        if (!items.length) {
          outboxList.innerHTML = '<li class="dest-empty">No pending/failed messages</li>';
          return;
        }
        outboxList.innerHTML = items.map(item => {
          const badge = item.status === 'failed'
            ? '<span class="val" style="color:var(--red)">failed</span>'
            : '<span class="val" style="color:var(--yellow)">pending</span>';
          const err = item.last_error ? '<br><span style="color:var(--text-dim);font-size:10px">' + escapeHtml(item.last_error) + '</span>' : '';
          return '<li style="flex-direction:column;align-items:flex-start">'
            + '<div style="width:100%;display:flex;justify-content:space-between;align-items:center">'
            + '<span>' + escapeHtml(item.destination) + ' ' + badge + ' <span style="color:var(--text-dim)">x' + item.attempts + '</span></span>'
            + '<span>'
            + '<button class="remove-btn" data-action="requeue" data-id="' + item.id + '" title="Resend">&#8635;</button>'
            + '<button class="remove-btn" data-action="delete" data-id="' + item.id + '">&times;</button>'
            + '</span></div>'
            + '<div style="font-size:11px;color:var(--text-dim);word-break:break-all">' + escapeHtml(item.body) + '</div>'
            + err
            + '</li>';
        }).join('');
        outboxList.querySelectorAll('.remove-btn').forEach(btn => {
          btn.addEventListener('click', function() {
            const id = this.dataset.id;
            if (this.dataset.action === 'delete') {
              fetch('/api/outbox/' + id, { method: 'DELETE' })
                .then(r => r.json())
                .then(data => { if (data.success) loadOutbox(); })
                .catch(() => {});
            } else {
              fetch('/api/outbox/' + id + '/requeue', { method: 'POST' })
                .then(r => r.json())
                .then(data => { if (data.success) loadOutbox(); })
                .catch(() => {});
            }
          });
        });
      })
      .catch(() => {});
  }

  function sendTest() {
    const to = testNumber.value.trim();
    const message = testMessage.value.trim();
    if (!to) {
      testResult.textContent = 'Enter a number';
      return;
    }
    if (!message) {
      testResult.textContent = 'Enter a message';
      return;
    }
    testSendBtn.disabled = true;
    fetch('/api/send-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message }),
    })
      .then(r => r.json())
      .then(data => {
        testSendBtn.disabled = false;
        if (data.success) {
          testResult.textContent = 'Test queued';
          testMessage.value = '';
          loadOutbox();
        } else {
          testResult.textContent = data.error || 'Send failed';
        }
      })
      .catch(err => {
        testSendBtn.disabled = false;
        testResult.textContent = 'Error: ' + err.message;
      });
  }
  testSendBtn.addEventListener('click', sendTest);
  testMessage.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendTest(); });
  testNumber.addEventListener('keydown', function(e) { if (e.key === 'Enter') testMessage.focus(); });

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
          loadOutbox();
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
          loadOutbox();
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
