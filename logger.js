const EventEmitter = require('events');
const QRCode = require('qrcode');

class Logger extends EventEmitter {
  constructor(maxEntries = 500) {
    super();
    this.maxEntries = maxEntries;
    this.entries = [];
    this.qrDataUrl = null;
    this.whatsappStatus = 'disconnected';
    this.sseClients = new Set();
    this.idCounter = 0;
  }

  _emit(level, tag, message) {
    const entry = {
      id: ++this.idCounter,
      time: new Date().toLocaleTimeString(),
      level,
      tag,
      message: String(message),
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    this._broadcast({ type: 'log', entry });
    return entry;
  }

  info(tag, message) { return this._emit('info', tag, message); }
  warn(tag, message) { return this._emit('warn', tag, message); }
  error(tag, message) { return this._emit('error', tag, message); }

  setStatus(status) {
    this.whatsappStatus = status;
    this._broadcast({ type: 'status', status });
  }

  setQr(raw) {
    QRCode.toDataURL(raw, { width: 400, margin: 2, errorCorrectionLevel: 'M' }, (err, url) => {
      if (err) {
        this._emit('error', 'qrcode', `QR image failed: ${err.message}`);
        this._broadcast({ type: 'qr', dataUrl: null, raw, error: err.message });
        return;
      }
      this.qrDataUrl = url;
      this._emit('info', 'qrcode', 'QR code generated — scan in GUI or terminal');
      this._broadcast({ type: 'qr', dataUrl: url, raw });
    });
  }

  sendStats(stats) {
    this._broadcast({ type: 'stats', stats });
  }

  sendConfig(cfg) {
    this._broadcast({
      type: 'config',
      provider: cfg.textbee?.apiKey ? 'textbee' : 'mock',
      hasDestination: !!(cfg.defaultDestination),
    });
  }

  _broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(msg);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  sseHandler(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    res.write(`data: ${JSON.stringify({
      type: 'init',
      logs: this.entries.slice(-100),
      status: this.whatsappStatus,
      qr: this.qrDataUrl,
    })}\n\n`);

    this.sseClients.add(res);

    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }
}

module.exports = new Logger();
