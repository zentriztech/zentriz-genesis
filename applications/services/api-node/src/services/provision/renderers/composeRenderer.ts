/**
 * composeRenderer.ts — DM-T4 (Fase A). Renderer Docker Compose do modo source_only.
 *
 * A partir da IR (DM-T3), gera os arquivos que o cliente baixa e roda LOCAL na hora:
 *   - docker-compose.yml  — app(s) + postgres sidecar (se o plano tiver db)
 *   - .env.example        — variáveis (DATABASE_URL, JWT_SECRET, portas, *_SERVICE_URL)
 *   - RUN.md              — instruções (`docker compose up`)
 *
 * Não toca AWS. Puro (IR → arquivos). Determinístico (sem timestamps/segredos reais —
 * placeholders no .env.example). Leste-oeste usa o nome do serviço na rede do compose
 * (http://<service>:<port>), que é justamente o que o compose resolve.
 */

import type { ProvisionPlanIR, PlanService } from "../provisionPlanIR.js";

export interface RenderedFile { path: string; content: string; }

function dbServiceName(): string { return "db"; }

/** Env de um serviço: DATABASE_URL (se tem db) + descoberta dos outros + PORT/NODE_ENV. */
function serviceEnv(plan: ProvisionPlanIR, svc: PlanService): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: "production", PORT: String(svc.port) };
  if (svc.databaseName && (plan.db.kind === "sidecar" || plan.db.kind === "rds")) {
    env.DATABASE_URL = `postgresql://genesis:\${DB_PASSWORD}@${dbServiceName()}:5432/${svc.databaseName}`;
  } else if (plan.db.kind === "external") {
    env.DATABASE_URL = "${DATABASE_URL}";
  }
  if (svc.databaseName || plan.db.kind !== "none") env.JWT_SECRET = "${JWT_SECRET}";
  // Descoberta leste-oeste: cada serviço aponta aos outros pelo nome do compose.
  for (const other of plan.services) {
    if (other.name === svc.name) continue;
    env[`${other.name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_SERVICE_URL`] =
      `http://${other.name}:${other.port}`;
  }
  return env;
}

function yamlEnvBlock(env: Record<string, string>, indent: string): string {
  return Object.entries(env).map(([k, v]) => `${indent}- ${k}=${v}`).join("\n");
}

export function renderComposeFile(plan: ProvisionPlanIR): string {
  const hasSidecar = plan.db.kind === "sidecar" || plan.db.kind === "rds";
  // No compose (local), RDS vira o mesmo postgres local — o cliente sobe tudo numa máquina.
  const lines: string[] = ["services:"];

  for (const svc of plan.services) {
    lines.push(`  ${svc.name}:`);
    lines.push(`    build: ./apps/${svc.name === "app" ? "" : svc.name}`.replace(/\/$/, "") || `    build: ./apps`);
    lines.push(`    restart: unless-stopped`);
    if (svc.needsIngress) lines.push(`    ports:\n      - "${svc.port}:${svc.port}"`);
    lines.push(`    environment:`);
    lines.push(yamlEnvBlock(serviceEnv(plan, svc), "      "));
    if (hasSidecar && svc.databaseName) {
      lines.push(`    depends_on:\n      ${dbServiceName()}:\n        condition: service_healthy`);
    }
  }

  if (hasSidecar) {
    const databases = plan.db.kind === "sidecar" || plan.db.kind === "rds" ? plan.db.databases : [];
    lines.push(`  ${dbServiceName()}:`);
    lines.push(`    image: postgres:${(plan.db.kind === "sidecar" || plan.db.kind === "rds") ? plan.db.version : "16"}-alpine`);
    lines.push(`    restart: unless-stopped`);
    lines.push(`    environment:`);
    lines.push(`      - POSTGRES_USER=genesis`);
    lines.push(`      - POSTGRES_PASSWORD=\${DB_PASSWORD}`);
    lines.push(`      - POSTGRES_DB=${databases[0] ?? "appdb"}`);
    lines.push(`    volumes:\n      - db_data:/var/lib/postgresql/data`);
    // cria os demais databases (multi-schema) no primeiro boot
    if (databases.length > 1) {
      lines.push(`      - ./deploy/initdb:/docker-entrypoint-initdb.d:ro`);
    }
    lines.push(`    healthcheck:`);
    lines.push(`      test: ["CMD-SHELL", "pg_isready -U genesis"]`);
    lines.push(`      interval: 5s\n      timeout: 3s\n      retries: 10`);
    lines.push(`volumes:\n  db_data:`);
  }
  return lines.join("\n") + "\n";
}

export function renderEnvExample(plan: ProvisionPlanIR): string {
  const lines = ["# Genesis — variáveis de ambiente (source_only). Preencha antes de subir.", ""];
  if (plan.db.kind === "sidecar" || plan.db.kind === "rds") {
    lines.push("DB_PASSWORD=troque-esta-senha");
    lines.push("JWT_SECRET=gere-um-segredo-forte-64-hex");
  } else if (plan.db.kind === "external") {
    lines.push("DATABASE_URL=postgresql://user:pass@host:5432/db");
    lines.push("JWT_SECRET=gere-um-segredo-forte-64-hex");
  }
  return lines.join("\n") + "\n";
}

/** initdb SQL para os databases extras do multi-schema (postgres cria o 1º sozinho). */
export function renderInitDbSql(plan: ProvisionPlanIR): RenderedFile | null {
  const dbs = (plan.db.kind === "sidecar" || plan.db.kind === "rds") ? plan.db.databases : [];
  if (dbs.length <= 1) return null;
  const stmts = dbs.slice(1).map((d) => `CREATE DATABASE ${d};`).join("\n");
  return { path: "deploy/initdb/01-databases.sql", content: stmts + "\n" };
}

export function renderRunMd(plan: ProvisionPlanIR): string {
  const rootPort = plan.services.find((s) => s.isRoot)?.port ?? plan.services[0]?.port ?? 3004;
  return [
    "# Rodar localmente (Docker Compose)",
    "",
    "1. Copie `.env.example` para `.env` e preencha os segredos:",
    "   ```sh",
    "   cp .env.example .env",
    "   ```",
    "2. Suba tudo:",
    "   ```sh",
    "   docker compose up --build",
    "   ```",
    `3. Acesse: http://localhost:${rootPort}` + (plan.services.find((s) => s.isRoot)?.healthPath ? ` (health: http://localhost:${rootPort}${plan.services.find((s) => s.isRoot)!.healthPath})` : ""),
    "",
    plan.multiService
      ? `Este produto tem ${plan.services.length} serviços; eles se enxergam pelo nome na rede do compose.`
      : "Serviço único.",
    "",
  ].join("\n") + "\n";
}

/** Bundle Docker completo do modo source_only. */
export function renderComposeBundle(plan: ProvisionPlanIR): RenderedFile[] {
  const files: RenderedFile[] = [
    { path: "docker-compose.yml", content: renderComposeFile(plan) },
    { path: ".env.example", content: renderEnvExample(plan) },
    { path: "RUN.md", content: renderRunMd(plan) },
  ];
  const initdb = renderInitDbSql(plan);
  if (initdb) files.push(initdb);
  return files;
}
