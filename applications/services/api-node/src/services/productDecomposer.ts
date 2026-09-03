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
import { checkSpecContentReady } from "./specContentGate.js";
import { PRE_FACTORY_STATUSES } from "./projectStatus.js";
import { getArchetype, archetypeForFactoryType, renderProjectReadme } from "./archetypeCatalog.js";
import type { ProductZipContents } from "../routes/specs.js";

export interface DecomposeParams {
  tenantId: string;
  createdBy: string;
  approverEmail?: string | null;
  zip: ProductZipContents;
  /** força specApproved em todos os projetos (default: do manifesto product.specApproved) */
  specApprovedOverride?: boolean;
  /**
   * RFC-0003 B1 (decomposição sem disparo — a alma do pivô). Default `false`:
   * a decomposição SALVA os N projetos como rascunhos na Bancada (status 'draft')
   * e o produto nasce 'draft' — a fábrica NÃO roda. A promoção (B2) é um ato
   * deliberado posterior. Quando `true`, preserva o atalho express legado:
   * projetos entram na fábrica (specApproved do manifesto), produto nasce 'running'
   * e a onda 0 (raízes) fica elegível para disparo pelo chamador.
   */
  dispatch?: boolean;
  /**
   * RFC-0003 B4: id da spec da Bancada que originou esta decomposição (POST
   * /api/projects/:id/decompose). Persistido em products.origin_project_id — dá o
   * vínculo de origem (evita produto órfão, gap U#4/C7). null quando a decomposição
   * vem de um ZIP/documento avulso (sem spec de origem).
   */
  originProjectId?: string | null;
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
  /**
   * §4.7 (migration 064): true quando a spec de origem NÃO foi consumida porque já havia
   * graduado (via /run concorrente) — o App vivo NÃO é desvinculado; a decomposição segue.
   */
  originAlreadyPromoted?: boolean;
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
  originProjectId?: string | null,
): Promise<DecomposeResult> {
  // §4.7 (migration 064): mesmo no no-op idempotente, consumir a spec de origem para o
  // produto existente (mesma guarda de status; se já graduou → não desvincula o App vivo).
  let originAlreadyPromoted = false;
  if (originProjectId) {
    const consumed = await pool.query(
      `UPDATE projects SET product_id = $1, status = 'archived', updated_at = now()
       WHERE id = $2 AND status = ANY($3::text[])`,
      [productId, originProjectId, [...PRE_FACTORY_STATUSES]],
    );
    if (consumed.rowCount === 0) originAlreadyPromoted = true;
  }
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
    triggersCreated: 0, dispatched: [], idempotentReuse: true, originAlreadyPromoted,
  };
}

export async function decomposeProduct(pool: Pool, params: DecomposeParams): Promise<DecomposeResult> {
  const { tenantId, createdBy, approverEmail, zip } = params;
  // B1: sem disparo por padrão — decompor SALVA rascunhos na Bancada, não roda a fábrica.
  const dispatch = params.dispatch === true;

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
    return buildReuseResult(pool, existing.rows[0].id as string, existing.rows[0].name as string, sketch, params.originProjectId ?? null);
  }

  // MED-4 (adversarial): a ingestão de produto criava N projetos SEM passar por nenhum
  // gate de conteúdo — um manifesto com specs ainda em branco (esqueleto/GUIA-TEMPLATE)
  // viraria N projetos que, ao rodar, terminariam em blocked_backlog_empty (incidente
  // Cabral). Validamos AQUI (após o no-op idempotente, antes de criar qualquer projeto),
  // custo ZERO de LLM. Specs reais geradas pelo Splitter passam; só o esqueleto não
  // preenchido é recusado, apontando o projeto ofensor. Colchete-prefixo real ("[Fase 1]
  // Cadastro") NÃO é falso-positivo — o gate exige o colchete ocupando o título/cláusula
  // inteira. Fica DEPOIS da idempotência para não transformar re-ingestão em 4xx.
  for (const p of sketch.projects) {
    const specContent = zip.files.get(p.spec.replace(/^\.\//, ""));
    const ready = checkSpecContentReady(specContent);
    if (!ready.ok) {
      throw new ManifestError(
        "MANIFEST_SPEC_PLACEHOLDER",
        `A spec do projeto "${p.id}" (${p.spec}) ainda é um rascunho/modelo em branco — ` +
          `preencha os requisitos reais antes de ingerir o produto. (${ready.block.signals.join(", ")})`,
        { project: p.id, spec: p.spec, signals: ready.block.signals },
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 2. cria o produto (com product_hash p/ idempotência futura)
    // #60: persiste o systemId canônico do manifesto (product.systemId), usado no
    // vínculo com o Deadpool. Ausente no manifesto → NULL (githubPush cai no slug do nome).
    const systemId = (sketch.product.systemId ?? "").trim() || null;
    // B4: vínculo de origem (spec da Bancada que gerou o produto). null quando avulso.
    const originProjectId = params.originProjectId ?? null;
    // RFC-0004 D6/D7: manifesto do PRODUTO (kind: product) — DETERMINÍSTICO, gravado em
    // products.manifest_md (migration 072). NÃO entra no product_hash (idempotência é
    // sobre o payload da proposta, nunca sobre artefatos gerados — auditoria finding 10).
    const productManifestMd = [
      "---",
      "kind: product",
      `projects: [${sketch.projects.map((p) => p.id).join(", ")}]`,
      "---",
      "",
      `# ${sketch.product.name}`,
      "",
      sketch.product.description ?? "",
      "",
      "## Projetos (ondas de dependência)",
      ...sketch.waves.map((w, i) => `- Onda ${i}: ${w.join(", ")}`),
      "",
    ].join("\n");
    const prodRes = await client.query(
      `INSERT INTO products (tenant_id, created_by, name, description, product_hash, system_id, origin_project_id, manifest_md)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name`,
      [tenantId, createdBy, sketch.product.name, sketch.product.description ?? null, productHash, systemId, originProjectId, productManifestMd],
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
      // RFC-0004 D7: árvore v1 DETERMINÍSTICA por projeto — 01-spec.md (corpo, arquivo
      // CANÔNICO/primary: primeiro da lista) + README.md (manifesto autoral gerado do
      // catálogo + campos opcionais do splitter; NUNCA carrega estado/hash). O gate de
      // conteúdo continua rodando sobre specContent (acima) — o README-template com
      // checklist não passa pelo gate (auditoria finding 7).
      const arch = getArchetype(p.archetype ?? "") ?? archetypeForFactoryType(p.type);
      const projectFiles: Array<{ filename: string; buffer: Buffer; mimeType: string }> = [
        { filename: "01-spec.md", buffer: Buffer.from(specContent, "utf-8"), mimeType: "text/markdown" },
      ];
      if (arch) {
        projectFiles.push({
          filename: "README.md",
          buffer: Buffer.from(renderProjectReadme({
            title: p.id,
            archetype: arch,
            stack: p.stack,
            dependsOn: p.dependsOn,
            deployTarget: p.deployTarget,
          }), "utf-8"),
          mimeType: "text/markdown",
        });
      }
      const created = await createProjectFromSpec(client, {
        tenantId,
        createdBy,
        approverEmail,
        title: p.id,
        files: projectFiles,
        productId,
        projectType: p.type,
        deliveryFields: deliveryFieldsFor(p.delivery ?? sketch.product.deliveryDefault),
        // B1: no modo Bancada (sem disparo) os projetos nascem 'draft' (isDraft) e NÃO
        // 'pending_conversion' — nada é elegível a auto-run até a promoção. No modo express
        // preserva-se o specApproved do manifesto (doorstep da fábrica).
        specApproved: dispatch ? specApproved : false,
        isDraft: !dispatch,
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

    // Lifecycle inicial do produto:
    //  • Bancada (B1, sem disparo): 'draft' — especificado, aguardando promoção.
    //  • Express (dispatch=true, A2): 'running' — a onda 0 dispara logo após o commit.
    await client.query(
      "UPDATE products SET lifecycle_status = $2, updated_at = now() WHERE id = $1",
      [productId, dispatch ? "running" : "draft"],
    );

    // §4.7 (migration 064): consumir a spec de ORIGEM — move-a para o novo produto e arquiva-a,
    // DENTRO da transação. Guarda de status: se a origem já graduou via /run concorrente (não é
    // mais pré-fábrica), rowCount=0 → NÃO desvincula o App vivo; sinaliza originAlreadyPromoted.
    let originAlreadyPromoted = false;
    if (params.originProjectId) {
      const consumed = await client.query(
        `UPDATE projects SET product_id = $1, status = 'archived', updated_at = now()
         WHERE id = $2 AND status = ANY($3::text[])`,
        [productId, params.originProjectId, [...PRE_FACTORY_STATUSES]],
      );
      if (consumed.rowCount === 0) originAlreadyPromoted = true;
    }

    await client.query("COMMIT");

    // 5. onda 0 (sem predecessores) fica elegível para disparo pelo chamador (rota),
    //    que aciona o runner /run — SÓ no modo express. Na Bancada, `dispatched` é
    //    vazio: nada roda até a promoção (B2). As ondas seguintes disparam pela cascata.
    const dispatched = dispatch ? sketch.waves[0].map((mid) => idMap.get(mid)!) : [];

    return {
      productId,
      productName: sketch.product.name,
      projects,
      waves: sketch.waves,
      triggersCreated,
      dispatched,
      originAlreadyPromoted,
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
        return buildReuseResult(pool, dup.rows[0].id as string, dup.rows[0].name as string, sketch, params.originProjectId ?? null);
      }
    }
    throw e;
  } finally {
    client.release();
  }
}
