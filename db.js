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

function getStats() {
  const row = queryOne(`
    SELECT
      COUNT(*) as total_messages,
      IFNULL(SUM(CASE WHEN direction = 'whatsapp_in' THEN 1 ELSE 0 END), 0) as received,
      IFNULL(SUM(CASE WHEN direction = 'sms_out' THEN 1 ELSE 0 END), 0) as relayed,
      COUNT(DISTINCT conversation_id) as active_conversations
    FROM messages
  `);
  return row || { total_messages: 0, received: 0, relayed: 0, active_conversations: 0 };
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

module.exports = { init, getConversation, getDestinations, addDestination, removeDestination, logMessage, getStats, close, getGlobalDestinations, addGlobalDestination, removeGlobalDestination };
