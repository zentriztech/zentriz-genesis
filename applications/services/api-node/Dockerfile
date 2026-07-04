# Zentriz Genesis — API Voucher (Node/TypeScript)
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
# Migrations must be alongside the compiled code so init.ts can find them at dist/db/migrations/
COPY --from=builder /app/src/db/migrations ./dist/db/migrations
# T-16: policies.json (gerado do YAML via prebuild) precisa estar no runtime para
# /api/internal/policies/list + skill-store bundle_hash + reports/type-compliance.
COPY --from=builder /app/src/generated ./dist/generated

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
