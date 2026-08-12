/**
 * productDecomposer.ts — orquestra a ingestão de um PRODUTO (ADR-018 / Cenário A):
 * manifesto validado → produto + N projetos + arestas do grafo (project_triggers) → dispara onda 0.
 *
 * Reusa os "trilhos" existentes: tabela products, project_triggers, ordenação
 * topológica (aqui já pré-computada em ondas pelo productManifest) e a cascata de
 * accept (projects.ts) que dispara as ondas seguintes. NÃO chama a rota HTTP
 * /api/specs em loop — usa a função pura createProjectFromSpec (correção A4).
 *
 * Determinístico e transacional: valida TUDO (DAG, specs, tipos) antes de criar
 * qualquer projeto; em erro, faz ROLLBACK (nada meia-criado).
 */
import type { Pool } from "pg";
import { buildProductSketch, parseManifest, computeProductHash, ManifestError, type ProductSketch } from "./productManifest.js";
import { createProjectFromSpec } from "./projectCreation.js";
import type { ProductZipContents } from "../routes/specs.js";

export interface DecomposeParams {
  tenantId: string;
  createdBy: string;
  approverEmail?: string | null;
  zip: ProductZipContents;
  /** força specApproved em todos os projetos (default: do manifesto product.specApproved) */
  specApprovedOverride?: boolean;
}

export interface DecomposeResult {
  productId: string;
  productName: string;
  projects: Array<{ manifestId: string; projectId: string; wave: number; type: string; status: string }>;
  waves: string[][];
  triggersCreated: number;
  dispatched: string[]; // projectIds da onda 0 marcados para /run
  /** true quando a ingestão foi no-op idempotente (produto com mesmo hash já existia). */
  idempotentReuse?: boolean;
}

/** Deriva deliveryFields a partir do delivery do projeto/manifesto. */
function deliveryFieldsFor(delivery: string | undefined): Record<string, string> {
  if (!delivery) return {};
  // backend usa delivery_mode; mobile/eas será tratado no Cenário B (deliveryChannel).
  return { deliveryMode: delivery };
}

/**
 * Monta um DecomposeResult para um produto JÁ existente (no-op idempotente).
 * Lê os projetos atuais do produto; não dispara nada (dispatched vazio).
 */
async function buildReuseResult(
  pool: Pool, productId: string, productName: string, sketch: ProductSketch,
): Promise<DecomposeResult> {
  const rows = (await pool.query(
    "SELECT id, title, status FROM projects WHERE product_id = $1",
    [productId],
  )).rows as Array<{ id: string; title: string; status: string }>;
  const byTitle = new Map(rows.map((r) => [r.title, r]));
  const projects = sketch.projects.map((p) => {
    const r = byTitle.get(p.id);
    return {
      manifestId: p.id,
      projectId: r?.id ?? "",
      wave: p.wave,
      type: p.type,
      status: r?.status ?? "unknown",
    };
  });
  return {
    productId, productName, projects, waves: sketch.waves,
    triggersCreated: 0, dispatched: [], idempotentReuse: true,
  };
}

export async function decomposeProduct(pool: Pool, params: DecomposeParams): Promise<DecomposeResult> {
  const { tenantId, createdBy, approverEmail, zip } = params;

  // 1. parse + validação determinística (fora da transação — não toca o banco)
  const manifest = parseManifest(zip.manifestText);
  const presentFiles = [...zip.files.keys()];
  const sketch: ProductSketch = buildProductSketch(manifest, presentFiles);
  const specApproved = params.specApprovedOverride ?? !!manifest.product.specApproved;
  const productHash = computeProductHash(zip.manifestText, zip.files);

  // 1b. idempotência (ADR-018 DoD): se este tenant já ingeriu ESTE produto (hash idêntico),
  //     não recria nada — devolve o produto existente como no-op. Reingestão é segura.
  const existing = await pool.query(
    "SELECT id, name FROM products WHERE tenant_id = $1 AND product_hash = $2 LIMIT 1",
    [tenantId, productHash],
  );
  if (existing.rows[0]) {
    return buildReuseResult(pool, existing.rows[0].id as string, existing.rows[0].name as string, sketch);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 2. cria o produto (com product_hash p/ idempotência futura)
    // #60: persiste o systemId canônico do manifesto (product.systemId), usado no
    // vínculo com o Deadpool. Ausente no manifesto → NULL (githubPush cai no slug do nome).
    const systemId = (sketch.product.systemId ?? "").trim() || null;
    const prodRes = await client.query(
      `INSERT INTO products (tenant_id, created_by, name, description, product_hash, system_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name`,
      [tenantId, createdBy, sketch.product.name, sketch.product.description ?? null, productHash, systemId],
    );
    const productId = prodRes.rows[0].id as string;

    // 3. cria cada projeto (ordem de onda) via função pura; grava mapa manifestId→projectId
    const idMap = new Map<string, string>();
    const projects: DecomposeResult["projects"] = [];
    for (const p of sketch.projects) {
      const specContent = zip.files.get(p.spec.replace(/^\.\//, ""));
      if (specContent === undefined) {
        // já validado em buildProductSketch, mas defensivo
        throw new ManifestError("MANIFEST_SPEC_MISSING", `spec "${p.spec}" ausente ao criar projeto "${p.id}".`);
      }
      const created = await createProjectFromSpec(client, {
        tenantId,
        createdBy,
        approverEmail,
        title: p.id,
        files: [{ filename: `${p.id}.md`, buffer: Buffer.from(specContent, "utf-8"), mimeType: "text/markdown" }],
        productId,
        projectType: p.type,
        deliveryFields: deliveryFieldsFor(p.delivery ?? sketch.product.deliveryDefault),
        specApproved,
      });
      idMap.set(p.id, created.projectId);
      projects.push({ manifestId: p.id, projectId: created.projectId, wave: p.wave, type: p.type, status: created.status });
    }

    // 4. cria as arestas do grafo (project_triggers) — só depois de todos existirem
    let triggersCreated = 0;
    for (const p of sketch.projects) {
      const projectId = idMap.get(p.id)!;
      for (const dep of p.dependsOn) {
        const triggerProjectId = idMap.get(dep)!;
        await client.query(
          `INSERT INTO project_triggers (project_id, trigger_project_id, trigger_status)
           VALUES ($1, $2, 'accepted')
           ON CONFLICT (project_id, trigger_project_id) DO UPDATE SET trigger_status='accepted'`,
          [projectId, triggerProjectId],
        );
        triggersCreated++;
      }
    }

    // A2: produto sai de 'ingesting' → 'running' assim que os projetos existem
    // (a onda 0 será disparada logo após o commit pela rota de ingestão).
    await client.query(
      "UPDATE products SET lifecycle_status = 'running', updated_at = now() WHERE id = $1",
      [productId],
    );

    await client.query("COMMIT");

    // 5. onda 0 (sem predecessores) fica elegível para disparo pelo chamador (rota),
    //    que aciona o runner /run. As ondas seguintes disparam pela cascata de accept.
    const dispatched = sketch.waves[0].map((mid) => idMap.get(mid)!);

    return {
      productId,
      productName: sketch.product.name,
      projects,
      waves: sketch.waves,
      triggersCreated,
      dispatched,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // Corrida: dois ingests idênticos simultâneos — o pre-check não viu, mas o índice
    // único (tenant_id, product_hash) barrou. Trata como no-op idempotente.
    if ((e as { code?: string })?.code === "23505") {
      const dup = await pool.query(
        "SELECT id, name FROM products WHERE tenant_id = $1 AND product_hash = $2 LIMIT 1",
        [tenantId, productHash],
      );
      if (dup.rows[0]) {
        return buildReuseResult(pool, dup.rows[0].id as string, dup.rows[0].name as string, sketch);
      }
    }
    throw e;
  } finally {
    client.release();
  }
}
