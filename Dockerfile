FROM node:22-slim

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libnspr4 \
    libatk1.0-0t64 \
    libatk-bridge2.0-0t64 \
    libcups2t64 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2t64 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY . .

RUN addgroup --system --gid 1001 app && \
    adduser --system --uid 1001 app && \
    chown -R app:app /app

USER app

VOLUME /app/data

EXPOSE 3000

CMD ["node", "index.js"]
