# WhatSMS

<p align="center">
  <img src="whatsms-logo.png" alt="WhatSMS Logo" width="200">
</p>

WhatsApp → SMS relay. Messages sent to a WhatsApp number are forwarded as SMS to configured phone numbers via [textbee.dev](https://textbee.dev) (Android SMS gateway).

## Features

- **WhatsApp → SMS**: One-direction relay from WhatsApp to SMS
- **Reliable delivery**: Outbox queue with automatic retry/backoff and delivery-status polling (handles 429/5xx/timeouts and phone-offline failures — no manual resending)
- **Multi-destination**: Send to multiple phone numbers per message
- **Group support**: Shows `(GroupName) SenderName:` prefix in SMS
- **Web GUI**: Live logs (SSE), QR code display, destination management, outbox (pending/failed with resend), stats
- **Dockerized**: Ready for Synology NAS deployment
- **Persistent**: SQLite storage, survives restarts

## Quick Start

1. Install the [textbee.dev](https://textbee.dev) Android app and get an API key + device ID
2. Copy `.env.example` to `.env` and fill in your config
3. Run:

```
npm install
node index.js
```

4. Open http://localhost:3000, scan the QR code with WhatsApp
5. Add destination phone numbers in the GUI or via WhatsApp commands

## WhatsApp Commands

| Command | Description |
|---------|-------------|
| `!dest add +1234567890` | Add SMS destination |
| `!dest remove +1234567890` | Remove destination |
| `!dest list` | List destinations |
| `!status` | Relay statistics |
| `!help` | Show commands |

## Docker

```
docker compose up -d
```

## Environment

| Variable | Description |
|----------|-------------|
| `TEXBEE_API_KEY` | textbee.dev API key |
| `TEXBEE_DEVICE_ID` | textbee.dev device ID |
| `TEXBEE_BASE_URL` | textbee API base URL (default: `https://api.textbee.dev`) |
| `TEXBEE_TIMEOUT_MS` | HTTP timeout for textbee requests (default: `20000`) |
| `DEFAULT_DESTINATION` | Fallback SMS number |
| `PORT` | Web GUI port (default: 3000) |
| `HEADLESS` | Set to `false` to see the browser |
| `PUPPETEER_EXECUTABLE_PATH` | Custom Chrome path |
| `SMS_MAX_ATTEMPTS` | Max send attempts before marking failed (default: `10`) |
| `SMS_RETRY_BASE_MS` | Initial retry delay (default: `5000`) |
| `SMS_RETRY_MAX_MS` | Max retry delay cap (default: `1800000`, 30 min) |
| `SMS_SEND_DELAY_MS` | Minimum gap between SMS sends (default: `2000`; set `0` to disable) |
| `SMS_WORKER_INTERVAL_MS` | Outbox worker sweep interval (default: `5000`) |
| `SMS_POLL_INTERVAL_MS` | Delivery-status re-poll interval (default: `15000`) |
| `SMS_DELIVERY_FIRST_CHECK_MS` | Delay before first delivery check (default: `3000`) |
| `SMS_COUNTRY_CODE` | Leading country code to strip before sending, e.g. `1` turns `+17173010189` into `7173010189` (default: `1`; set empty to disable) |

## How delivery works

Incoming WhatsApp messages are enqueued into a persistent outbox (SQLite) and a
background worker sends them. Each send is retried with exponential backoff on
transient failures (rate limits, 5xx, timeouts, device offline). Once textbee
accepts a message it returns a `smsBatchId`, which the worker polls until the
message reaches `sent`/`delivered` (or `failed`, in which case it is retried).
Pending and failed messages are visible in the GUI and can be manually resent
or discarded.
