const https = require('https');

async function sendSms({ to, body, apiKey, deviceId, baseUrl }) {
  const url = new URL(`/api/v1/gateway/devices/${deviceId}/send-sms`, baseUrl);

  return new Promise((resolve) => {
    const payload = JSON.stringify({ recipients: [to], message: body });
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ success: res.statusCode < 400, messageIds: [json?.data?.id || 'unknown'], raw: json });
        } catch {
          resolve({ success: res.statusCode < 400, messageIds: [], raw: data });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.write(payload);
    req.end();
  });
}

module.exports = { sendSms };
