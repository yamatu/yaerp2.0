FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./

ENV NODE_ENV=production \
    PORT=3010 \
    WHATSAPP_DATA_DIR=/data \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3010
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
