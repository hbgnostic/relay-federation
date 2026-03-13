# ── Stage 1: Install dependencies ────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy root workspace config
COPY package.json package-lock.json ./

# Copy only the packages the bridge needs
COPY packages/common/ packages/common/
COPY packages/bridge/ packages/bridge/

# Install production deps (workspace-aware)
RUN npm ci --omit=dev

# ── Stage 2: Production image ────────────────────────
FROM node:22-alpine

LABEL maintainer="zcooL"
LABEL description="Relay Federation Bridge — SPV mesh node for BSV"
LABEL org.opencontainers.image.source="https://github.com/zcoolz/relay-federation"

# Non-root user
RUN addgroup -S relay && adduser -S relay -G relay

WORKDIR /app

# Copy installed node_modules + source from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/common ./packages/common
COPY --from=build /app/packages/bridge ./packages/bridge
COPY --from=build /app/package.json ./

# Symlink the CLI globally
RUN ln -s /app/packages/bridge/cli.js /usr/local/bin/relay-bridge \
    && chmod +x /app/packages/bridge/cli.js

# Data directory owned by relay user
RUN mkdir -p /home/relay/.relay-bridge && chown -R relay:relay /home/relay/.relay-bridge

VOLUME /home/relay/.relay-bridge
EXPOSE 8333 9333

# Health check: hit the status endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:9333/status || exit 1

USER relay

ENTRYPOINT ["relay-bridge"]
CMD ["start"]
