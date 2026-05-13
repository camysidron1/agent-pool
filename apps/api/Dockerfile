FROM oven/bun:1.2.23 AS runtime

WORKDIR /workspace
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="agent-pool-api"

COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

RUN bun install --frozen-lockfile --production --ignore-scripts \
  && find apps packages -name node_modules -type d -prune -exec rm -rf {} + \
  && mkdir -p /var/lib/agent-pool \
  && chown -R bun:bun /workspace /var/lib/agent-pool

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "apps/api/src/index.ts"]
