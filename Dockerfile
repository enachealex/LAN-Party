# syntax=docker/dockerfile:1
# ---- Stage 1: build the React client (served at the domain root) ----
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
ENV VITE_BASE=/
RUN npm run build

# ---- Stage 2: the Node server (also serves the built client) ----
FROM node:20-bookworm-slim
WORKDIR /app/server
# Build tools are needed to compile sqlite3's native binding, then removed to keep the image lean.
# python3 stays: the standalone yt-dlp binary (Music activity audio extraction) runs on it.
COPY server/package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
  && npm ci --omit=dev \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && apt-get purge -y make g++ curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
COPY server/ ./
COPY --from=client-build /app/client/dist /app/client/dist

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    CLIENT_DIST=/app/client/dist
RUN mkdir -p /data
# Persist the SQLite db + uploads/gifs/sounds across restarts/redeploys.
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "index.js"]
