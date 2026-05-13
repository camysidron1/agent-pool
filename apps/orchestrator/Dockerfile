FROM oven/bun:1.2.23 AS runtime

WORKDIR /workspace
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="agent-pool-orchestrator"

COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

RUN bun install --frozen-lockfile --production --ignore-scripts \
  && find apps packages -name node_modules -type d -prune -exec rm -rf {} + \
  && chown -R bun:bun /workspace

USER bun
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3001/health').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "apps/orchestrator/src/index.ts"]
