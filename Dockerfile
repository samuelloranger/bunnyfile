# Single-container production image.
# Elysia serves /api/* and the built web app from apps/web/dist on /.
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN cd apps/web && bun run build

FROM oven/bun:1.3-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG APP_VERSION=0.0.1
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}
ENV SERVER_PORT=3001
ENV SERVER_HOST=0.0.0.0
ENV DATA_DIR=/data/files
ENV DB_PATH=/data/bunnyfile.sqlite
LABEL org.opencontainers.image.title="bunnyfile"
LABEL org.opencontainers.image.version="${APP_VERSION}"

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared ./packages/shared

EXPOSE 3001
VOLUME ["/data"]
CMD ["bun", "run", "apps/server/src/index.ts"]
