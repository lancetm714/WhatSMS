const https = require('https');

const DEFAULT_BASE_URL = 'https://api.textbee.dev';
const DEFAULT_TIMEOUT_MS = 20000;

function buildUrl(baseUrl, pathname) {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return new URL(pathname.replace(/^\//, ''), base);
}

function request({ baseUrl, pathname, method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let url;
    try {
      url = buildUrl(baseUrl, pathname);
    } catch (err) {
      resolve({ statusCode: 0, data: null, raw: null, error: `Invalid URL: ${err.message}` });
      return;
    }

    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: { ...headers },
    };
    if (payload) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    let settled = false;
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ statusCode: res.statusCode, data: parsed, raw: data });
      });
    });

    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ statusCode: 0, data: null, raw: null, error: 'Request timed out' });
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode: 0, data: null, raw: null, error: err.message });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function isRetryable(statusCode) {
  if (statusCode === 0) return true; // network / timeout
  if (statusCode === 429) return true; // rate limit
  if (statusCode >= 500) return true; // server error
  if (statusCode === 408) return true; // request timeout
  if (statusCode === 400) return true; // device offline / could not push (transient-ish)
  return false;
}

function describeError(statusCode, data) {
  const d = data?.data || data;
  if (d?.message) return String(d.message);
  if (d?.error) return typeof d.error === 'string' ? d.error : JSON.stringify(d.error);
  if (data?.message) return String(data.message);
  return `HTTP ${statusCode || 'error'}`;
}

async function sendSms({ to, body, apiKey, deviceId, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const payload = { message: body, recipients: [to] };
  if (deviceId) payload.deviceId = deviceId;

  const res = await request({
    baseUrl,
    pathname: '/api/v1/gateway/send-sms',
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: payload,
    timeoutMs,
  });

  if (res.error) {
    return { ok: false, retryable: true, error: res.error, raw: res.raw };
  }

  const d = res.data?.data;
  const httpOk = res.statusCode >= 200 && res.statusCode < 300;
  const accepted = httpOk && d?.success === true;
  return {
    ok: accepted,
    retryable: !accepted && isRetryable(res.statusCode),
    statusCode: res.statusCode,
    smsBatchId: d?.smsBatchId || null,
    recipientCount: d?.recipientCount,
    successCount: d?.successCount,
    failureCount: d?.failureCount,
    message: d?.message || null,
    error: accepted ? null : describeError(res.statusCode, res.data),
    raw: res.data,
  };
}

async function getSmsBatch({ apiKey, deviceId, baseUrl = DEFAULT_BASE_URL, smsBatchId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const res = await request({
    baseUrl,
    pathname: `/api/v1/gateway/devices/${encodeURIComponent(deviceId)}/sms-batch/${encodeURIComponent(smsBatchId)}`,
    method: 'GET',
    headers: { 'x-api-key': apiKey },
    timeoutMs,
  });

  if (res.error) {
    return { ok: false, retryable: true, error: res.error };
  }

  const d = res.data?.data;
  const httpOk = res.statusCode >= 200 && res.statusCode < 300;
  return {
    ok: httpOk,
    retryable: !httpOk && (isRetryable(res.statusCode) || res.statusCode === 404),
    statusCode: res.statusCode,
    batch: d?.batch || null,
    messages: d?.messages || [],
    error: httpOk ? null : describeError(res.statusCode, res.data),
  };
}

module.exports = { sendSms, getSmsBatch };
