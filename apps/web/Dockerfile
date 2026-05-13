FROM oven/bun:1.2.23 AS build

WORKDIR /workspace

COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

RUN bun install --frozen-lockfile \
  && find apps packages -name node_modules -type d -prune -exec rm -rf {} +
RUN cd apps/web && bun run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
LABEL org.opencontainers.image.title="agent-pool-web"

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
