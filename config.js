const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

module.exports = {
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  defaultDestination: process.env.DEFAULT_DESTINATION || '',
  port: parseInt(process.env.PORT || '3000', 10),
  textbee: {
    apiKey: process.env.TEXBEE_API_KEY || '',
    deviceId: process.env.TEXBEE_DEVICE_ID || '',
    baseUrl: process.env.TEXBEE_BASE_URL || 'https://api.textbee.dev',
  },
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
};
