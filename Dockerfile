# Forsah — AI Trading Terminal (PAPER TRADING ONLY) — production image.
# Stage 1 builds the Nuxt interface; the final image has production dependencies only.
FROM node:26-trixie-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:26-trixie-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# application code only — no data, no .env, no tests (see .dockerignore)
COPY server ./server
COPY public ./public
COPY --from=web /web/.output/public ./web/.output/public
COPY config ./config
COPY scripts ./scripts

# Data is in PostgreSQL. /data (a volume at runtime) holds only the encryption key files — never inside the image.
RUN mkdir -p /data && chown -R node:node /app /data

# The app listens on 0.0.0.0:$PORT in production; a host may set its own PORT.
EXPOSE 8080

# The process starts as root only to hand the mounted volume (root-owned) to the unprivileged `node`
# user, then drops privileges before opening any file or socket (server/index.js, dropPrivileges()).
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
