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
import { buildProductSketch, parseManifest, ManifestError, type ProductSketch } from "./productManifest.js";
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
}

/** Deriva deliveryFields a partir do delivery do projeto/manifesto. */
function deliveryFieldsFor(delivery: string | undefined): Record<string, string> {
  if (!delivery) return {};
  // backend usa delivery_mode; mobile/eas será tratado no Cenário B (deliveryChannel).
  return { deliveryMode: delivery };
}

export async function decomposeProduct(pool: Pool, params: DecomposeParams): Promise<DecomposeResult> {
  const { tenantId, createdBy, approverEmail, zip } = params;

  // 1. parse + validação determinística (fora da transação — não toca o banco)
  const manifest = parseManifest(zip.manifestText);
  const presentFiles = [...zip.files.keys()];
  const sketch: ProductSketch = buildProductSketch(manifest, presentFiles);
  const specApproved = params.specApprovedOverride ?? !!manifest.product.specApproved;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 2. cria o produto
    const prodRes = await client.query(
      `INSERT INTO products (tenant_id, created_by, name, description)
       VALUES ($1, $2, $3, $4) RETURNING id, name`,
      [tenantId, createdBy, sketch.product.name, sketch.product.description ?? null],
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
    throw e;
  } finally {
    client.release();
  }
}
