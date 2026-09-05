/**
 * factoryCertificate.ts — Certificado "Genesis Factory" (PR1 do desenho em
 * `project/docs/ideas/IDEIA-CERTIFICADO-GENESIS-FACTORY-2026-09-05.md`).
 *
 * O que o certificado AFIRMA: "a especificação deste projeto está no formato que a fábrica
 * aceita e passou a validação adversarial vigente para o conteúdo ATUAL".
 * O que NÃO afirma (A3): que a fabricação vai dar certo, que cabe no orçamento, que há slot
 * ou que as dependências estarão prontas na hora de promover — isso é gate de runtime.
 *
 * Regra de projeto (A1 — "teatro de certificado"): o selo **não tem opinião própria**. Cada
 * check é a projeção de uma função que a fábrica já aplica no choke-point (`runnerDispatch`):
 *   C1 `computeCurrentSpecHash` · C2 `checkSpecContentReady` (no MESMO arquivo primário que o
 *   dispatch lê) · C3/C4/C5 `assessSpecValidation` (o núcleo de `checkSpecValidationGate`).
 * Nenhuma heurística nova: `specEnrichment.readiness` — o selo que MENTE hoje — não é fonte.
 *
 * Assimetria consciente da coerência: `certified` ⇒ o dispatch não recusa por motivo de spec
 * (é a garantia que o usuário lê no chip). O inverso vale para C1–C5, mas **não** para C7
 * (tipo/stack): o dispatch não checa `project_type`, e certificar mais estrito do que o gate
 * nunca cria falsa promessa — só exige um pouco mais para exibir o selo.
 *
 * A2 (`SPEC_VALIDATION_GATE=off` em prod): o certificado avalia os checks INDEPENDENTE da
 * flag (por isso `assessSpecValidation` foi extraído) e devolve `gateEnforced` para a tela
 * poder dizer "com o gate desligado, a promoção não é barrada".
 *
 * A4 (custo): esta função NUNCA dispara validação. Sem run para o hash atual → `stale`
 * (havia run de outro hash) ou `unknown` (nunca validou). Zero chamada de LLM.
 * A5 (staleness): tudo é amarrado ao `spec_hash` do DISCO — nunca "verde por inércia".
 */
import { checkSpecContentReady } from "./specContentGate.js";
import { assessSpecValidation, specValidationGateEnabled, type SpecValidationAssessment } from "./specValidation.js";

type Db = { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

/** Flag de EXIBIÇÃO (a função pura é sempre calculável/testável): FACTORY_CERTIFICATE=on liga. */
export function factoryCertificateEnabled(): boolean {
  return (process.env.FACTORY_CERTIFICATE ?? "off").trim().toLowerCase() === "on";
}

export type FactoryCertificateLevel = "certified" | "certified_with_acks" | "stale" | "blocked" | "unknown";

export type FactoryCheckId = "C1" | "C2" | "C3" | "C4" | "C5" | "C7";

export interface FactoryCertificateCheck {
  id: FactoryCheckId;
  label: string;
  /** `null` = indeterminado (não há como afirmar — ex.: sem run para o hash atual). */
  ok: boolean | null;
  detail?: string;
}

export interface FactoryCertificate {
  level: FactoryCertificateLevel;
  /** Código do motivo quando não é `certified` (o MESMO do gate quando vem dele). */
  code: string | null;
  /** Frase curta PT-BR para o chip/tooltip. */
  message: string;
  /** Hash do conteúdo certificado (chave de cache e de invalidação automática). */
  specHash: string | null;
  checks: FactoryCertificateCheck[];
  /** Ressalvas que rebaixaram `certified` → `certified_with_acks` (A7: o ack é humano). */
  caveats: string[];
  /** Selo SEPARADO (decisão D2b) — não influencia `level` (A10: acervo pré-R4). */
  connect: { level: "connect_ready" | "incomplete" | "absent"; missing: string[] };
  /** A2: `false` = a promoção NÃO é barrada por spec hoje (flag do gate desligada). */
  gateEnforced: boolean;
  /** Informativo (C8/C9 ficam fora do veredito). */
  activeBlockers: number;
  activeWarnings: number;
}

/** Agregado por PRODUTO (A6): **AND**, com contagem explícita `n/m` — nunca porcentagem sozinha. */
export interface ProductFactoryCertificate {
  level: FactoryCertificateLevel;
  /** `n` = projetos com selo (`certified` + `certified_with_acks`). */
  certified: number;
  /** `m` = projetos avaliados. */
  total: number;
  withCaveats: number;
  blocked: number;
  stale: number;
  unknown: number;
  connectReady: number;
  message: string;
}

/** Chaves obrigatórias do SpecConnectDeclaration v1.3.0 (`required` do schema vendorizado). */
const CONNECT_REQUIRED_KEYS = ["schemaVersion", "systemId", "serviceName", "responsibility", "interfaces"];

/**
 * Selo Connect (D2b) — check de SUPERFÍCIE: presença das chaves obrigatórias no `connect.yaml`.
 * Não é validação de schema: a api-node não tem parser de YAML (nenhuma dependência), e a
 * validação completa contra `spec-connect-declaration.schema.json` vive no validador Python
 * (`connect_contracts.py`). Chamar isso de "válido" seria mentir — daí `connect_ready` só
 * afirmar "declarado com as chaves obrigatórias".
 */
export function assessConnectDeclaration(content: string | null): FactoryCertificate["connect"] {
  if (content === null) return { level: "absent", missing: CONNECT_REQUIRED_KEYS.slice() };
  const missing = CONNECT_REQUIRED_KEYS.filter((k) => !new RegExp(`^\\s{0,2}${k}\\s*:`, "m").test(content));
  return { level: missing.length === 0 ? "connect_ready" : "incomplete", missing };
}

function checksOf(rows: Array<[FactoryCheckId, string, boolean | null, string?]>): FactoryCertificateCheck[] {
  return rows.map(([id, label, ok, detail]) => ({ id, label, ok, ...(detail ? { detail } : {}) }));
}

/**
 * Deriva o certificado do projeto. Puro em relação ao banco (só leituras) e **sem** efeito
 * colateral: não valida, não escreve, não dispara nada (A4). Sem cache de propósito — ver a
 * justificativa em `computeFactoryCertificates`.
 */
export async function computeFactoryCertificate(db: Db, projectId: string): Promise<FactoryCertificate> {
  const gateEnforced = specValidationGateEnabled();
  const assessment: SpecValidationAssessment = await assessSpecValidation(db, projectId);
  const base = {
    specHash: assessment.specHash,
    caveats: [] as string[],
    gateEnforced,
    activeBlockers: assessment.activeBlockers,
    activeWarnings: assessment.activeWarnings,
  };

  // ── C1 — spec existe e é legível em disco ──────────────────────────────────
  if (assessment.specHash === null) {
    return {
      ...base,
      level: "blocked",
      code: "SPEC_FILES_MISSING",
      message: "Sem especificação legível em disco — a fábrica não tem o que fabricar.",
      checks: checksOf([["C1", "Spec legível em disco", false, "nenhum arquivo de spec legível"]]),
      connect: assessConnectDeclaration(null),
    };
  }

  // ── C2 — conteúdo real (anti-template), no MESMO arquivo que o dispatch lê ──
  // `is_primary DESC, created_at DESC LIMIT 1` é a ordem de `runnerDispatch.ts:83` — usar
  // outra escolha de arquivo faria o selo divergir do gate (A1).
  const primaryPath = (await db.query(
    "SELECT file_path FROM project_spec_files WHERE project_id = $1 ORDER BY is_primary DESC, created_at DESC LIMIT 1",
    [projectId],
  )).rows[0]?.file_path as string | undefined;
  const primary = assessment.files.find((f) => f.file_path === primaryPath) ?? null;
  const content = primary ? checkSpecContentReady(primary.content) : null;
  const connect = assessConnectDeclaration(
    assessment.files.find((f) => f.filename.toLowerCase() === "connect.yaml" && !(f.rel_dir ?? ""))?.content ?? null,
  );

  const c1: [FactoryCheckId, string, boolean | null, string?] = ["C1", "Spec legível em disco", true];
  const c2: [FactoryCheckId, string, boolean | null, string?] = content === null
    // Espelha o `catch` do dispatch (que não bloqueia por falha de leitura): indeterminado, não reprovado.
    ? ["C2", "Conteúdo real (não é template)", null, "arquivo primário não identificado"]
    : ["C2", "Conteúdo real (não é template)", content.ok, content.ok ? undefined : content.block.signals.join(", ")];

  if (content && !content.ok) {
    return {
      ...base,
      level: "blocked",
      code: content.block.code,
      message: "A especificação ainda é um modelo/rascunho em branco — preencha os requisitos antes de promover.",
      checks: checksOf([c1, c2]),
      connect,
    };
  }

  // ── C7 — tipo/stack declarados ─────────────────────────────────────────────
  const projectType = ((await db.query("SELECT extra->>'project_type' AS project_type FROM projects WHERE id = $1", [projectId]))
    .rows[0]?.project_type as string | null | undefined) ?? null;
  const c7: [FactoryCheckId, string, boolean | null, string?] = ["C7", "Tipo/stack declarados", !!projectType?.trim(),
    projectType?.trim() ? projectType.trim() : "extra.project_type vazio"];
  if (!projectType?.trim()) {
    return {
      ...base,
      level: "blocked",
      code: "PROJECT_TYPE_MISSING",
      message: "Tipo/stack do projeto não declarado — a fábrica escolheria o arquétipo no escuro.",
      checks: checksOf([c1, c2, c7]),
      connect,
    };
  }

  // ── C3 — validação adversarial do hash ATUAL ───────────────────────────────
  if (!assessment.run) {
    const hadRun = !!assessment.latestRun;
    const c3: [FactoryCheckId, string, boolean | null, string?] = ["C3", "Validação do conteúdo atual", false,
      hadRun ? "a spec foi editada depois da última validação" : "nunca validada"];
    return {
      ...base,
      level: hadRun ? "stale" : "unknown",
      code: "SPEC_NOT_VALIDATED",
      message: hadRun
        ? "Certificado vencido: a spec mudou desde a última validação — rode Validar novamente."
        : "Sem certificado: esta spec ainda não passou por Validar.",
      checks: checksOf([c1, c2, c7, c3, ["C4", "Zero GAP blocker ativo", null], ["C5", "Avisos reconhecidos", null]]),
      connect,
    };
  }

  const failed = assessment.run.status === "failed";
  const c3: [FactoryCheckId, string, boolean | null, string?] = ["C3", "Validação do conteúdo atual", true,
    `run ${assessment.run.id.slice(0, 8)} (${assessment.run.status})`];
  const c4: [FactoryCheckId, string, boolean | null, string?] = ["C4", "Zero GAP blocker ativo",
    assessment.block?.code === "SPEC_VALIDATION_BLOCKED" ? false : true,
    assessment.activeBlockers ? `${assessment.activeBlockers} blocker(s) ativo(s)` : "nenhum blocker ativo"];
  const c5: [FactoryCheckId, string, boolean | null, string?] = ["C5", "Avisos reconhecidos",
    assessment.block?.code === "SPEC_WARNINGS_UNACKED" ? false : true,
    assessment.activeWarnings ? `${assessment.activeWarnings} aviso(s) ativo(s)${assessment.acked ? " reconhecidos" : " sem ack"}` : "sem avisos"];
  const checks = checksOf([c1, c2, c7, c3, c4, c5]);

  // ── C4/C5 — o veredito é o do gate, sem reinterpretação ────────────────────
  if (assessment.block) {
    return {
      ...base,
      level: "blocked",
      code: assessment.block.code,
      message: assessment.block.message,
      checks,
      connect,
    };
  }

  // Passou. As ressalvas dizem POR QUE passou quando não foi limpo (A7).
  const caveats: string[] = [];
  if (failed && assessment.forcedByAdmin) caveats.push("validação reprovou e foi forçada por zentriz_admin (auditado)");
  else if (failed) caveats.push("os blockers foram triados como ignorados/refutados (auditado)");
  if (assessment.activeWarnings > 0 && assessment.acked) caveats.push(`${assessment.activeWarnings} aviso(s) reconhecido(s) por ack`);

  return {
    ...base,
    caveats,
    level: caveats.length ? "certified_with_acks" : "certified",
    code: null,
    message: caveats.length
      ? "Certificado com ressalvas: a spec está no formato aceito pela fábrica, com pendências reconhecidas por um humano."
      : "Certificado Genesis Factory: a spec está no formato que a fábrica aceita e passou a validação do conteúdo atual.",
    checks,
    connect,
  };
}

/**
 * Lote (PR2) — um certificado por projeto, com concorrência limitada.
 *
 * Por que NÃO tem cache nem prefetch (desvio consciente do §6 do doc, que previa cache
 * `(project_id, spec_hash)` no `ttlCache`):
 *  • o custo aqui é I/O local (ler as specs do disco + 4 queries curtas no Postgres do mesmo
 *    host) — nunca LLM. O medo de custo do doc era LLM, e o certificado não dispara validação;
 *  • qualquer cache abre uma janela em que o selo fica verde depois da edição — exatamente o
 *    "verde por inércia" que A5 proíbe. E a chave `(project_id, spec_hash)` não economiza o
 *    passo caro: para saber o hash é preciso ler o disco de qualquer forma;
 *  • um prefetch em lote precisaria repetir os WHERE/ORDER BY do caminho unitário → segunda
 *    implementação da mesma regra, que é o risco A1 voltando pela porta de trás.
 * Se uma tela ficar lenta, o caminho é medir e então batchar COM um teste que compare lote
 * contra unitário no mesmo fixture.
 */
export async function computeFactoryCertificates(
  db: Db,
  projectIds: string[],
  opts: { concurrency?: number } = {},
): Promise<Map<string, FactoryCertificate>> {
  const out = new Map<string, FactoryCertificate>();
  const ids = projectIds.slice();
  const workers = Math.max(1, Math.min(opts.concurrency ?? 6, 16));
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const id = ids.shift();
      if (!id) return;
      // Best-effort por projeto: um projeto problemático não pode apagar o selo dos outros.
      const cert = await computeFactoryCertificate(db, id).catch((e) => {
        console.warn(`[factory-certificate] ${id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (cert) out.set(id, cert);
    }
  }));
  return out;
}

/**
 * Agregado do produto (A6): **AND** — o produto só é certificado se TODOS os projetos
 * avaliados estiverem `certified`/`certified_with_acks`. Nunca porcentagem sozinha: o `n/m`
 * vai no texto, porque "20 de 22" parece "quase pronto" enquanto 2 blockers derrubam a
 * promoção do produto inteiro.
 */
export function aggregateProductCertificate(certs: FactoryCertificate[]): ProductFactoryCertificate {
  const total = certs.length;
  const withCaveats = certs.filter((c) => c.level === "certified_with_acks").length;
  const certified = certs.filter((c) => c.level === "certified").length + withCaveats;
  const blocked = certs.filter((c) => c.level === "blocked").length;
  const stale = certs.filter((c) => c.level === "stale").length;
  const unknown = certs.filter((c) => c.level === "unknown").length;
  const connectReady = certs.filter((c) => c.connect.level === "connect_ready").length;
  // Pior-vence: um único blocker define o produto. `stale` na frente de `unknown` porque
  // "havia certificado e venceu" é ação concreta (revalidar) — `unknown` é "nunca validou".
  const level: FactoryCertificateLevel =
    total === 0 ? "unknown"
    : blocked > 0 ? "blocked"
    : stale > 0 ? "stale"
    : unknown > 0 ? "unknown"
    : withCaveats > 0 ? "certified_with_acks"
    : "certified";
  const head =
    level === "certified" ? "Produto certificado pela fábrica"
    : level === "certified_with_acks" ? "Produto certificado com ressalvas"
    : level === "blocked" ? "Produto não certificado"
    : level === "stale" ? "Certificado do produto vencido"
    : "Produto sem certificado";
  return {
    level, certified, total, withCaveats, blocked, stale, unknown, connectReady,
    message: total === 0
      ? "Nenhum projeto de spec avaliado neste produto."
      : `${head} — ${certified}/${total} projetos certificados.`,
  };
}
