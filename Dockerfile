FROM node:22-slim

# Chromium (via Puppeteer) needs these system libraries to run on a minimal
# Debian base image - none of this is present in the default Node buildpack
# Render otherwise uses, which is why this needs a Docker-based deploy.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    ffmpeg \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pinned to a fixed in-image path (rather than the default ~/.cache/puppeteer)
# because Render's build-time HOME and runtime HOME differ - Chromium would
# download during the build to one path and then be looked for at another,
# failing with "Could not find Chrome" at runtime.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

# Use the apt-installed ffmpeg (current, Debian-maintained) instead of the
# bundled @ffmpeg-installer/ffmpeg Linux binary, which is a static build from
# 2018 that crashes (killed by a signal, no error output) on the unusually
# long signed URLs Kick's VOD playback endpoint returns.
ENV FFMPEG_PATH=ffmpeg

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "scripts/start.js"]
