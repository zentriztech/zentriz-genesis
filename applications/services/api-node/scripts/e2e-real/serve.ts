/**
 * Servidor do E2E REAL dos cards (revisão adversarial Y-15, frente L2): sobe o api-node A PARTIR DO CÓDIGO DESTE WORKTREE
 * (`buildApp()` com auth, rotas e SQL reais) contra um Postgres efêmero JÁ MIGRADO e um agente de LLM STUB. Nada de produção.
 *
 *   docker run --rm -d --name l2-pg -e POSTGRES_PASSWORD=test -p 55441:5432 pgvector/pgvector:pg16
 *   DATABASE_URL=postgres://postgres:test@localhost:55441/postgres npx tsx scripts/apply-migrations-test.ts
 *   DATABASE_URL=… npx tsx scripts/e2e-real/serve.ts        (ou, pelo portal: npx playwright test -c playwright.real.config.ts)
 *
 * Portas: API 3461 (rotas reais) · controle 3462 (`/seed`, `/add-v2`) · agente stub 3463. Autenticação de teste: o token JWT é cunhado
 * com o MESMO `signToken` do servidor (o middleware de auth REAL o valida) para um tenant_admin semeado; a flag CARDS_BANCADA é ligada
 * no tenant. O stub devolve um plano de RFC válido ao planner e uma revisão ao chat de arquivo.
 */
import http from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DB = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1):(55432|55440|55441)\//.test(DB)) { console.error("Recusado: DATABASE_URL deve apontar para o Postgres efêmero em localhost:55432/55440/55441"); process.exit(2); }

const API_PORT = Number(process.env.E2E_API_PORT ?? 3461);
const CTL_PORT = Number(process.env.E2E_CTL_PORT ?? 3462);
const AGENT_PORT = Number(process.env.E2E_AGENT_PORT ?? 3463);
const UPLOADS = mkdtempSync(join(tmpdir(), "l2-real-uploads-"));
mkdirSync(UPLOADS, { recursive: true });
process.env.UPLOAD_DIR = UPLOADS;
process.env.PROJECT_FILES_ROOT = "";
process.env.API_AGENTS_URL = `http://127.0.0.1:${AGENT_PORT}`;

const rfc = (n: number) => `# x

## Sumário
Permitir exportar a lista de entregas em CSV a partir da tela de entregas.

## Non-goals
Não altera o cálculo de prazos nem a tela de mapa.

## Requisitos
- REQ-01 — O sistema DEVE gerar um CSV com as entregas do filtro atual.

## Critérios de aceite
### Cenário: exportar entregas
- **Dado** um usuário autenticado com entregas
- **Quando** clica em "Exportar CSV"
- **Então** recebe um arquivo CSV com todas as entregas

## Compatibilidade
- Tipo (SemVer): MINOR
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
  - "apps/api/src/deliveries/**"
  - "tests/**"
\`\`\`
`.replace("# x", `# RFC-${String(n).padStart(4, "0")} — Exportar entregas em CSV`);

// ── agente de LLM STUB ─────────────────────────────────────────────────────────────────────────
const agent = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (!req.url?.startsWith("/invoke/raw")) { res.statusCode = 404; res.end("{}"); return; }
    const body = JSON.parse(raw || "{}") as { user_message?: string };
    const msg = String(body.user_message ?? "");
    if (msg.includes("PEDIDO DE EVOLUÇÃO (humano)")) {
      const plan = {
        summary: "Exportar entregas em CSV", compat: "minor", questions: [],
        rfcs: [{ slug: "exportar-csv", title: "Exportar entregas em CSV", content: rfc(1).replace(/^# [^\n]*\n/, "# x\n") }],
        adrs: [], changelog: { added: [], changed: [], deprecated: [], removed: [], fixed: [], security: [] }, connect_yaml: "",
      };
      res.end(JSON.stringify({ response: JSON.stringify(plan), model_used: "stub" }));
    } else {
      res.end(JSON.stringify({ response: rfc(1).replace("O sistema DEVE gerar", "O sistema DEVE gerar, com ponto e vírgula,"), model_used: "stub" }));
    }
  });
});

const { pool } = await import("../../src/db/client.js");
const { signToken } = await import("../../src/auth.js");
const { buildApp } = await import("../../src/app.js");

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
const sha = (b: string) => createHash("sha256").update(b).digest("hex");

/** Mesmo semeado de `seedAcceptedProduct` (src/testing/evolvePg.ts, que importa o vitest e não roda fora dele): tenant, admin, produto aceito, pai aceito, spec em disco. */
async function seed() {
  const id = randomUUID().slice(0, 8);
  const tenantId = (await pool.query(`INSERT INTO tenants (name, plan_id) VALUES ('t-'||$1, 'plan_prata') RETURNING id`, [id])).rows[0].id as string;
  const email = `u-${id}@x.test`;
  const userId = (await pool.query(`INSERT INTO users (email, name, role, tenant_id) VALUES ($1, 'u', 'tenant_admin', $2) RETURNING id`, [email, tenantId])).rows[0].id as string;
  const productId = (await pool.query(`INSERT INTO products (tenant_id, created_by, name, lifecycle_status) VALUES ($1,$2,$3,'accepted') RETURNING id`, [tenantId, userId, `prod-${id}`])).rows[0].id as string;
  const parentId = (await pool.query(
    `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, budget_usd) VALUES ($1,$2,$3,'accepted',$4,1,50) RETURNING id`,
    [tenantId, userId, `App ${id}`, productId])).rows[0].id as string;
  const addFile = async (relDir: string, filename: string, content: string, primary: boolean) => {
    const dir = relDir ? join(UPLOADS, parentId, relDir) : join(UPLOADS, parentId);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, filename);
    writeFileSync(fp, content);
    await pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256) VALUES ($1,$2,$3,'text/markdown',$4,$5,$6)`,
      [parentId, filename, fp, relDir, primary, sha(content)]);
  };
  await addFile("", "spec.md", "# Spec do pai\n\nO app lista entregas. Prazo de 48h.\n", true);
  await addFile("docs", "regras.md", "# Regras\n\nPrazo de 48h para entregas urgentes.\n", false);
  await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [tenantId]);
  // LEI do slot do tenant: sem slot utilizável o servidor recusa chamar LLM. Slot de teste (chave fictícia; o agente é o stub local).
  await pool.query(`INSERT INTO tenant_llm_configs (tenant_id, priority, provider, model_id, credentials) VALUES ($1, 0, 'anthropic', 'stub-model', $2)`,
    [tenantId, JSON.stringify({ api_key: "stub-key-e2e-nao-e-segredo" })]);
  const token = signToken({ sub: userId, email, role: "tenant_admin", tenantId });
  return { tenantId, userId, productId, parentId, email, token };
}

const ctl = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/seed") { res.end(JSON.stringify(await seed())); return; }
    if (url.pathname === "/add-v2") {
      // o produto avança de versão (nova versão aceita) para provar a base vencida
      const parentId = url.searchParams.get("parent")!;
      const p = (await pool.query("SELECT tenant_id, created_by, product_id FROM projects WHERE id = $1", [parentId])).rows[0];
      const r = await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id)
         VALUES ($1,$2,'App v2','accepted',$3,$4,2,$4) RETURNING id`, [p.tenant_id, p.created_by, p.product_id, parentId]);
      const id = r.rows[0].id as string;
      mkdirSync(join(UPLOADS, id), { recursive: true });
      const content = "# Spec v2\n\nPrazo de 24h agora.\n";
      const fp = join(UPLOADS, id, "spec.md");
      writeFileSync(fp, content);
      await pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256) VALUES ($1,'spec.md',$2,'text/markdown','',true,$3)`,
        [id, fp, sha(content)]);
      res.end(JSON.stringify({ id })); return;
    }
    res.statusCode = 404; res.end("{}");
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
});

const app = await buildApp();
await new Promise<void>((r) => agent.listen(AGENT_PORT, "127.0.0.1", r));
await new Promise<void>((r) => ctl.listen(CTL_PORT, "127.0.0.1", r));
await app.listen({ port: API_PORT, host: "127.0.0.1" });
console.log(`[e2e-real] api ${API_PORT} · controle ${CTL_PORT} · agente stub ${AGENT_PORT} · uploads ${UPLOADS}`);
const stop = async () => { await app.close(); agent.close(); ctl.close(); await pool.end(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
