# Forsah — AI Trading Terminal (PAPER TRADING ONLY) — production image for Railway.
# Stage 1 builds the Nuxt interface; the final image has production dependencies only (SQLite is built into Node).
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
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

# The database lives on the Railway volume (mounted at runtime, e.g. /data) — never inside the image.
RUN mkdir -p /data && chown -R node:node /app /data

# Railway injects PORT; the app listens on 0.0.0.0:$PORT in production.
EXPOSE 8080

# The process starts as root only to hand the mounted volume (root-owned) to the unprivileged `node`
# user, then drops privileges before opening any file or socket (server/index.js, dropPrivileges()).
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
