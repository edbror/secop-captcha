FROM node:22-bookworm
WORKDIR /app

# Install Chromium and dependencies (headless browser)
RUN apt-get update && apt-get install -y \
    chromium \
    curl \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy dependencies and install
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Copy source
COPY src/ ./src/

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /bin/bash appuser
USER appuser

ENV PORT=3000
ENV FARM_SERVICE=2captcha
ENV VERIFY_WITH_GOOGLE=true
ENV HOST=0.0.0.0
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_CHECK=true

CMD ["node", "src/server-ponytail.js"]
