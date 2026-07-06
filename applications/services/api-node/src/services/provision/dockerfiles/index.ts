/**
 * dockerfiles/index.ts — G1-T10 (Fase B).
 *
 * Fonte-de-verdade dos Dockerfiles POR RUNTIME, keyed pelo `Runtime` do
 * runtimeDetector (G1-T7) — não mais pela heurística fundida `detectStack()`
 * (que mandava fastify → express e não conhecia FastAPI).
 *
 * Regra crítica do MVP: FastAPI recebe um Dockerfile Python (uvicorn) próprio;
 * NUNCA pode cair no template Express. Cada runtime tem seu build correto.
 *
 * `apps/Dockerfile` gerado pelo pipeline, quando presente, tem precedência sobre
 * qualquer template daqui (o Dev/DevOps é a autoridade sobre o próprio build).
 */

import type { Runtime } from "../runtimeDetector.js";

// ── Node ─────────────────────────────────────────────────────────────────────

const DOCKERFILE_NESTJS = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json pnpm-lock.yaml* yarn.lock* ./
RUN npm install --frozen-lockfile 2>/dev/null || npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
# G-1: migra+seed (idempotente, tolerante) antes de subir — necessário p/ demo (DB fresco)
# e robusto p/ produção. Não falha o boot se não houver script de migrate.
CMD ["sh", "-c", "npm run migrate 2>/dev/null || npx drizzle-kit migrate 2>/dev/null || true; npm run seed 2>/dev/null || true; node dist/main"]
`;

const DOCKERFILE_NODE_API = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build 2>/dev/null || true

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
RUN npm prune --production 2>/dev/null || true
EXPOSE 3000
# G-1: migra+seed (idempotente, tolerante) antes do start — demo (DB fresco) + robustez.
CMD ["sh", "-c", "npm run migrate 2>/dev/null || npm run db:migrate 2>/dev/null || npx drizzle-kit migrate 2>/dev/null || true; npm run seed 2>/dev/null || npm run db:seed 2>/dev/null || true; npm start"]
`;

// ── Python (FastAPI / uvicorn) ─────────────────────────────────────────────────
// Suporta requirements.txt OU pyproject.toml. uvicorn aponta para main:app
// (convenção FastAPI); PORT respeitado via ${PORT:-8000}.

const DOCKERFILE_FASTAPI = `FROM python:3.12-slim AS runner
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8000
COPY requirements*.txt pyproject.toml* poetry.lock* ./
RUN pip install --no-cache-dir --upgrade pip \\
 && ( [ -f requirements.txt ] && pip install --no-cache-dir -r requirements.txt \\
      || pip install --no-cache-dir . 2>/dev/null \\
      || pip install --no-cache-dir fastapi "uvicorn[standard]" )
COPY . .
EXPOSE 8000
# G-1: migra (alembic/genérico, tolerante) antes do uvicorn — demo (DB fresco) + robustez.
CMD ["sh", "-c", "alembic upgrade head 2>/dev/null || python -m app.migrate 2>/dev/null || true; uvicorn main:app --host 0.0.0.0 --port \${PORT:-8000}"]
`;

/** Fallback genérico Node (mesmo do Node API) — usado p/ runtime desconhecido. */
const DOCKERFILE_UNKNOWN = DOCKERFILE_NODE_API;

// ── Web estático / SSR (mantidos p/ compat com o path Fly legado) ───────────────

const DOCKERFILE_NEXTJS_STATIC = `FROM nginx:alpine
COPY out/ /usr/share/nginx/html/
EXPOSE 80
`;

const DOCKERFILE_NEXTJS_SSR = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
`;

/**
 * Retorna o Dockerfile correto para um runtime detectado.
 * FastAPI → Python; Nest → multi-stage dist/main; Fastify/Express → Node API.
 * Web/SSR não passam por aqui no path backend (seguem S3); expostos p/ o path Fly.
 */
export function dockerfileForRuntime(runtime: Runtime): string {
  switch (runtime) {
    case "nestjs":  return DOCKERFILE_NESTJS;
    case "fastapi": return DOCKERFILE_FASTAPI;
    case "fastify":
    case "express": return DOCKERFILE_NODE_API;
    case "unknown":
    default:        return DOCKERFILE_UNKNOWN;
  }
}

/** Templates web nomeados (consumidos pelo path Fly legado em dockerBuilder). */
export const WEB_DOCKERFILES = {
  nextjsStatic: DOCKERFILE_NEXTJS_STATIC,
  nextjsSsr: DOCKERFILE_NEXTJS_SSR,
} as const;
