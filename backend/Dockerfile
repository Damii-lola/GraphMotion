# Render must deploy this backend as a Docker service (not the default
# Node native environment) — Revideo's renderVideo() drives a headless
# Chromium via Puppeteer and shells out to ffmpeg, and neither is present
# on Render's native Node runtime.
#
# In the Render dashboard: New -> Web Service -> pick this repo ->
# Render should auto-detect this Dockerfile. If it offers "native
# environment" instead, switch the environment to "Docker".

FROM node:22-slim

# Chromium (for Puppeteer, used by Revideo's render) + ffmpeg (for encoding)
# + the font/graphics libs Chromium needs headless.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Use the apt-installed Chromium instead of downloading Puppeteer's own copy.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
