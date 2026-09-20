# ── Build stage ─────────────────────────────────────────────────────
FROM oven/bun:1.4.1-alpine AS build
WORKDIR /app

# Pinning the manifest copy before the install step. If the lockfile hasn't
# drifted, Docker serves the install layer from cache, saving ~40 seconds.
COPY package.json bun.lock* ./

# Pulling in the full dependency tree (dev included) because the build
# stage needs the TypeScript compiler to turn .tsx into .js.
RUN bun install --frozen-lockfile

COPY . .

# Transpiling the source tree. This leaves a heavy footprint, but it
# stays trapped in the build stage and never reaches production.
RUN bun run build


# ── Production stage ────────────────────────────────────────────────
FROM oven/bun:1.4.1-alpine AS production
WORKDIR /app

# Chromium and its system libraries for the Playwright auth fallback.
# Heavy (~200MB), but isolated to the production stage.
# hadolint ignore=DL3018
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    glib \
    font-noto-cjk \
    dbus \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Starting fresh with production deps. We deliberately abandon the build
# stage's node_modules to strip out biome, tsx, and the 400MB of dev tools.
# --ignore-scripts is critical: the postinstall hook runs `node scripts/setup.js`
# and neither `node` nor `scripts/` exist in this stage.
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile --ignore-scripts

# Smuggling only the compiled dist/ across the stage boundary.
# Source files, tests, and docs are left to die in the build stage.
COPY --from=build /app/dist ./dist

# Dropping root privileges. The qwen user gets ownership of the
# persistent volume and log directories to avoid permission hell at runtime.
RUN addgroup -g 1001 -S qwen && \
    adduser -S qwen -u 1001 -G qwen && \
    mkdir -p /app/.qwen /app/logs && \
    chown -R qwen:qwen /app
USER qwen

ENV QWEN_GATE_PORT=26405
ENV NODE_ENV=production
EXPOSE 26405
VOLUME [ "/app/.qwen" ]

# Pinging the dedicated /health endpoint. Alpine's busybox provides wget
# natively, so we avoid installing curl just to check if the server is alive.
# Wrapped in sh -c because the || fallback needs a shell interpreter.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["sh", "-c", "wget -qO- http://localhost:26405/health || exit 1"]

CMD [ "bun", "dist/index.js" ]