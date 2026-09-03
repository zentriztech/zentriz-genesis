# Zentriz Genesis — API Voucher (Node/TypeScript)
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app

# git é necessário em RUNTIME: gitLinkProjectFolder (services/githubPush.ts) transforma a
# pasta local do projeto (PROJECT_FILES_ROOT/<id>/apps) numa working tree git-linkada ao
# repo remoto (dev), que o Deadpool usa como repo_dir para manutenção/evolução SEM clone de
# rede. Sem o binário, o passo falha com ENOENT (non-fatal) e o Deadpool cai em clone/dry-run.
RUN apk add --no-cache git

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
# Migrations must be alongside the compiled code so init.ts can find them at dist/db/migrations/
COPY --from=builder /app/src/db/migrations ./dist/db/migrations
# T-16: policies.json (gerado do YAML via prebuild) precisa estar no runtime para
# /api/internal/policies/list + skill-store bundle_hash + reports/type-compliance.
COPY --from=builder /app/src/generated ./dist/generated
# Assets estáticos (ex.: guia de Configurações em PDF) usados por tenantNotify no runtime.
COPY --from=builder /app/src/assets ./dist/assets
# RFC-0004 F2: catálogo de arquétipos (fonte única da taxonomia) lido em runtime de dist/config
COPY --from=builder /app/src/config ./dist/config

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
