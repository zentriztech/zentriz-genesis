/**
 * E2E manual do product_decomposer contra Postgres real (não roda no vitest —
 * exige DB). Uso: PGHOST=localhost ... npx tsx src/services/productDecomposer.e2e.mts
 * Cria um ZIP sintético (PRODUCT.json + 3 specs), decompõe, e verifica
 * produto + N projetos + triggers no banco. Limpa o que criou ao final.
 */
import AdmZip from "adm-zip";
import { pool } from "../db/client.js";
import { initDb } from "../db/init.js";
import { extractProductZip } from "../routes/specs.js";
import { decomposeProduct } from "./productDecomposer.js";

function buildZip(): Buffer {
  const zip = new AdmZip();
  const manifest = {
    schemaVersion: "1.1.0",
    product: { name: "E2E-TestProduct", systemId: "e2e", specApproved: true, deliveryDefault: "source_only" },
    projects: [
      { id: "contracts", spec: "specs/contracts.md", type: "lib_ts", dependsOn: [] },
      { id: "api", spec: "specs/api.md", type: "backend_api_nestjs", dependsOn: ["contracts"] },
      { id: "web", spec: "specs/web.md", type: "frontend_dashboard", dependsOn: ["contracts", "api"] },
    ],
  };
  zip.addFile("PRODUCT.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));
  zip.addFile("specs/contracts.md", Buffer.from("# Contracts\n\nFR-01: exporta tipos.\nDADO x QUANDO y ENTÃO z.", "utf-8"));
  zip.addFile("specs/api.md", Buffer.from("# API\n\nFR-01: expõe /health.\nDADO x QUANDO y ENTÃO z.", "utf-8"));
  zip.addFile("specs/web.md", Buffer.from("# Web\n\nFR-01: mostra dashboard.\nDADO x QUANDO y ENTÃO z.", "utf-8"));
  return zip.toBuffer();
}

async function main() {
  await initDb();
  // bootstrap mínimo com os NOT NULL corretos (plan → tenant → user)
  let tenantId = (await pool.query("SELECT id FROM tenants LIMIT 1")).rows[0]?.id;
  if (!tenantId) {
    const planId = (await pool.query(
      `INSERT INTO plans (id, name, slug, max_projects, max_users_per_tenant)
       VALUES ('e2e-plan', 'E2E', 'e2e-plan', 100, 100)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
    tenantId = (await pool.query(
      "INSERT INTO tenants (name, plan_id, status) VALUES ('e2e', $1, 'active') RETURNING id", [planId])).rows[0].id;
  }
  let userId = (await pool.query("SELECT id FROM users LIMIT 1")).rows[0]?.id;
  if (!userId) {
    userId = (await pool.query(
      `INSERT INTO users (email, name, role, status, tenant_id)
       VALUES ('e2e@zentriz.com.br', 'E2E', 'zentriz_admin', 'active', $1) RETURNING id`, [tenantId])).rows[0].id;
  }

  const contents = extractProductZip(buildZip());
  if (!contents) throw new Error("extractProductZip retornou null (manifesto não detectado)");
  console.log("✓ manifesto detectado; arquivos:", [...contents.files.keys()]);

  const result = await decomposeProduct(pool, {
    tenantId, createdBy: userId, approverEmail: "e2e@zentriz.com.br", zip: contents,
  });
  console.log("✓ produto criado:", result.productId, result.productName);
  console.log("✓ projetos:", result.projects.map((p) => `${p.manifestId}→${p.projectId.slice(0,8)} (onda ${p.wave}, ${p.status})`));
  console.log("✓ ondas:", JSON.stringify(result.waves));
  console.log("✓ triggers criados:", result.triggersCreated);
  console.log("✓ dispatched (onda 0):", result.dispatched.length);

  // Verificações
  const assert = (c: boolean, m: string) => { if (!c) throw new Error("FALHOU: " + m); console.log("  ✓ " + m); };
  assert(result.projects.length === 3, "3 projetos criados");
  assert(result.triggersCreated === 3, "3 triggers (api→contracts, web→contracts, web→api)");
  assert(result.waves.length === 3, "3 ondas (contracts / api / web)");
  assert(result.waves[0].includes("contracts"), "onda 0 = contracts");
  assert(result.dispatched.length === 1, "1 projeto na onda 0 dispatched");

  // Verifica no banco: projetos spec_submitted, product_id setado, spec_approved no extra
  const rows = (await pool.query(
    "SELECT id, status, product_id, extra->>'spec_approved' AS sa, extra->>'spec_hash' AS hash FROM projects WHERE product_id=$1 ORDER BY created_at",
    [result.productId])).rows;
  assert(rows.length === 3, "3 projetos no banco com product_id");
  assert(rows.every((r) => r.status === "spec_submitted"), "todos spec_submitted");
  assert(rows.every((r) => r.sa === "true"), "todos spec_approved=true");
  assert(rows.every((r) => r.hash && r.hash.length === 64), "todos com spec_hash SHA-256");

  const trig = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM project_triggers WHERE project_id = ANY($1)`,
    [result.projects.map((p) => p.projectId)])).rows[0].n;
  assert(trig === 3, "3 triggers no banco");

  // Teste de rejeição: ciclo
  const badZip = new AdmZip();
  badZip.addFile("PRODUCT.json", Buffer.from(JSON.stringify({
    schemaVersion: "1.1.0", product: { name: "Bad" },
    projects: [
      { id: "a", spec: "a.md", type: "lib_ts", dependsOn: ["b"] },
      { id: "b", spec: "b.md", type: "lib_ts", dependsOn: ["a"] },
    ],
  }), "utf-8"));
  badZip.addFile("a.md", Buffer.from("x")); badZip.addFile("b.md", Buffer.from("y"));
  const badContents = extractProductZip(badZip.toBuffer())!;
  let rejected = false;
  try { await decomposeProduct(pool, { tenantId, createdBy: userId, zip: badContents }); }
  catch (e: any) { rejected = e?.code === "MANIFEST_CYCLE" || /ciclo/i.test(e?.message ?? ""); }
  assert(rejected, "ciclo rejeitado (rollback, nada criado)");
  const badCount = (await pool.query("SELECT COUNT(*)::int AS n FROM products WHERE name='Bad'")).rows[0].n;
  assert(badCount === 0, "produto 'Bad' NÃO foi criado (rollback ok)");

  // Limpeza
  await pool.query("DELETE FROM projects WHERE product_id=$1", [result.productId]);
  await pool.query("DELETE FROM products WHERE id=$1", [result.productId]);
  console.log("\n✅ E2E do decomposer PASSOU — limpeza feita.");
  await pool.end();
}

main().catch((e) => { console.error("\n❌ E2E FALHOU:", e); process.exit(1); });
