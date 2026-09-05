/**
 * productContext.ts — Fase 1 do "a LLM tem que conhecer o PRODUTO inteiro".
 *
 * REQUISITO (Jean, 2026-09-05): num Produto de Spec com vários projetos e arquivos, o CTO precisa
 * conhecer TUDO para evoluir de forma coesa. O mecanismo anterior (`specChat.ts::loadChatContext`)
 * olhava só os arquivos IRMÃOS DO MESMO PROJETO — e, medido em prod, 58 de 58 projetos têm
 * exatamente 1 arquivo, enquanto 50 deles têm irmãos no mesmo PRODUTO. Ou seja: o bloco de irmãos
 * era código morto e o eixo que importa (o produto) não era olhado.
 *
 * PRINCÍPIO: **índice sempre, corpo por necessidade.**
 *  • Mapa do Produto (P1) — determinístico, O(projetos), ~120 chars por projeto: quem existe, de que
 *    tipo, de quem depende, tamanho da spec e as seções (H2). Cabe sempre no prompt (28 projetos ≈
 *    6–10 KB). Um despejo integral seria impossível: OrienteMe (9 projetos) = 207 KB e um produto
 *    realista de 28×40 KB = ~1,1 MB.
 *  • Corpo dos irmãos (P2) — por RELEVÂNCIA, sem round-trip (decisão D2): `connect.yaml` dos
 *    dependentes diretos → specs citadas nos GAPs ATIVOS → specs citadas pelo humano → o resto fica
 *    só no índice.
 *
 * FAIL-CLOSED DE TENANT (GAP-2, mesma classe do vazamento cross-tenant de `/api/deadpool/*`):
 * passar a consultar por `product_id` amplia a superfície, então o escopo do irmão é derivado da
 * linha do projeto ÂNCORA — nunca de um parâmetro do cliente. Sem tenant resolvido, os irmãos são
 * restritos a `tenant_id IS NULL` + o MESMO `created_by`. Nenhuma consulta aqui aceita tenant de
 * fora; o pior caso é mapa vazio, nunca mapa do vizinho.
 *
 * LINHAGEM (GAP-4): `status <> 'archived'` e `extra->>'superseded_by'` vazio — senão v1/v2/v3 do
 * mesmo projeto aparecem como três irmãos e o modelo "harmoniza" contra uma versão morta.
 *
 * DEPENDÊNCIAS (correção de premissa, medida em prod 2026-09-05): o desenho falava em
 * `PRODUCT.json.dependsOn`, mas o manifesto NÃO é persistido por projeto. O `dependsOn` do
 * decompose é gravado como aresta em **`project_triggers`** (`productDecomposer.ts:281-287`) —
 * 11 arestas em prod, todas do produto ZVoices. `project_links` existe e está **VAZIA** (0 linhas),
 * então não serve de fonte. Quem não tem aresta cai na degradação graciosa do GAP-5 (mapa só com o
 * banco; prioridade de corpo cai para "citado nos findings / na mensagem").
 *
 * Flag: `SPEC_CONTEXT_PRODUCT_SCOPE=off` por default (GAP-9) — com ela desligada este módulo não é
 * chamado e o contexto do chat é byte-idêntico ao de antes.
 */
import { readFile } from "node:fs/promises";
import type { ValidationFinding } from "./specValidation.js";

/** Contrato mínimo de banco (aceita `pool` e um duplo de teste). */
export interface Queryable {
  query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** Nasce OFF (rollback sem redeploy — mesma disciplina de `SPEC_VALIDATION_GATE`). */
export function productScopeEnabled(): boolean {
  return (process.env.SPEC_CONTEXT_PRODUCT_SCOPE ?? "off").trim().toLowerCase() === "on";
}

/** Teto de projetos no mapa. Venuxx V2 (o maior produto real) tem 28. */
const MAX_MAP_PROJECTS = 60;
/** Seções (H2) por projeto no índice — o suficiente para o modelo saber o que o irmão cobre. */
const MAX_SECTIONS_PER_PROJECT = 8;
/**
 * Teto de TRANSPORTE do corpo dos irmãos (P3). Não é o teto do modelo: quem dimensiona por
 * `max_output` é o `_prompt_budget` do runtime (que agora recorta `sibling_files_context`,
 * `product_map` e `validation_report` como campos próprios). Aqui só evitamos payload absurdo
 * no HTTP api→agents. Piso = os 14.000 de hoje, para nada regredir.
 */
const SIBLINGS_TRANSPORT_BUDGET = 120_000;
/**
 * Marcador de corte **sem reticências**, espelhando `_PROMPT_CLIP_NOTICE` do runtime: a marca antiga
 * da api (`…(truncado)…`) pode ser lida por `envelope.py::validate_response_quality` como
 * truncamento se o modelo a copiar para um artefato → repair de ~19 min pago por nada.
 */
function clipNotice(shown: number, total: number): string {
  return `\n\n[CORTE DE CONTEXTO] Arquivo cortado aqui: ${shown} de ${total} caracteres exibidos ` +
    `(${total - shown} omitidos). Ele está INCOMPLETO. NÃO reescreva o que você não viu e NÃO copie esta marca.`;
}

export interface ProductSpecFile {
  filename: string;
  relDir: string;
  filePath: string;
  /** `null` = arquivo referenciado no banco e ILEGÍVEL no disco (GAP-11: reportar, não omitir). */
  content: string | null;
}

export interface ProductProject {
  projectId: string;
  title: string;
  projectType: string | null;
  status: string;
  /** Títulos dos irmãos de que este projeto depende (arestas de `project_triggers`). */
  dependsOn: string[];
  isAnchor: boolean;
  files: ProductSpecFile[];
  /** H2 do maior arquivo legível — "o que este projeto cobre". */
  sections: string[];
  /** Soma dos bytes legíveis; `null` quando nenhum arquivo pôde ser lido. */
  bytes: number | null;
}

export interface ProductMap {
  productId: string | null;
  productName: string | null;
  anchorTitle: string;
  projects: ProductProject[];
  /** Bloco pronto para o prompt. `""` quando o produto tem 1 projeto vigente (GAP-12: custo zero). */
  block: string;
  /** Furos visíveis (arquivo ilegível, produto ausente, teto de projetos) — GAP-10/GAP-11. */
  warnings: string[];
}

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

/** H2 do markdown (`## Título`) — barato e determinístico; ignora `###` e cercas de código. */
export function extractSections(content: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1].replace(/\s+/g, " ").slice(0, 60));
    if (out.length >= MAX_SECTIONS_PER_PROJECT) break;
  }
  return out;
}

function isConnectDeclaration(f: ProductSpecFile): boolean {
  return /^connect\.(ya?ml)$/i.test(f.filename);
}

/**
 * Mapa do Produto (P1). Devolve `null` quando o projeto âncora não existe ou não tem produto —
 * nesses casos o chamador segue com o comportamento antigo (irmãos do próprio projeto).
 *
 * Uma leitura de disco por arquivo do produto: medido em prod, 58 arquivos = 631 KB de I/O local,
 * irrelevante. O conteúdo lido é REUSADO pelo `selectSiblingBodies` (não lemos duas vezes).
 */
export async function buildProductMap(db: Queryable, anchorProjectId: string): Promise<ProductMap | null> {
  const anchor = (await db.query(
    `SELECT p.id, p.title, p.status, p.product_id, p.tenant_id, p.created_by,
            pr.name AS product_name
       FROM projects p LEFT JOIN products pr ON pr.id = p.product_id
      WHERE p.id = $1`,
    [anchorProjectId],
  )).rows[0] as {
    id?: string; title?: string; product_id?: string | null;
    tenant_id?: string | null; created_by?: string | null; product_name?: string | null;
  } | undefined;
  if (!anchor?.id) return null;

  const warnings: string[] = [];
  const productId = anchor.product_id ?? null;
  const anchorTitle = anchor.title ?? "(sem título)";
  if (!productId) {
    // Projeto solto (sem produto): não há irmãos por definição — nada a mapear.
    return { productId: null, productName: null, anchorTitle, projects: [], block: "", warnings };
  }

  // FAIL-CLOSED: o escopo sai da linha do ÂNCORA. Com tenant, `tenant_id = <do âncora>`; sem tenant,
  // `tenant_id IS NULL` **e** mesmo `created_by` (um projeto órfão não pode arrastar o de outro dono).
  const scoped = anchor.tenant_id
    ? { clause: "p.tenant_id = $2", params: [productId, anchor.tenant_id] }
    : { clause: "p.tenant_id IS NULL AND p.created_by = $2", params: [productId, anchor.created_by ?? null] };

  const rows = (await db.query(
    `SELECT p.id, p.title, p.status, p.extra->>'project_type' AS project_type
       FROM projects p
      WHERE p.product_id = $1
        AND ${scoped.clause}
        AND p.status <> 'archived'
        AND COALESCE(p.extra->>'superseded_by', '') = ''
      ORDER BY p.title
      LIMIT ${MAX_MAP_PROJECTS + 1}`,
    scoped.params,
  )).rows as Array<{ id: string; title: string; status: string; project_type: string | null }>;

  if (rows.length > MAX_MAP_PROJECTS) {
    warnings.push(`produto com mais de ${MAX_MAP_PROJECTS} projetos vigentes — mapa truncado`);
    rows.length = MAX_MAP_PROJECTS;
  }
  // O âncora TEM de estar na lista (se não está, o escopo divergiu: não monta mapa em vez de mentir).
  if (!rows.some((r) => r.id === anchorProjectId)) {
    warnings.push("projeto âncora fora do escopo do produto — mapa não montado");
    return { productId, productName: anchor.product_name ?? null, anchorTitle, projects: [], block: "", warnings };
  }

  const ids = rows.map((r) => r.id);
  const titleById = new Map(rows.map((r) => [r.id, r.title]));

  // Arestas de dependência: `project_triggers` (project depende de trigger_project). Restritas aos
  // projetos JÁ filtrados por tenant/produto/linhagem — nenhuma aresta traz projeto de fora.
  const deps = new Map<string, string[]>();
  if (ids.length > 1) {
    const edges = (await db.query(
      `SELECT project_id, trigger_project_id FROM project_triggers
        WHERE project_id = ANY($1::uuid[]) AND trigger_project_id = ANY($1::uuid[])`,
      [ids],
    )).rows as Array<{ project_id: string; trigger_project_id: string }>;
    for (const e of edges) {
      const t = titleById.get(e.trigger_project_id);
      if (!t) continue;
      const list = deps.get(e.project_id) ?? [];
      list.push(t);
      deps.set(e.project_id, list);
    }
  }

  // Arquivos de spec de TODOS os projetos do escopo, em uma consulta.
  const fileRows = (await db.query(
    `SELECT project_id, filename, COALESCE(rel_dir,'') AS rel_dir, file_path
       FROM project_spec_files
      WHERE project_id = ANY($1::uuid[])
      ORDER BY project_id, is_primary DESC NULLS LAST, filename`,
    [ids],
  )).rows as Array<{ project_id: string; filename: string; rel_dir: string; file_path: string }>;

  const filesByProject = new Map<string, ProductSpecFile[]>();
  for (const fr of fileRows) {
    // Best-effort: arquivo ilegível entra com `content: null` e VIRA AVISO (GAP-11) — omitir a linha
    // faria o índice mentir, que é o defeito D em outra roupa.
    const content = await readFile(fr.file_path, "utf-8").catch(() => null);
    if (content === null) {
      warnings.push(`spec ILEGÍVEL no disco: ${titleById.get(fr.project_id) ?? fr.project_id}/${fr.filename}`);
    }
    const list = filesByProject.get(fr.project_id) ?? [];
    list.push({ filename: fr.filename, relDir: fr.rel_dir, filePath: fr.file_path, content });
    filesByProject.set(fr.project_id, list);
  }

  const projects: ProductProject[] = rows.map((r) => {
    const files = filesByProject.get(r.id) ?? [];
    const readable = files.filter((f) => f.content !== null);
    // As seções descrevem O QUE O PROJETO COBRE, então saem do maior arquivo NARRATIVO. Medir no
    // `connect.yaml` devolvia `[]` (YAML não tem `##`) e o índice mentia com "—" mesmo havendo spec
    // com seções — e o `connect.yaml` costuma ser maior que uma spec semeada pelo backfill.
    const narrative = readable.filter((f) => !isConnectDeclaration(f));
    const biggest = (narrative.length ? narrative : readable)
      .slice().sort((a, b) => (b.content!.length - a.content!.length))[0];
    return {
      projectId: r.id,
      title: r.title,
      projectType: r.project_type,
      status: r.status,
      dependsOn: deps.get(r.id) ?? [],
      isAnchor: r.id === anchorProjectId,
      files,
      sections: biggest ? extractSections(biggest.content!) : [],
      bytes: readable.length ? readable.reduce((acc, f) => acc + f.content!.length, 0) : null,
    };
  });

  // GAP-12: produto de 1 projeto vigente (8 de 13 em prod) não paga NADA por este recurso.
  const block = projects.length > 1 ? renderProductMap(anchor.product_name ?? "(produto sem nome)", projects) : "";
  return { productId, productName: anchor.product_name ?? null, anchorTitle, projects, block, warnings };
}

/** Tabela markdown do mapa. `←` marca o projeto que está sendo editado. */
export function renderProductMap(productName: string, projects: ProductProject[]): string {
  const head = [
    `## MAPA DO PRODUTO — ${productName} (${projects.length} projetos vigentes)`,
    `Você está editando: **${projects.find((p) => p.isAnchor)?.title ?? "?"}** (marcado com ←).`,
    "Este mapa é SÓ LEITURA e existe para você manter os contratos entre projetos irmãos coerentes.",
    "",
    "| projeto | tipo | depende de | spec | situação | seções |",
    "|---|---|---|---|---|---|",
  ];
  const body = projects.map((p) => {
    const spec = p.bytes === null
      ? (p.files.length ? "**spec ILEGÍVEL**" : "sem spec")
      : `${fmtBytes(p.bytes)} (${p.files.length} arq.)`;
    const deps = p.dependsOn.length ? p.dependsOn.join(", ") : "—";
    const secs = p.sections.length ? p.sections.join(" · ") : "—";
    return `| ${p.title}${p.isAnchor ? " ←" : ""} | ${p.projectType ?? "—"} | ${deps} | ${spec} | ${p.status} | ${secs} |`;
  });
  return [...head, ...body].join("\n");
}

/**
 * Corpo dos irmãos por relevância (P2). Ordem de gasto do orçamento:
 *   1. `connect.yaml` dos irmãos ligados ao âncora por aresta (qualquer direção) — é o CONTRATO,
 *      é pequeno e é onde a divergência acontece. **Inteiro ou fora** (GAP-7: YAML pela metade é
 *      contrato ilegível, pior que ausente).
 *   2. Specs de irmãos citados nos GAPs ATIVOS da última validação.
 *   3. Specs de irmãos citados na mensagem do humano.
 * O que não couber fica só no índice — e isso é dito explicitamente no bloco.
 */
export function selectSiblingBodies(
  map: ProductMap,
  opts: { findings?: ValidationFinding[]; userMessage?: string; budget?: number } = {},
): { block: string; included: string[]; omitted: string[] } {
  const budget = Math.max(14_000, opts.budget ?? SIBLINGS_TRANSPORT_BUDGET);
  const anchor = map.projects.find((p) => p.isAnchor);
  const siblings = map.projects.filter((p) => !p.isAnchor);
  if (!anchor || siblings.length === 0) return { block: "", included: [], omitted: [] };

  const anchorDeps = new Set(anchor.dependsOn);
  const dependents = new Set(map.projects.filter((p) => p.dependsOn.includes(anchor.title)).map((p) => p.title));
  const linked = (p: ProductProject) => anchorDeps.has(p.title) || dependents.has(p.title);

  const findingsText = (opts.findings ?? [])
    .map((f) => `${f.file ?? ""} ${f.title ?? ""} ${f.rationale ?? ""}`)
    .join(" ")
    .toLowerCase();
  const msg = (opts.userMessage ?? "").toLowerCase();
  // Título curto (<3 chars) não é âncora de busca confiável — ignorado para não casar em tudo.
  const cited = (p: ProductProject, hay: string) => p.title.length >= 3 && hay.includes(p.title.toLowerCase());

  // Prioridade: 1 = connect.yaml de irmão ligado · 2 = citado nos findings · 3 = citado na mensagem.
  const queue: Array<{ p: ProductProject; f: ProductSpecFile; prio: number; whole: boolean }> = [];
  for (const p of siblings) {
    for (const f of p.files) {
      if (f.content === null) continue;
      if (isConnectDeclaration(f) && linked(p)) { queue.push({ p, f, prio: 1, whole: true }); continue; }
      if (cited(p, findingsText)) { queue.push({ p, f, prio: 2, whole: false }); continue; }
      if (cited(p, msg)) { queue.push({ p, f, prio: 3, whole: false }); continue; }
    }
  }
  queue.sort((a, b) => a.prio - b.prio || a.f.content!.length - b.f.content!.length);

  const parts: string[] = [];
  const included: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const item of queue) {
    const label = `${item.p.title}/${item.f.relDir ? `${item.f.relDir}/` : ""}${item.f.filename}`;
    const body = item.f.content!;
    const remaining = budget - used;
    if (remaining <= 500 || (item.whole && body.length > remaining)) {
      // Whole-file-or-nothing: `connect.yaml` cortado não entra (GAP-7).
      omitted.push(label);
      continue;
    }
    const clipped = body.length > remaining ? body.slice(0, remaining) + clipNotice(remaining, body.length) : body;
    parts.push(`\n### ARQUIVO IRMÃO: ${label} (projeto \`${item.p.title}\`)\n${clipped}`);
    included.push(label);
    used += Math.min(body.length, remaining);
  }
  // Quem ficou só no índice é dito por nome — o modelo precisa saber que existe e que não viu o corpo.
  const onlyIndex = siblings
    .filter((p) => !included.some((l) => l.startsWith(`${p.title}/`)))
    .map((p) => p.title);
  if (!parts.length && !onlyIndex.length) return { block: "", included, omitted };

  const header = [
    "Os arquivos abaixo pertencem a PROJETOS IRMÃOS do mesmo produto. São **SOMENTE LEITURA**:",
    "NÃO os reescreva, NÃO copie o conteúdo deles para o documento que você está editando.",
    "Se encontrar divergência de contrato com um irmão, RELATE no summary como GAP — não a 'corrija' aqui.",
  ].join("\n");
  const tail = onlyIndex.length
    ? `\n\n### Irmãos presentes apenas no MAPA (corpo não enviado nesta rodada): ${onlyIndex.join(", ")}`
    : "";
  return { block: `${header}\n${parts.join("\n")}${tail}`, included, omitted };
}
