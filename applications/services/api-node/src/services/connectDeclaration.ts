/**
 * connectDeclaration.ts — 🔴 GAP-133: a declaração Connect (`connect.yaml`) NÃO TINHA DONO no laço.
 *
 * MEDIDO em prod (2026-09-09): **0 de 58** projetos com spec têm `connect.yaml` na árvore. O
 * checklist "Connect-ready" da Bancada marcava o item em VERMELHO desde sempre e a dica prometia
 * dois caminhos que não existem — o `spec_file_splitter` tem `connect.yaml` em `_RESERVED_NAMES`
 * (nunca batiza uma peça assim) e "Resolver GAPs" só reescreve arquivo `.md` que JÁ está na árvore.
 * Ou seja: uma pendência que NENHUMA ação do produto podia fechar. O único gerador de declaração
 * vivia no `product_architect` (decomposição em projetos) e no `evolutionPlanner` (projeto de
 * evolução) — spec nova em UM projeto ficava de fora dos dois.
 *
 * Aqui a declaração passa a ter dono: a Bancada (botão) e o laço autônomo (uma etapa dedicada).
 *
 * LEI (Jean): Genesis é 100% LLM — o CONTEÚDO da declaração (interfaces, eventos, runtime,
 * ambientes, health, tier) é decisão do arquiteto. Este módulo só:
 *   • transporta os FATOS (spec, com todo corte DECLARADO — GAP-128/129/130);
 *   • impõe a IDENTIDADE pelo código (`schemaVersion`/`systemId`/`serviceId`/`owners` vêm do
 *     manifesto/tenant, nunca do LLM — espelho do `_build_connect_declaration` do Python);
 *   • VETA corrupção (valida contra o schema Connect vendorizado; chave desconhecida é descartada e
 *     DECLARADA, nunca gravada às escondidas);
 *   • grava `connect.yaml` pelo mesmo caminho de escrita do resto da spec (`upsertSpecFile`).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Pool } from "pg";
import { upsertSpecFile } from "./evolutionPlanner.js";
import { deriveSystemService } from "./githubPush.js";
import { loadVendoredSchema, validateAgainst, VENDORED_CONNECT_VERSION } from "./connectSchema.js";
import { cutEvidence } from "./evidenceCut.js";
import { resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";
import { SPEC_EDITABLE_STATUSES } from "./projectStatus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = path.resolve(__dirname, "..", "assets", "CONNECT_DECLARATION_PROMPT.md");
/** 🔴 GAP-135 — prompt do PASSE 1: o arquiteto escolhe o que vai ler (ver `selectFilesToRead`). */
const SELECT_PROMPT_FILE = path.resolve(__dirname, "..", "assets", "CONNECT_DECLARATION_SELECT_PROMPT.md");

/** Caminho canônico da declaração — o mesmo que o manifesto e o checklist esperam (raiz do projeto). */
export const CONNECT_DECL_PATH = "connect.yaml";
/**
 * Tetos do material enviado ao arquiteto. Todo corte é DECLARADO (no pedido, no resultado e no
 * cabeçalho do arquivo) — mas MEDIDO na 1ª geração em prod (VNX LastMile, 2026-09-09) o teto de 60k
 * cortou 9 dos 13 arquivos: a declaração saiu boa e HONESTA (o próprio arquiteto anotou "o oráculo
 * de eventos foi cortado, a seção `events` precisa ser revista"), mas fundada em ~1/3 da spec —
 * declarar interoperabilidade sem ler o arquivo de interoperabilidade. Declaração é artefato ÚNICO
 * por spec (uma chamada, não um laço), então o degrau certo é pagar contexto e ler a spec inteira;
 * os tetos ficam como rede contra spec patológica, não como regra de rotina.
 *
 * 2026-09-09 (Jean): os três tetos são CALIBRÁVEIS por ambiente (`CONNECT_DECL_SPEC_CAP`,
 * `CONNECT_DECL_FILE_CAP`, `CONNECT_DECL_MAX_FILES`) — o valor certo depende do tamanho das specs do
 * tenant e do modelo em uso, e descobrir isso não pode exigir rebuild. Valor inválido ou abaixo do
 * piso é RECUSADO com aviso (cai no padrão) em vez de virar teto absurdo silencioso.
 */
export const CONNECT_DECL_SPEC_CAP = capFromEnv("CONNECT_DECL_SPEC_CAP", 240_000, 10_000);
/** Teto por arquivo, para que UM arquivo grande não coma a spec inteira. */
export const CONNECT_DECL_FILE_CAP = capFromEnv("CONNECT_DECL_FILE_CAP", 40_000, 2_000);
/** Máximo de arquivos temáticos lidos (a lista COMPLETA vai no pedido de qualquer forma). */
export const CONNECT_DECL_MAX_FILES = capFromEnv("CONNECT_DECL_MAX_FILES", 32, 1);

export function capFromEnv(name: string, padrao: number, piso: number): number {
  const bruto = (process.env[name] ?? "").trim();
  if (!bruto) return padrao;
  const n = Number.parseInt(bruto, 10);
  if (!Number.isFinite(n) || n < piso) {
    console.warn(`[ConnectDecl] ${name}="${bruto}" ignorado (inteiro ≥ ${piso} esperado) — usando o padrão ${padrao}.`);
    return padrao;
  }
  if (n !== padrao) console.info(`[ConnectDecl] ${name}=${n} (padrão ${padrao}) — teto calibrado por ambiente.`);
  return n;
}

/** Dimensões que a declaração precisa sustentar — usadas para medir a cobertura da ESCOLHA (GAP-135). */
export const DECL_DIMENSIONS = ["interfaces", "dependencies", "events", "runtime", "environments", "health"] as const;
/** Cabeçalhos (`#`/`##`) enviados por arquivo no passe 1: o suficiente para reconhecer o assunto. */
const MAX_HEADINGS_PER_FILE = 14;

type Db = Pick<Pool, "query">;

let _promptCache: string | null = null;
export function loadConnectDeclarationPrompt(): string {
  if (_promptCache === null) {
    try { _promptCache = fs.readFileSync(PROMPT_FILE, "utf-8"); } catch { _promptCache = ""; }
  }
  return _promptCache;
}

let _selectPromptCache: string | null = null;
export function loadConnectSelectPrompt(): string {
  if (_selectPromptCache === null) {
    try { _selectPromptCache = fs.readFileSync(SELECT_PROMPT_FILE, "utf-8"); } catch { _selectPromptCache = ""; }
  }
  return _selectPromptCache;
}

// ── Contexto (fatos) ─────────────────────────────────────────────────────────

/** Um arquivo `.md` da spec com o corpo em memória (NUNCA vai inteiro ao LLM — ver `packSpecText`). */
export interface ReadableSpecFile { path: string; isPrimary: boolean; body: string }

/**
 * 🔴 GAP-135 — o FATO sobre um arquivo, sem o conteúdo: é o que o passe 1 recebe para escolher.
 * Cabeçalhos em vez de nome de arquivo porque `05-anexos.md` pode ser o único que descreve endpoints.
 */
export interface SpecFileFact {
  path: string;
  isPrimary: boolean;
  chars: number;
  headings: string[];
  /** Quantos cabeçalhos ficaram fora da amostra (corte declarado até aqui). */
  headingsOmitted: number;
}

export interface ConnectDeclContext {
  projectId: string;
  title: string;
  productName: string | null;
  /** Identidade imposta pelo código (a mesma do registro no Deadpool — `deriveSystemService`). */
  systemId: string;
  serviceId: string | null;
  /** Texto da spec (primária + temáticos), já com os cortes marcados. */
  specText: string;
  /** Lista COMPLETA de arquivos da spec (nunca cortada — é barata e diz o que existe). */
  files: string[];
  /** Já existe declaração? (o gerador não sobrescreve sem `overwrite`). */
  existing: string | null;
  /** Tetos que morderam — vão para o resultado, não ficam em silêncio. */
  truncated: string[];
  /** Parte de `truncated` que NÃO vem do empacotamento (sobrevive a uma reescolha do passe 1). */
  truncatedBase: string[];
  /** Fatos por arquivo legível (tamanho + cabeçalhos) — insumo do passe 1. */
  facts: SpecFileFact[];
  /** Corpos em memória (uso interno: nunca serializar isto num pedido). */
  readable: ReadableSpecFile[];
  /** Arquivos que ENTRARAM no `specText` e os que ficaram fora, sempre explícitos. */
  readPaths: string[];
  leftOut: string[];
  /**
   * A spec NÃO cabe nos tetos ⇒ alguém tem de ESCOLHER. Enquanto isto é `true`, o `specText` é
   * apenas um provisório na ordem da listagem — usá-lo assim é exatamente o defeito do GAP-135.
   */
  needsSelection: boolean;
  /** Escolha do arquiteto, quando o passe 1 rodou (fica no resultado e no cabeçalho do YAML). */
  selection: ConnectDeclSelection | null;
}

/** Cabeçalhos `#`/`##` de um markdown, para o passe 1 reconhecer o assunto sem ler o arquivo. */
export function extractHeadings(body: string, max = MAX_HEADINGS_PER_FILE): { headings: string[]; omitted: number } {
  const todos: string[] = [];
  for (const linha of String(body ?? "").split("\n")) {
    const m = /^(#{1,2})\s+(.+?)\s*$/.exec(linha);
    if (m) todos.push(`${m[1] === "#" ? "" : "  "}${m[2].slice(0, 120)}`);
    if (todos.length > max + 40) break; // spec patológica: não varrer eternamente por cabeçalho
  }
  return { headings: todos.slice(0, max), omitted: Math.max(0, todos.length - max) };
}

/**
 * Monta o texto da spec LENDO NA ORDEM PEDIDA e declarando tudo o que ficou fora. Quem define a
 * ordem é quem chama: no passe 2 é a escolha do arquiteto (GAP-135), e na spec que cabe inteira é a
 * própria listagem — aí não há escolha a fazer, só completude.
 */
export function packSpecText(
  files: ReadableSpecFile[],
  order: string[],
  caps: { specCap: number; fileCap: number; maxFiles: number } = {
    specCap: CONNECT_DECL_SPEC_CAP, fileCap: CONNECT_DECL_FILE_CAP, maxFiles: CONNECT_DECL_MAX_FILES,
  },
): { specText: string; truncated: string[]; readPaths: string[]; leftOut: string[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const truncated: string[] = [];
  const readPaths: string[] = [];
  const parts: string[] = [];
  // Teto por arquivo nunca pode ser maior que o teto total, senão o 1º arquivo já o estouraria.
  const fileCap = Math.min(caps.fileCap, caps.specCap);
  let total = 0;
  for (const p of order) {
    const f = byPath.get(p);
    if (!f || readPaths.includes(p)) continue;
    if (readPaths.length >= caps.maxFiles) {
      truncated.push(`spec: teto de ${caps.maxFiles} arquivo(s) lido(s) atingido — os seguintes não foram enviados`);
      break;
    }
    const capped = cutEvidence(f.body, fileCap);
    if (capped.length < f.body.length) truncated.push(`${p}: ${f.body.length} → ${fileCap} chars`);
    if (total > 0 && total + capped.length > caps.specCap) {
      truncated.push(`spec: teto total de ${caps.specCap} chars atingido em "${p}" — arquivos seguintes não foram enviados`);
      break;
    }
    total += capped.length;
    readPaths.push(p);
    parts.push(`--- ARQUIVO: ${p}${f.isPrimary ? " (PRIMÁRIO)" : ""} ---\n${capped}`);
  }
  const lidos = new Set(readPaths);
  const leftOut = files.map((f) => f.path).filter((p) => !lidos.has(p));
  if (leftOut.length) {
    truncated.push(`spec: ${readPaths.length} de ${files.length} arquivo(s) lidos — FORA: ${leftOut.join(", ")}`);
  }
  return { specText: parts.join("\n\n"), truncated, readPaths, leftOut };
}

export async function buildConnectDeclContext(db: Db, projectId: string): Promise<ConnectDeclContext> {
  const proj = (await db.query(
    `SELECT p.id, p.title, p.product_id,
            pr.name AS product_name, pr.system_id AS product_system_id, pr.solo_app AS product_solo_app
       FROM projects p LEFT JOIN products pr ON pr.id = p.product_id
      WHERE p.id = $1`,
    [projectId],
  )).rows[0] as {
    id: string; title: string | null; product_id: string | null; product_name: string | null;
    product_system_id: string | null; product_solo_app: boolean | null;
  } | undefined;
  if (!proj) throw new Error("PROJECT_NOT_FOUND");

  const rows = (await db.query(
    `SELECT filename, coalesce(rel_dir,'') AS rel_dir, file_path, is_primary
       FROM project_spec_files WHERE project_id = $1
      ORDER BY is_primary DESC, rel_dir, filename`,
    [projectId],
  )).rows as Array<{ filename: string; rel_dir: string; file_path: string; is_primary: boolean }>;

  const rel = (r: { filename: string; rel_dir: string }) => (r.rel_dir ? `${r.rel_dir}/${r.filename}` : r.filename);
  const files = rows.map(rel);
  /** Cortes que NÃO vêm do empacotamento (ex.: arquivo ilegível) — sobrevivem a uma reescolha. */
  const truncatedBase: string[] = [];

  const declRow = rows.find((r) => rel(r).toLowerCase() === CONNECT_DECL_PATH);
  let existing: string | null = null;
  if (declRow) {
    try { existing = await fs.promises.readFile(declRow.file_path, "utf-8"); } catch { existing = null; }
  }

  // Só markdown entra como texto (a declaração e binários não descrevem o domínio). O disco é lido
  // por inteiro: é barato perto de uma chamada de LLM, e é o que permite MEDIR o tamanho e os
  // cabeçalhos de cada arquivo antes de decidir o que enviar (passe 1 do GAP-135).
  const readable: ReadableSpecFile[] = [];
  for (const r of rows.filter((x) => /\.md$/i.test(x.filename))) {
    let body = "";
    try { body = await fs.promises.readFile(r.file_path, "utf-8"); }
    catch { truncatedBase.push(`${rel(r)}: ilegível no disco — não entrou na leitura`); continue; }
    readable.push({ path: rel(r), isPrimary: r.is_primary === true, body });
  }
  const facts: SpecFileFact[] = readable.map((f) => {
    const h = extractHeadings(f.body);
    return { path: f.path, isPrimary: f.isPrimary, chars: f.body.length, headings: h.headings, headingsOmitted: h.omitted };
  });
  // Provisório na ordem da listagem. Se sobrar arquivo de fora, ele NÃO serve: quem escolhe é o
  // arquiteto no passe 1 (`needsSelection`), porque ordem de listagem não é relevância.
  const baseline = packSpecText(readable, readable.map((f) => f.path));

  const ids = deriveSystemService({
    productSystemId: proj.product_system_id,
    productName: proj.product_name,
    title: proj.title,
    projectId: proj.id,
    // Mesma origem do registro no Deadpool (`githubPush`): App solo é sistema MONO-SERVIÇO
    // (serviceId=null). Ler isso de outro lugar produziria identidade divergente da já publicada.
    soloApp: proj.product_solo_app ?? false,
  });

  return {
    projectId: proj.id,
    title: (proj.title ?? "").trim() || proj.id,
    productName: proj.product_name,
    systemId: ids.systemId,
    serviceId: ids.serviceId,
    specText: baseline.specText,
    files,
    existing,
    truncated: [...truncatedBase, ...baseline.truncated],
    truncatedBase,
    facts,
    readable,
    readPaths: baseline.readPaths,
    leftOut: baseline.leftOut,
    needsSelection: baseline.leftOut.length > 0,
    selection: null,
  };
}

// ── 🔴 GAP-135 · PASSE 1: quem escolhe o que ler é o ARQUITETO ────────────────
//
// MEDIDO em prod (2026-09-09): a spec do NVX LastMile tem ~700k chars em 13 arquivos e o teto é de
// 240k — 7 arquivos ficavam fora, entre eles o ORÁCULO DE HEALTH, e a declaração de `healthModel`
// saía fundada em nada. O corte era declarado (honesto), mas a ESCOLHA era cega: valia a ordem da
// listagem (`is_primary DESC, rel_dir, filename`), que não sabe nada sobre integração. Ordenar por
// nome/tamanho seria trocar uma automação fixa por outra — e a LEI do Jean é explícita: estrutura e
// conteúdo de spec são decisão do AGENTE; o código transporta fatos e veta corrupção.
//
// Passe 1: o arquiteto recebe a LISTA com tamanho + cabeçalhos e devolve o que precisa ler, em ordem
// de importância, mais o RISCO do que ficar de fora. Passe 2: só o escolhido, e o que sobrou fora
// continua declarado. Sem LLM disponível a geração FALHA (`DECL_SELECTION_*`) — nunca cai no
// provisório da listagem, porque um fallback burro devolveria o defeito com cara de resultado.

export interface ConnectDeclSelection {
  /** Caminhos a ler, na ordem de importância dada pelo arquiteto (já validados contra a lista). */
  read: string[];
  why: string;
  /** O que o arquiteto diz que NÃO poderá declarar por causa do que ficou fora. */
  riskIfMissing: string[];
  /** Arquivo(s) que sustentam cada dimensão, na leitura do arquiteto. */
  dimensions: Record<string, string[]>;
  /** Dimensões sem NENHUM arquivo escolhido — declaradas, não caladas. */
  uncovered: string[];
  /** Caminhos devolvidos que não existem na spec (descartados) ou repetidos. */
  invalid: string[];
}

export function buildConnectDeclSelectRequest(ctx: ConnectDeclContext): Record<string, unknown> {
  const linhas = ctx.facts.map((f) => {
    const cabec = f.headings.length
      ? f.headings.map((h) => `    ${h}`).join("\n") + (f.headingsOmitted ? `\n    ⟨+${f.headingsOmitted} cabeçalho(s) não mostrados⟩` : "")
      : "    (sem cabeçalhos `#`/`##`)";
    const grande = f.chars > CONNECT_DECL_FILE_CAP ? ` ⚠️ maior que o teto por arquivo (${CONNECT_DECL_FILE_CAP}) — chegará CORTADO` : "";
    return `• ${f.path}${f.isPrimary ? " (PRIMÁRIO)" : ""} — ${f.chars} chars${grande}\n${cabec}`;
  });
  const somaChars = ctx.facts.reduce((a, f) => a + f.chars, 0);
  const parts = [
    `PRODUTO/SERVIÇO: ${ctx.title}${ctx.productName ? ` (produto "${ctx.productName}")` : ""}`,
    "",
    `ORÇAMENTO DO PASSE 2: no máximo ${CONNECT_DECL_MAX_FILES} arquivo(s) e ${CONNECT_DECL_SPEC_CAP} chars no total`
      + ` (teto de ${CONNECT_DECL_FILE_CAP} chars por arquivo).`,
    `A spec tem ${ctx.facts.length} arquivo(s) legível(is) somando ${somaChars} chars — NÃO cabe inteira, por isso a escolha é sua.`,
    "",
    `ARQUIVOS (com tamanho e cabeçalhos):`,
    ...linhas,
  ];
  if (ctx.existing) {
    parts.push("", "Já existe um connect.yaml (você vai REVISÁ-LO no passe 2) — escolha também o que permite conferir o que ele afirma:",
      cutEvidence(ctx.existing, 4_000));
  }
  parts.push("", "Devolva agora SOMENTE o objeto JSON no formato especificado.");
  return {
    prompt_override: loadConnectSelectPrompt(),
    user_message: parts.join("\n"),
    max_tokens: 2_000,
  };
}

/** Interpreta a escolha do arquiteto. Caminho inventado é DESCARTADO e declarado, nunca "aproximado". */
export function parseSelection(text: string, facts: SpecFileFact[]): ConnectDeclSelection {
  const raw = extractDeclarationJson(text);
  const porMinuscula = new Map(facts.map((f) => [f.path.toLowerCase(), f.path]));
  const invalid: string[] = [];
  const read: string[] = [];
  const norm = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const limpo = v.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    return porMinuscula.get(limpo.toLowerCase()) ?? null;
  };
  for (const item of Array.isArray(raw.read) ? raw.read : []) {
    const p = norm(item);
    if (!p) { invalid.push(`inexistente: ${String(item).slice(0, 120)}`); continue; }
    if (read.includes(p)) { invalid.push(`repetido: ${p}`); continue; }
    read.push(p);
  }
  if (read.length === 0) throw new Error("DECL_SELECTION_EMPTY");

  const dimensions: Record<string, string[]> = {};
  const uncovered: string[] = [];
  const dims = (raw.dimensions && typeof raw.dimensions === "object" && !Array.isArray(raw.dimensions)
    ? raw.dimensions : {}) as Record<string, unknown>;
  for (const d of DECL_DIMENSIONS) {
    const lista = (Array.isArray(dims[d]) ? (dims[d] as unknown[]) : [])
      .map(norm).filter((p): p is string => !!p && read.includes(p));
    if (lista.length) dimensions[d] = Array.from(new Set(lista));
    else uncovered.push(d);
  }
  const strs = (v: unknown, maxItems: number) => (Array.isArray(v) ? v : [])
    .filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim().slice(0, 400)).slice(0, maxItems);
  return {
    read,
    why: typeof raw.why === "string" ? raw.why.trim().slice(0, 1_200) : "",
    riskIfMissing: strs(raw.riskIfMissing, 12),
    dimensions,
    uncovered,
    invalid,
  };
}

/**
 * Aplica a escolha: reempacota o `specText` NA ORDEM do arquiteto e substitui os cortes do provisório
 * pelos cortes reais. Devolve um contexto novo — o provisório não sobrevive à decisão.
 */
export function applySelection(ctx: ConnectDeclContext, sel: ConnectDeclSelection): ConnectDeclContext {
  const packed = packSpecText(ctx.readable, sel.read);
  if (!packed.specText.trim()) throw new Error("DECL_SELECTION_UNREADABLE");
  return {
    ...ctx,
    specText: packed.specText,
    readPaths: packed.readPaths,
    leftOut: packed.leftOut,
    // Os cortes do provisório morrem com ele; só os que independem da escolha (disco) permanecem.
    truncated: [...ctx.truncatedBase, ...packed.truncated],
    selection: sel,
  };
}

// ── Pedido ao arquiteto (/invoke/raw) ────────────────────────────────────────

export function buildConnectDeclRequest(ctx: ConnectDeclContext): Record<string, unknown> {
  const parts = [
    `PRODUTO/SERVIÇO: ${ctx.title}${ctx.productName ? ` (produto "${ctx.productName}")` : ""}`,
    `IDENTIDADE (o sistema preenche — NÃO devolva estes campos): schemaVersion=${VENDORED_CONNECT_VERSION} · systemId=${ctx.systemId} · serviceId=${ctx.serviceId ?? "(nulo: sistema mono-serviço)"}`,
    "",
    `ARQUIVOS DA SPEC (${ctx.files.length}): ${ctx.files.join(", ")}`,
  ];
  if (ctx.selection) {
    // 🔴 GAP-135: a leitura é a que o PRÓPRIO arquiteto pediu no passe 1. Devolver a escolha a ele
    // fecha o laço: se agora percebe que faltou algo, isso vai para `notes[]` como lacuna conhecida.
    parts.push("", `LEITURA QUE VOCÊ PEDIU no passe 1 (${ctx.readPaths.length} de ${ctx.facts.length} arquivo(s)): ${ctx.readPaths.join(", ")}`);
    if (ctx.selection.why) parts.push(`Seu critério: ${ctx.selection.why}`);
    if (ctx.selection.uncovered.length) {
      parts.push(`⚠️ Dimensões que você NÃO conseguiu apontar a nenhum arquivo: ${ctx.selection.uncovered.join(", ")}`
        + " — declare-as só se a leitura sustentar; caso contrário, registre a lacuna em `notes[]`.");
    }
    if (ctx.selection.riskIfMissing.length) {
      parts.push("⚠️ Riscos que você mesmo apontou pelo que ficou fora:", ...ctx.selection.riskIfMissing.map((r) => `• ${r}`));
    }
    if (ctx.selection.invalid.length) {
      parts.push(`Caminhos descartados da sua escolha (não existem na spec): ${ctx.selection.invalid.join(" · ")}`);
    }
  }
  if (ctx.truncated.length) {
    // O que o arquiteto NÃO viu tem de ser dito a ele: decidir sobre spec cortada sem saber do corte
    // é o defeito GAP-128/129/130 na origem.
    parts.push("", "⚠️ CORTES NESTE PEDIDO (você NÃO recebeu a spec inteira):", ...ctx.truncated.map((t) => `• ${t}`),
      "Se um corte impedir declarar alguma dimensão, registre isso em `notes[]` em vez de inventar.");
  }
  parts.push("", "--- SPEC (só leitura) ---", ctx.specText || "(spec indisponível)", "--- FIM DA SPEC ---");
  if (ctx.existing) {
    parts.push("", "--- connect.yaml ATUAL (revise e devolva a declaração COMPLETA já corrigida) ---",
      cutEvidence(ctx.existing, 8_000), "--- FIM ---");
  }
  parts.push("", "Devolva agora SOMENTE o objeto JSON no formato especificado.");
  return {
    prompt_override: loadConnectDeclarationPrompt(),
    user_message: parts.join("\n"),
    max_tokens: 8_000,
  };
}

// ── Parse + montagem (saída de LLM NUNCA entra crua) ─────────────────────────

/** Chaves que o arquiteto DECIDE. Fora desta lista: descartado e DECLARADO. */
const LLM_KEYS = [
  "serviceName", "responsibility", "interfaces", "dependencies", "events",
  "runtimeType", "queues", "healthModel", "environments", "integrationTierTarget", "notes",
] as const;
/** Chaves de IDENTIDADE — vêm do código; se o LLM as emitir, são descartadas com aviso. */
const IDENTITY_KEYS = ["schemaVersion", "systemId", "serviceId", "owners"] as const;

export function extractDeclarationJson(text: string): Record<string, unknown> {
  let t = (text ?? "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[^\n]*\n/, "");
    const last = t.lastIndexOf("```");
    if (last >= 0) t = t.slice(0, last);
    t = t.trim();
  }
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("DECL_NOT_JSON");
  const parsed = JSON.parse(t.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DECL_NOT_JSON");
  return parsed as Record<string, unknown>;
}

export interface AssembledDeclaration {
  declaration: Record<string, unknown>;
  warnings: string[];
}

/**
 * Enum de um campo, LIDO DO SCHEMA vendorizado (`interfaces.items.type`, `environments.items.criticality`…).
 * Não é lista fixa no código: o vocabulário é do contrato Connect — subir o schema muda o vocabulário
 * sem tocar aqui. Sem schema, devolve `null` e nada é normalizado (nem calado: vira aviso).
 */
export function schemaEnum(schema: Record<string, unknown> | null, dotted: string): string[] | null {
  let node: unknown = schema;
  for (const seg of dotted.split(".")) {
    if (!node || typeof node !== "object") return null;
    const o = node as Record<string, unknown>;
    node = seg === "items" ? o.items : (o.properties as Record<string, unknown> | undefined)?.[seg];
  }
  const e = (node as Record<string, unknown> | undefined)?.enum;
  return Array.isArray(e) && e.every((x) => typeof x === "string") ? (e as string[]) : null;
}

/**
 * Monta a `SpecConnectDeclaration`: identidade do código + decisão do arquiteto, validada contra o
 * schema vendorizado. Não "corrige" conteúdo: o que não passa vira AVISO (o humano/laço decide) —
 * exceto o que é corrupção estrutural (chave desconhecida, `interfaces` inválido), que é recusado.
 */
export function assembleDeclaration(ctx: ConnectDeclContext, raw: Record<string, unknown>): AssembledDeclaration {
  const warnings: string[] = [];
  const schema = loadVendoredSchema("spec-connect-declaration");

  /**
   * Valor de vocabulário FECHADO. Fora do enum: cai para `other` quando o enum o tem (o fato
   * "existe esta superfície" sobrevive), senão o campo é OMITIDO — nas duas hipóteses DECLARADO.
   * Matar a declaração inteira por causa de um rótulo fora do vocabulário seria perder o resto.
   */
  const enumVal = (dotted: string, value: string, onde: string): string => {
    if (!value) return "";
    const vocab = schemaEnum(schema, dotted);
    if (!vocab || vocab.includes(value)) return value;
    if (vocab.includes("other")) {
      warnings.push(`${onde}: "${value}" fora do vocabulário Connect (${vocab.join("|")}) → gravado como "other".`);
      return "other";
    }
    warnings.push(`${onde}: "${value}" fora do vocabulário Connect (${vocab.join("|")}) → campo OMITIDO.`);
    return "";
  };

  const emitted = IDENTITY_KEYS.filter((k) => k in raw);
  if (emitted.length) warnings.push(`Identidade devolvida pelo arquiteto foi DESCARTADA (vem do manifesto/tenant): ${emitted.join(", ")}.`);
  const unknown = Object.keys(raw).filter((k) => !(LLM_KEYS as readonly string[]).includes(k) && !(IDENTITY_KEYS as readonly string[]).includes(k));
  if (unknown.length) warnings.push(`Chaves Connect desconhecidas ignoradas: ${unknown.sort().join(", ")}.`);

  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const interfaces = (Array.isArray(raw.interfaces) ? raw.interfaces : [])
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object" && !Array.isArray(i))
    .filter((i) => str(i.name, 120) && str(i.type, 40))
    .map((i) => {
      const nome = str(i.name, 120);
      const tipo = enumVal("interfaces.items.type", str(i.type, 40), `interfaces["${nome}"].type`);
      const out: Record<string, unknown> = { name: nome, type: tipo || "other" };
      if (str(i.contractRef, 300)) out.contractRef = str(i.contractRef, 300);
      if (str(i.description, 600)) out.description = str(i.description, 600);
      return out;
    });
  if (interfaces.length === 0) throw new Error("DECL_WITHOUT_INTERFACES");
  if (Array.isArray(raw.interfaces) && interfaces.length < raw.interfaces.length) {
    warnings.push(`${raw.interfaces.length - interfaces.length} interface(s) sem \`name\`/\`type\` descartada(s).`);
  }

  const declaration: Record<string, unknown> = {
    schemaVersion: VENDORED_CONNECT_VERSION,
    systemId: ctx.systemId,
    serviceName: str(raw.serviceName, 200) || ctx.title,
    responsibility: str(raw.responsibility, 2_000) || `Responsabilidades do serviço ${ctx.title}.`,
    interfaces,
  };
  // `serviceId` é opcional no schema (mono-serviço tem `null`) — só entra quando o código o derivou.
  if (ctx.serviceId) declaration.serviceId = ctx.serviceId;
  if (!str(raw.serviceName, 200)) warnings.push("`serviceName` ausente — usado o título do projeto.");
  if (!str(raw.responsibility, 2_000)) warnings.push("`responsibility` ausente — texto genérico gravado; revise.");

  const strList = (v: unknown, maxItems: number, maxLen: number) =>
    (Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim().slice(0, maxLen)).slice(0, maxItems);

  const deps = strList(raw.dependencies, 40, 200);
  if (deps.length) declaration.dependencies = deps;
  const queues = strList(raw.queues, 40, 200);
  if (queues.length) declaration.queues = queues;
  const notes = strList(raw.notes, 30, 600);
  if (notes.length) declaration.notes = notes;

  if (raw.events && typeof raw.events === "object" && !Array.isArray(raw.events)) {
    const e = raw.events as Record<string, unknown>;
    const ev: Record<string, unknown> = {};
    for (const k of ["publishes", "subscribes", "valueEvents"] as const) {
      let l = strList(e[k], 40, 200);
      if (k === "valueEvents" && l.length) {
        // `valueEvents` é vocabulário FECHADO no Connect (contrato value/): o que não está nele não é
        // "quase certo", é inexistente — sai, e o corte é declarado.
        const vocab = schemaEnum(schema, "events.valueEvents.items");
        if (vocab) {
          const fora = l.filter((v) => !vocab.includes(v));
          if (fora.length) warnings.push(`events.valueEvents: ${fora.length} evento(s) fora do contrato value/ descartado(s): ${fora.join(", ")} (válidos: ${vocab.join("|")}).`);
          l = l.filter((v) => vocab.includes(v));
        }
      }
      if (l.length) ev[k] = l;
    }
    if (Object.keys(ev).length) declaration.events = ev;
  }
  const runtime = enumVal("runtimeType", str(raw.runtimeType, 40), "runtimeType");
  if (runtime) declaration.runtimeType = runtime;
  const tier = enumVal("integrationTierTarget", str(raw.integrationTierTarget, 60), "integrationTierTarget");
  if (tier) declaration.integrationTierTarget = tier;

  if (raw.healthModel && typeof raw.healthModel === "object" && !Array.isArray(raw.healthModel)) {
    const h = raw.healthModel as Record<string, unknown>;
    const hm: Record<string, unknown> = {};
    if (typeof h.hasHealthEndpoint === "boolean") hm.hasHealthEndpoint = h.hasHealthEndpoint;
    if (typeof h.sloCritical === "boolean") hm.sloCritical = h.sloCritical;
    const signals = strList(h.signals, 20, 120);
    if (signals.length) hm.signals = signals;
    if (Object.keys(hm).length) declaration.healthModel = hm;
  }

  const envs = (Array.isArray(raw.environments) ? raw.environments : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    .filter((x) => str(x.name, 60) && str(x.type, 40))
    .map((x) => {
      const nome = str(x.name, 60);
      const out: Record<string, unknown> = {
        name: nome,
        type: enumVal("environments.items.type", str(x.type, 40), `environments["${nome}"].type`) || "other",
      };
      if (str(x.region, 60)) out.region = str(x.region, 60);
      const crit = enumVal("environments.items.criticality", str(x.criticality, 20), `environments["${nome}"].criticality`);
      if (crit) out.criticality = crit;
      return out;
    })
    .slice(0, 12);
  if (envs.length) declaration.environments = envs;

  // Veto de corrupção: o schema Connect vendorizado é o fato. O que sobrou inválido depois da
  // normalização NÃO é opinião do arquiteto — é declaração que a fábrica recusaria depois (falha
  // tardia e obscura). Melhor falhar aqui, com o motivo exato na mão de quem pediu.
  if (!schema) {
    warnings.push(`Declaração NÃO validada: schema Connect vendorizado indisponível nesta instalação (v${VENDORED_CONNECT_VERSION}).`);
  } else {
    const errs = validateAgainst(declaration, schema);
    for (const e of errs.slice(0, 12)) warnings.push(`schema: ${e}`);
    if (errs.length > 12) warnings.push(`schema: ⟨CORTADO: ${errs.length - 12} de ${errs.length} erros — mostrados os 12 primeiros⟩`);
    if (errs.length) throw Object.assign(new Error("DECL_SCHEMA_INVALID"), { warnings });
  }
  return { declaration, warnings };
}

// ── Serialização YAML (subconjunto JSON-safe: string/number/boolean/array/objeto) ──

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  // Sempre com aspas duplas + escape JSON: é YAML válido para QUALQUER string (acento, `:`, `#`,
  // quebra de linha) e não depende de heurística de "precisa citar?".
  return JSON.stringify(String(v));
}

export function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((item) => {
      if (item && typeof item === "object") {
        const inner = toYaml(item, indent + 1);
        // O primeiro par do objeto sobe para a linha do `-`.
        return `${pad}- ${inner.slice((indent + 1) * 2)}`;
      }
      return `${pad}- ${yamlScalar(item)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}`;
    return entries.map(([k, v]) => {
      if (Array.isArray(v)) return v.length === 0 ? `${pad}${k}: []` : `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      if (v && typeof v === "object") return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      return `${pad}${k}: ${yamlScalar(v)}`;
    }).join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

export function declarationToYaml(declaration: Record<string, unknown>, header: string[]): string {
  const head = header.map((h) => `# ${h}`).join("\n");
  return `${head}\n${toYaml(declaration)}\n`;
}

// ── Execução ─────────────────────────────────────────────────────────────────

export interface GenerateResult {
  path: string;
  action: "created" | "updated" | "skipped";
  declaration: Record<string, unknown>;
  warnings: string[];
  truncated: string[];
  modelUsed: string | null;
  /** 🔴 GAP-135 — a leitura EFETIVA e quem a escolheu (o resultado diz sobre o que foi decidido). */
  read?: { files: string[]; leftOut: string[]; chosenBy: "arquiteto" | "spec-inteira"; why?: string; uncovered?: string[] };
}

/** Resposta do serviço `agents` (`/invoke/raw`): o envelope é sempre `{response, model_used}`. */
function respostaDoAgente(bruto: string): { text: string; model: string | null } {
  const data = JSON.parse(bruto) as { response?: string; model_used?: string };
  return { text: String(data.response ?? ""), model: data.model_used ?? null };
}

/**
 * Gera (ou revisa) a declaração Connect do projeto e grava `connect.yaml`.
 * `invoke` é o transporte para o serviço agents (`/invoke/raw`) — injetado pela rota/laço.
 */
export async function generateConnectDeclaration(
  db: Db,
  projectId: string,
  invoke: (body: Record<string, unknown>) => Promise<string>,
  opts: { overwrite?: boolean } = {},
): Promise<GenerateResult> {
  let ctx = await buildConnectDeclContext(db, projectId);
  if (ctx.existing && !opts.overwrite) {
    return {
      path: CONNECT_DECL_PATH, action: "skipped", declaration: {},
      warnings: ["Já existe connect.yaml — nada foi sobrescrito (envie overwrite para revisar)."],
      truncated: ctx.truncated, modelUsed: null,
    };
  }
  if (!ctx.specText.trim()) throw new Error("EMPTY_SPEC");

  const llm = agentsLlmFields(await resolveWorkbenchLlm({ projectId }));
  const avisosDeLeitura: string[] = [];
  let modeloDaEscolha: string | null = null;

  // 🔴 GAP-135 · PASSE 1 — a spec não cabe: quem escolhe o que ler é o arquiteto, não a listagem.
  if (ctx.needsSelection) {
    const brutoSel = await invoke({ ...buildConnectDeclSelectRequest(ctx), ...llm })
      .catch((e) => { throw new Error(`DECL_SELECTION_FAILED: ${e instanceof Error ? e.message : String(e)}`); });
    const sel0 = respostaDoAgente(brutoSel);
    modeloDaEscolha = sel0.model;
    if (sel0.text.trim().length < 10) throw new Error("DECL_SELECTION_EMPTY");
    // Escolha ilegível NÃO cai no provisório da listagem: a LEI é 100% LLM, e um fallback burro
    // devolveria a leitura cega (o defeito) com aparência de resultado. Falha → o laço tenta de novo.
    const sel = parseSelection(sel0.text, ctx.facts);
    ctx = applySelection(ctx, sel);
    console.info(`[ConnectDecl] projeto=${projectId} passe 1: o arquiteto pediu ${ctx.readPaths.length} de ${ctx.facts.length} arquivo(s)`
      + `${ctx.leftOut.length ? ` (fora: ${ctx.leftOut.length})` : ""}${sel.uncovered.length ? ` · dimensões sem fonte: ${sel.uncovered.join(",")}` : ""}`);
    avisosDeLeitura.push(
      `Leitura escolhida pelo arquiteto (2 passes — GAP-135): ${ctx.readPaths.length} de ${ctx.facts.length} arquivo(s).`
      + (ctx.leftOut.length ? ` Fora: ${ctx.leftOut.join(", ")}.` : ""),
    );
    if (sel.uncovered.length) avisosDeLeitura.push(`Dimensões sem arquivo apontado no passe 1: ${sel.uncovered.join(", ")} — confira o que a declaração afirma sobre elas.`);
    for (const r of sel.riskIfMissing) avisosDeLeitura.push(`Risco declarado pelo arquiteto: ${r}`);
    if (sel.invalid.length) avisosDeLeitura.push(`Caminhos inexistentes descartados da escolha: ${sel.invalid.join(" · ")}.`);
  }

  const { text, model } = respostaDoAgente(await invoke({ ...buildConnectDeclRequest(ctx), ...llm }));
  if (text.trim().length < 20) throw new Error("EMPTY_RESPONSE");

  const montada = assembleDeclaration(ctx, extractDeclarationJson(text));
  const declaration = montada.declaration;
  const warnings = [...avisosDeLeitura, ...montada.warnings];
  const header = [
    `Declaração Connect gerada pela Bancada do Zentriz Genesis (schema Connect v${VENDORED_CONNECT_VERSION}).`,
    "Conteúdo decidido pelo arquiteto (LLM) a partir da spec; identidade (systemId/serviceId) imposta pelo sistema.",
    ...(ctx.selection
      ? [
          `Leitura escolhida pelo próprio arquiteto (2 passes): ${ctx.readPaths.join(", ")}.`,
          ...(ctx.leftOut.length ? [`NÃO lidos: ${ctx.leftOut.join(", ")}.`] : []),
          ...(ctx.selection.why ? [`Critério: ${ctx.selection.why}`] : []),
          ...(ctx.selection.uncovered.length ? [`Dimensões sem arquivo apontado: ${ctx.selection.uncovered.join(", ")}.`] : []),
        ]
      : []),
    ...(ctx.truncated.length ? [`Cortes no material lido: ${ctx.truncated.join(" · ")}`] : []),
  ];
  const yaml = declarationToYaml(declaration, header);
  const action = await upsertSpecFile(db, projectId, CONNECT_DECL_PATH, yaml, true);
  await db.query("UPDATE projects SET spec_dirty_at = now() WHERE id = $1", [projectId]).catch(() => {});
  return {
    path: CONNECT_DECL_PATH, action, declaration, warnings, truncated: ctx.truncated,
    modelUsed: model ?? modeloDaEscolha,
    read: {
      files: ctx.readPaths, leftOut: ctx.leftOut,
      chosenBy: ctx.selection ? "arquiteto" : "spec-inteira",
      ...(ctx.selection?.why ? { why: ctx.selection.why } : {}),
      ...(ctx.selection?.uncovered.length ? { uncovered: ctx.selection.uncovered } : {}),
    },
  };
}

// ── O LAÇO como dono (migração 115) ──────────────────────────────────────────
//
// Molde: `specLearning.ts` (G7). Varre runs TERMINADAS em vez de pendurar o gancho em cada caminho de
// `finishRun` — um caminho novo de encerramento passa a declarar sem ninguém lembrar de plugá-lo. O
// CLAIM é idempotente (`connect_decl_at`), e o resultado fica DECLARADO em `connect_decl_result`:
// geração que falha em silêncio seria o mesmo defeito que este GAP fecha.

/** Gerações por tick: cada uma é uma chamada de LLM (~1 min). Duas é o freio de custo por tick. */
const MAX_DECLS_PER_TICK = 2;
/** Tentativas por run: cobre janela de deploy/agents fora do ar sem virar laço de gasto. */
const MAX_DECL_ATTEMPTS = 3;
/** Depois disto, uma geração reclamada e sem resultado é considerada PERDIDA (restart no meio). */
const DECL_STUCK_MIN = 20;

export interface ConnectDeclTickResult {
  scanned: number; started: number; skipped: number; recovered: number;
}

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function attemptsOf(raw: unknown): number {
  if (!raw) return 0;
  try {
    const o = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
    return Number(o?.attempts ?? 0) || 0;
  } catch { return 0; }
}

async function recordDeclResult(db: Db, runId: string, result: Record<string, unknown>): Promise<void> {
  await db.query(
    "UPDATE spec_autonomy_runs SET connect_decl_result = $2::jsonb, updated_at = now() WHERE id = $1",
    [runId, JSON.stringify(result)],
  ).catch((e) => console.warn(`[ConnectDecl] registro do resultado ${runId}: ${msg(e)}`));
}

/** Devolve a run à fila (até o teto de tentativas) — falha de agents é quase sempre transitória. */
async function releaseClaim(db: Db, runId: string, attempts: number): Promise<void> {
  if (attempts >= MAX_DECL_ATTEMPTS) return;
  await db.query(
    "UPDATE spec_autonomy_runs SET connect_decl_at = NULL, updated_at = now() WHERE id = $1",
    [runId],
  ).catch(() => {});
}

/**
 * Um tick: para cada laço que TERMINOU e cuja spec segue sem `connect.yaml`, pede a declaração ao
 * arquiteto. Nunca lança (é acessório: não pode derrubar o worker da Bancada) e nunca sobrescreve uma
 * declaração existente — revisar é decisão humana, pelo botão da Bancada com `overwrite`.
 *
 * A geração roda FORA do await do tick de propósito: o tick do worker é de 20 s e tem guarda de
 * reentrância, então esperar ~1 min por uma chamada de LLM aqui atrasaria a coleta dos jobs do CTO e
 * o avanço dos outros laços. O claim já está persistido antes de sair, então nada dispara duas vezes.
 */
export async function ensureConnectDeclarationsTick(
  db: Db,
  transport?: { post?: (url: string, body: string, timeoutMs: number) => Promise<string> },
): Promise<ConnectDeclTickResult> {
  const out: ConnectDeclTickResult = { scanned: 0, started: 0, skipped: 0, recovered: 0 };
  const base = (process.env.API_AGENTS_URL ?? "").trim().replace(/\/$/, "");
  if (!base) return out;
  const post = transport?.post ?? (await import("../routes/specs.js")).httpPost;

  // Fase 0 — reclamadas e sem resultado há muito tempo: a api reiniciou no meio da geração. Sem isto
  // a run ficaria reclamada para sempre (nunca mais varrida) e a spec sem declaração, em silêncio.
  try {
    const stuck = (await db.query(
      `SELECT id, connect_decl_result FROM spec_autonomy_runs
        WHERE connect_decl_at IS NOT NULL AND connect_decl_result IS NULL
          AND connect_decl_at < now() - ($1 || ' minutes')::interval
        ORDER BY connect_decl_at ASC LIMIT 5`,
      [String(DECL_STUCK_MIN)],
    )).rows as Array<Record<string, unknown>>;
    for (const row of stuck) {
      const id = String(row.id);
      const attempts = attemptsOf(row.connect_decl_result) + 1;
      await recordDeclResult(db, id, { error: `geração interrompida (sem resultado em ${DECL_STUCK_MIN} min — provável restart da api)`, attempts });
      await releaseClaim(db, id, attempts);
      out.recovered += 1;
    }
  } catch (e) {
    // Migração 115 ausente (banco atrás do código): nada a fazer, e sem ruído a cada 20 s.
    if (!/connect_decl_at/.test(msg(e))) console.warn(`[ConnectDecl] varredura de presas falhou: ${msg(e)}`);
    return out;
  }

  let pending: Array<Record<string, unknown>> = [];
  try {
    pending = (await db.query(
      `SELECT r.id, r.project_id, r.tenant_id, r.status, p.status AS project_status
         FROM spec_autonomy_runs r JOIN projects p ON p.id = r.project_id
        WHERE r.connect_decl_at IS NULL AND r.finished_at IS NOT NULL
        ORDER BY r.finished_at ASC LIMIT $1`,
      [MAX_DECLS_PER_TICK],
    )).rows as Array<Record<string, unknown>>;
  } catch (e) {
    if (!/connect_decl_at/.test(msg(e))) console.warn(`[ConnectDecl] varredura falhou: ${msg(e)}`);
    return out;
  }
  out.scanned = pending.length;

  for (const row of pending) {
    const runId = String(row.id);
    const projectId = String(row.project_id);
    const projectStatus = String(row.project_status ?? "");
    // CLAIM primeiro (o custo de um duplo disparo é uma chamada de LLM paga).
    const claimed = await db.query(
      "UPDATE spec_autonomy_runs SET connect_decl_at = now(), updated_at = now() WHERE id = $1 AND connect_decl_at IS NULL",
      [runId],
    ).catch((e) => { console.warn(`[ConnectDecl] claim ${runId}: ${msg(e)}`); return { rowCount: 0 }; });
    if ((claimed.rowCount ?? 0) === 0) continue;

    if (!SPEC_EDITABLE_STATUSES.has(projectStatus)) {
      out.skipped += 1;
      await recordDeclResult(db, runId, { skipped: `spec não editável (projeto em '${projectStatus}')` });
      continue;
    }
    // Outra run do MESMO projeto gerando agora: duas declarações concorrentes seriam duas chamadas
    // pagas e uma escrita perdida. O projeto é o recurso, não a run.
    const irma = (await db.query(
      `SELECT 1 FROM spec_autonomy_runs
        WHERE project_id = $1 AND id <> $2 AND connect_decl_at IS NOT NULL AND connect_decl_result IS NULL
        LIMIT 1`,
      [projectId, runId],
    ).catch(() => ({ rows: [] }))).rows;
    if (irma.length) {
      out.skipped += 1;
      await recordDeclResult(db, runId, { skipped: "outra run do mesmo projeto já está gerando a declaração" });
      continue;
    }

    const ctx = await buildConnectDeclContext(db, projectId).catch((e) => {
      console.warn(`[ConnectDecl] contexto do projeto ${projectId}: ${msg(e)}`);
      return null;
    });
    if (!ctx) {
      const attempts = attemptsOf(row.connect_decl_result) + 1;
      await recordDeclResult(db, runId, { error: "spec indisponível para montar o contexto", attempts });
      await releaseClaim(db, runId, attempts);
      out.skipped += 1;
      continue;
    }
    if (ctx.existing) {
      out.skipped += 1;
      await recordDeclResult(db, runId, { skipped: "já existe connect.yaml (não sobrescrevo — revisar é decisão humana)" });
      continue;
    }
    if (!ctx.specText.trim()) {
      out.skipped += 1;
      await recordDeclResult(db, runId, { skipped: "spec sem conteúdo legível — nada a declarar" });
      continue;
    }

    out.started += 1;
    console.info(`[ConnectDecl] run=${runId} projeto=${projectId} → pedindo a declaração Connect (${ctx.files.length} arquivo(s) na spec)`);
    // Fora do await: ver o comentário do cabeçalho desta função.
    void generateConnectDeclaration(db, projectId, (body) => post(`${base}/invoke/raw`, JSON.stringify(body), 240_000))
      .then(async (res) => {
        await recordDeclResult(db, runId, {
          action: res.action, path: res.path, warnings: res.warnings,
          truncated: res.truncated, model: res.modelUsed,
          interfaces: Array.isArray(res.declaration.interfaces) ? (res.declaration.interfaces as unknown[]).length : 0,
          // GAP-135: o resultado registra SOBRE O QUE a declaração foi decidida e quem escolheu.
          ...(res.read ? { read: res.read } : {}),
        });
        console.info(`[ConnectDecl] run=${runId} \`${res.path}\` ${res.action} (${res.warnings.length} aviso(s))`);
      })
      .catch(async (e) => {
        const attempts = attemptsOf(row.connect_decl_result) + 1;
        const warnings = (e as { warnings?: string[] }).warnings ?? [];
        await recordDeclResult(db, runId, { error: msg(e).slice(0, 300), warnings, attempts });
        await releaseClaim(db, runId, attempts);
        console.warn(`[ConnectDecl] run=${runId} geração falhou (tentativa ${attempts}/${MAX_DECL_ATTEMPTS}): ${msg(e)}`);
      });
  }
  return out;
}
