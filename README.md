# WhatSMS

WhatsApp → SMS relay. Messages sent to a WhatsApp number are forwarded as SMS to configured phone numbers via [textbee.dev](https://textbee.dev) (Android SMS gateway).

## Features

- **WhatsApp → SMS**: One-direction relay from WhatsApp to SMS
- **Multi-destination**: Send to multiple phone numbers per message
- **Group support**: Shows `(GroupName) SenderName:` prefix in SMS
- **Web GUI**: Live logs (SSE), QR code display, destination management, stats
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
| `DEFAULT_DESTINATION` | Fallback SMS number |
| `PORT` | Web GUI port (default: 3000) |
| `HEADLESS` | Set to `false` to see the browser |
| `PUPPETEER_EXECUTABLE_PATH` | Custom Chrome path |
