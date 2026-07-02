FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_IGNORE_INCORRECT_LOCKFILE=1
# NEXT_PUBLIC_API_BASE_URL REMOVIDO permanentemente (2026-07-02).
# Motivo: qualquer valor além de vazio fica embutido no bundle e quebra deploys cross-env
# (bug histórico: build local com localhost:3000 pushado ao ECR).
# Solução: browser sempre faz fetch("/api/...") relativo; Next.js server-side proxy
# encaminha para o serviço `api` via NEXT_INTERNAL_API_URL (default http://api:3000).
# Ver next.config.mjs → rewrites().
RUN npm run build
# Sanity final: recusa build se bundle contiver URL absoluta de localhost.
RUN if grep -rE 'http://localhost:3000|http://127\.0\.0\.1:3000' .next/static/chunks/ >/dev/null 2>&1; then \
      echo "[Dockerfile] Bundle contém URL localhost embutida — build REJEITADO. Verifique next.config.mjs e lib/api.ts." >&2; \
      exit 1; \
    fi

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
