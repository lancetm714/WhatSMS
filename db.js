const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { dataDir } = require('./config');

let db;

async function init() {
  fs.mkdirSync(dataDir, { recursive: true });

  const SQL = await initSqlJs();
  const dbPath = path.join(dataDir, 'relay.db');

  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      whatsapp_number TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      UNIQUE(conversation_id, phone)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      body TEXT,
      media_type TEXT,
      media_path TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      destination TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      sms_batch_id TEXT,
      sms_id TEXT,
      last_error TEXT,
      next_attempt_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);

  migrateOrphanedDestinations();
  persist();
  return db;
}

function persist() {
  const data = db.export();
  fs.writeFileSync(path.join(dataDir, 'relay.db'), Buffer.from(data));
}

function migrateOrphanedDestinations() {
  const globalConv = queryOne('SELECT id FROM conversations WHERE whatsapp_number = ?', [GLOBAL_KEY]);
  const globalId = globalConv ? globalConv.id : null;
  const orphaned = queryAll(
    'SELECT d.id, d.phone FROM destinations d JOIN conversations c ON d.conversation_id = c.id WHERE c.whatsapp_number != ?',
    [GLOBAL_KEY]
  );
  for (const o of orphaned) {
    if (globalId) {
      execute('INSERT OR IGNORE INTO destinations (conversation_id, phone) VALUES (?, ?)', [globalId, o.phone]);
    }
    execute('DELETE FROM destinations WHERE id = ?', [o.id]);
  }
  if (orphaned.length > 0) persist();
}

function queryOne(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function queryAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function execute(sql, params) {
  db.run(sql, params || []);
}

function getConversation(whatsappNumber) {
  let conv = queryOne('SELECT * FROM conversations WHERE whatsapp_number = ?', [whatsappNumber]);

  if (!conv) {
    execute('INSERT INTO conversations (whatsapp_number) VALUES (?)', [whatsappNumber]);
    persist();
    conv = queryOne('SELECT * FROM conversations WHERE whatsapp_number = ?', [whatsappNumber]);
  }

  return conv;
}

function getDestinations(whatsappNumber) {
  const conv = getConversation(whatsappNumber);
  const rows = queryAll('SELECT phone FROM destinations WHERE conversation_id = ? ORDER BY id', [conv.id]);
  return rows.map(r => r.phone);
}

function addDestination(whatsappNumber, phone) {
  const conv = getConversation(whatsappNumber);
  execute(
    'INSERT OR IGNORE INTO destinations (conversation_id, phone) VALUES (?, ?)',
    [conv.id, phone]
  );
  persist();
}

function removeDestination(whatsappNumber, phone) {
  const conv = getConversation(whatsappNumber);
  execute(
    'DELETE FROM destinations WHERE conversation_id = ? AND phone = ?',
    [conv.id, phone]
  );
  persist();
}

function logMessage(conversationId, direction, body, mediaType, mediaPath) {
  execute(
    'INSERT INTO messages (conversation_id, direction, body, media_type, media_path, status) VALUES (?, ?, ?, ?, ?, ?)',
    [conversationId, direction, body || null, mediaType || null, mediaPath || null,
     direction === 'sms_out' ? 'sent' : 'received']
  );
  persist();
}

function enqueue(conversationId, destination, body) {
  execute(
    'INSERT INTO outbox (conversation_id, destination, body, status, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)',
    [conversationId, destination, body, 'pending', 0, new Date().toISOString()]
  );
  persist();
}

function getPendingOutbox(nowIso, limit = 20) {
  const rows = queryAll(
    `SELECT * FROM outbox
     WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY id ASC LIMIT ?`,
    [nowIso, limit]
  );
  return rows;
}

function setOutboxBatch(id, smsBatchId) {
  execute(
    'UPDATE outbox SET sms_batch_id = ?, last_error = NULL, updated_at = datetime(\'now\') WHERE id = ?',
    [smsBatchId, id]
  );
  persist();
}

function clearOutboxBatch(id) {
  execute(
    'UPDATE outbox SET sms_batch_id = NULL, sms_id = NULL, updated_at = datetime(\'now\') WHERE id = ?',
    [id]
  );
  persist();
}

function scheduleOutbox(id, nextAttemptIso) {
  execute(
    'UPDATE outbox SET next_attempt_at = ?, updated_at = datetime(\'now\') WHERE id = ?',
    [nextAttemptIso, id]
  );
  persist();
}

function retryOutbox(id, attempts, error, nextAttemptIso) {
  execute(
    'UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ?, status = \'pending\', updated_at = datetime(\'now\') WHERE id = ?',
    [attempts, error || null, nextAttemptIso, id]
  );
  persist();
}

function markOutboxSent(id, smsId) {
  execute(
    'UPDATE outbox SET status = \'sent\', sms_id = ?, last_error = NULL, next_attempt_at = NULL, updated_at = datetime(\'now\') WHERE id = ?',
    [smsId || null, id]
  );
  persist();
}

function markOutboxFailed(id, error) {
  execute(
    'UPDATE outbox SET status = \'failed\', last_error = ?, next_attempt_at = NULL, updated_at = datetime(\'now\') WHERE id = ?',
    [error || null, id]
  );
  persist();
}

function requeueOutbox(id) {
  execute(
    'UPDATE outbox SET status = \'pending\', attempts = 0, sms_batch_id = NULL, sms_id = NULL, last_error = NULL, next_attempt_at = ?, updated_at = datetime(\'now\') WHERE id = ?',
    [new Date().toISOString(), id]
  );
  persist();
}

function deleteOutbox(id) {
  execute('DELETE FROM outbox WHERE id = ?', [id]);
  persist();
}

function getOutbox(statuses, limit = 200) {
  if (!statuses.length) return [];
  const placeholders = statuses.map(() => '?').join(',');
  const rows = queryAll(
    `SELECT * FROM outbox WHERE status IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
    [...statuses, limit]
  );
  return rows;
}

function getStats() {
  const received = queryOne(
    `SELECT COUNT(*) as c FROM messages WHERE direction = 'whatsapp_in'`
  )?.c || 0;
  const sent = queryOne(
    `SELECT COUNT(*) as c FROM outbox WHERE status = 'sent'`
  )?.c || 0;
  const failed = queryOne(
    `SELECT COUNT(*) as c FROM outbox WHERE status = 'failed'`
  )?.c || 0;
  const pending = queryOne(
    `SELECT COUNT(*) as c FROM outbox WHERE status = 'pending'`
  )?.c || 0;
  const convos = queryOne(
    `SELECT COUNT(DISTINCT conversation_id) as c FROM (
       SELECT conversation_id FROM messages
       UNION ALL
       SELECT conversation_id FROM outbox
     )`
  )?.c || 0;
  return {
    total_messages: received + sent + failed + pending,
    received,
    relayed: sent,
    sent,
    failed,
    pending,
    active_conversations: convos,
  };
}

function close() {
  if (db) {
    persist();
    db.close();
  }
}

const GLOBAL_KEY = '__global__';

function getGlobalDestinations() {
  return getDestinations(GLOBAL_KEY);
}

function addGlobalDestination(phone) {
  addDestination(GLOBAL_KEY, phone);
}

function removeGlobalDestination(phone) {
  removeDestination(GLOBAL_KEY, phone);
}

module.exports = { init, getConversation, getDestinations, addDestination, removeDestination, logMessage, getStats, close, getGlobalDestinations, addGlobalDestination, removeGlobalDestination, enqueue, getPendingOutbox, setOutboxBatch, clearOutboxBatch, scheduleOutbox, retryOutbox, markOutboxSent, markOutboxFailed, requeueOutbox, deleteOutbox, getOutbox };
