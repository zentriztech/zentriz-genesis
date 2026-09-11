import type { FastifyInstance, FastifyRequest } from "fastify";
import { spawn } from "child_process";
import path from "path";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { signToken } from "../auth.js";
import { claimSlotOrQueue, revertSlotClaim, getTenantLlmConfig } from "../services/tenantLlmConfig.js";
import { checkDependencyGate } from "../services/dependencyGate.js";
import { checkSpecContentReady } from "../services/specContentGate.js";
import { graduateFromInbox, demoteToInbox } from "../services/inbox.js";
import { scheduleFactoryStart } from "../services/opsNotify.js";
import { checkTenantBudget, budgetExceededMessage } from "../services/tenantCostCap.js";
// Migração 097: promover (admitir sem iniciar) recomputa o ciclo de vida do produto e conta como
// evento de valor Bancada→fábrica — os dois eram exclusivos do /run e da promoção de produto.
import { recomputeProductLifecycle } from "../services/productLifecycle.js";
import { emitValueEvent } from "../services/valueEvents.js";
// RFC-0008 emenda 01 (2026-09-11): nada entra na fábrica sem documento de decisão. O `/promote` de
// PRODUTO já tinha a trava; este caminho atômico não tinha — e é justamente o que o Jean usa.
import {
  isProjectNormalized, normalizeProject, NormalizationError, debitNormalizerUsage,
} from "../services/productNormalizer.js";
// O veredito de "posso promover?" é do SERVIDOR (achado do Jean 2026-09-11: três telas decidiam
// sozinhas e divergiram) — ver `services/promotability.ts`.
import { decideSpecPromotability } from "../services/promotability.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

// Simple in-memory sliding-window rate limiter for /run (per tenant or per user)
// Limit: MAX_RUN_CALLS_PER_WINDOW calls within WINDOW_MS
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RUN_RATE_LIMIT_WINDOW_MS ?? "60000", 10); // 60s
const RATE_LIMIT_MAX_CALLS = parseInt(process.env.RUN_RATE_LIMIT_MAX_CALLS ?? "5", 10); // 5 calls/min
const _runCallTimestamps = new Map<string, number[]>(); // key: tenantId or userId → timestamps

function checkRunRateLimit(key: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const calls = (_runCallTimestamps.get(key) ?? []).filter((t) => t > windowStart);
  if (calls.length >= RATE_LIMIT_MAX_CALLS) {
    const oldest = calls[0];
    return { allowed: false, retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - oldest) };
  }
  calls.push(now);
  _runCallTimestamps.set(key, calls);
  return { allowed: true, retryAfterMs: 0 };
}

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

async function checkProjectAccess(
  client: { query: (q: string, p?: string[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
  user: AuthUser
): Promise<boolean> {
  const result = await client.query("SELECT tenant_id, created_by FROM projects WHERE id = $1", [projectId]);
  const row = result.rows[0];
  if (!row) return false;
  return canAccessProjectRow(user, row);
}

const ALLOWED_STATUS_FOR_RUN = new Set([
  "draft",
  "spec_submitted",
  "pending_conversion",
  "cto_charter",
  "pm_backlog",
  "stopped",
  "failed",
  // RFC-0003 (Task 3): 'queued' é elegível para /run — o drainer do watchdog (G39) re-chama
  // /run nos projetos enfileirados quando abre slot; sem isto eles nunca sairiam da fila. O
  // claim atômico reserva o slot (ou re-enfileira se ainda não houver).
  "queued",
  // Migração 097: `promoted` = produto promovido em bloco, esperando início explícito. Sem isto o
  // /start do produto (e o botão "Iniciar") bateria em 409 no próprio estado que a promoção cria.
  "promoted",
]);

/**
 * Retorna o file_path do primeiro arquivo .md do projeto (para uso pelo runner).
 * Se não houver .md, retorna null.
 */
async function getProjectSpecFilePath(
  client: { query: (q: string, p?: string[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string
): Promise<string | null> {
  const result = await client.query(
    `SELECT file_path FROM project_spec_files
     WHERE project_id = $1 AND LOWER(filename) LIKE '%.md'
     ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    [projectId]
  );
  const row = result.rows[0];
  if (row && typeof row.file_path === "string") return row.file_path;
  return null;
}

export async function pipelineRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // Evoluir E3 (adversarial F): o tenant precisa do MODELO de RFC para escrever `docs/rfc/RFC-NNNN-<slug>.md`
  // na Bancada — o caminho do repositório não serve ao cliente. Vendorizado em src/assets (vai na imagem).
  app.get("/api/spec-templates/rfc", async (_request, reply) => {
    const { loadRfcTemplate, RFC_DIR } = await import("../services/evolutionGate.js");
    const content = loadRfcTemplate();
    if (!content) return reply.code(404).send({ error: "TEMPLATE_UNAVAILABLE", message: "Modelo de RFC não encontrado nesta instalação." });
    return reply.send({ kind: "rfc", dir: RFC_DIR, suggested_filename: "RFC-0001-<slug>.md", content });
  });

  // ── POST /api/projects/:id/promote — ADMITE a spec na fábrica SEM iniciar (migração 097) ──
  //
  // Requisito do Jean (2026-09-06): "os projetos devem ser promovidos a fabrica mas nao inciados
  // automaticamente". Para um PRODUTO isso é `POST /api/products/:id/promote` (que também decide a
  // ORDEM das ondas com um agente). Esta rota é o caso ATÔMICO: uma spec solta (INBOX) ou um único
  // projeto — não há ordem a decidir, então não há chamada de LLM nem custo.
  //
  // Diferença do `/run`: aqui NADA é disparado — nenhum slot é reservado, nenhum runner é chamado.
  // O projeto fica em `status='promoted'`, estado inerte (o watchdog G39 só drena `queued`), e sai
  // dele por um pedido EXPLÍCITO (`/run`, ou o `Iniciar` do portal). Gates aplicados aqui são só os
  // que custam zero e não dependem de predecessor: existência de spec `.md` e o gate de conteúdo
  // (spec ainda template/placeholder). O gate de dependência NÃO se aplica: admitir todo mundo em
  // ordem é justamente o que a promoção faz — a barreira entre ondas vive no início, não na admissão.
  app.post<{ Params: { id: string } }>("/api/projects/:id/promote", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const project = (await client.query(
        "SELECT status, product_id, title, created_by FROM projects WHERE id = $1", [projectId],
      )).rows[0];
      if (!project) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const status = String(project.status);
      // Idempotente: promover duas vezes não é erro (o portal pode ter a lista velha em tela).
      if (status === "promoted") {
        return reply.send({ ok: true, status: "promoted", productId: project.product_id ?? null, graduated: false, alreadyPromoted: true });
      }
      if (status !== "draft") {
        return reply.status(409).send({
          code: "NOT_ON_WORKBENCH",
          message: `Só um rascunho pode ser promovido (estado atual: "${status}").`,
        });
      }
      const specFilePath = await getProjectSpecFilePath(client, projectId);
      if (!specFilePath) {
        return reply.status(400).send({
          code: "BAD_REQUEST",
          message: "Adicione uma spec em Markdown ao projeto antes de promovê-lo à fábrica.",
        });
      }
      // Gate de conteúdo (incidente Cabral 2026-08-29): não admite template/placeholder na fábrica.
      // Falha de leitura não bloqueia (a existência já foi checada acima) — mesmo racional do /run.
      try {
        const { readFileSync } = await import("fs");
        const contentGate = checkSpecContentReady(readFileSync(specFilePath).toString("utf8"));
        if (!contentGate.ok) return reply.status(422).send(contentGate.block);
      } catch (err) {
        request.log.warn({ projectId, err: String(err) }, "[Pipeline/promote] gate de conteúdo: falha ao ler spec (ignorado)");
      }

      // ⚠️ TRAVA DE NORMALIZAÇÃO (RFC-0008 emenda 01). O carimbo é `extra.normalized_hash` e vale
      // para a spec que o projeto tem AGORA: editou depois de normalizar, retrava sozinho. A trava
      // NUNCA degrada em silêncio — se não der para avaliá-la, o promote falha alto (o `.catch(()=>[])`
      // do caminho de produto provou que engolir o erro vira promoção sem documento, sem ninguém ver).
      {
        let norm: Awaited<ReturnType<typeof isProjectNormalized>>;
        try {
          norm = await isProjectNormalized(client, projectId);
        } catch (err) {
          request.log.error({ err, projectId }, "[Pipeline/promote] falha ao avaliar a trava de normalização");
          return reply.status(500).send({
            code: "NORMALIZATION_CHECK_FAILED",
            message: "Não foi possível verificar se esta spec está documentada. Tente de novo.",
          });
        }
        if (!norm.normalized) {
          return reply.status(409).send({
            code: "NOT_NORMALIZED",
            message: norm.storedHash
              ? "A spec mudou depois de normalizada. Clique em Normalizar de novo para atualizar os documentos de decisão."
              : "Esta spec ainda não foi normalizada. Clique em Normalizar — a Bancada escreve o RFC e o registro de decisão, e só então a promoção libera.",
            storedHash: norm.storedHash,
            currentHash: norm.currentHash,
          });
        }
      }

      // §4.11 (migração 064): um App que ENTRA na fábrica não pode viver no INBOX. Promover é
      // entrar — então gradua para o produto homônimo aqui, e não só no /run. Falha ⇒ 500 e o
      // projeto continua rascunho (nada meio-promovido).
      const tenantId = user.tenantId ?? "";
      let graduatedSolo: string | null = null;
      if (tenantId && project.product_id) {
        const prod = await client.query("SELECT is_inbox FROM products WHERE id = $1", [project.product_id]);
        if ((prod.rows[0] as { is_inbox?: boolean } | undefined)?.is_inbox === true) {
          try {
            graduatedSolo = await graduateFromInbox(client, {
              projectId, tenantId, createdBy: String(project.created_by), title: String(project.title ?? projectId),
            });
          } catch (err) {
            request.log.error({ err, projectId }, "[Pipeline/promote] falha ao graduar App do INBOX");
            return reply.status(500).send({ code: "GRADUATION_FAILED", message: "Falha ao promover o App para produto próprio." });
          }
        }
      }
      await client.query(
        "UPDATE projects SET status = 'promoted', updated_at = now() WHERE id = $1 AND status = 'draft'", [projectId],
      );
      const productId = graduatedSolo ?? (project.product_id as string | null) ?? null;
      // Sem isto o produto continuaria 'draft' e o portal não ofereceria "Iniciar produto".
      await recomputeProductLifecycle(client, productId);
      // Value meter: promoção Bancada→fábrica (o /run não emite este evento — só a promoção).
      void emitValueEvent(pool, {
        tenantId: user.tenantId ?? null,
        eventType: "spec_promoted",
        metadata: { project_id: projectId, product_id: productId, scope: "project", started: false },
      });
      request.log.info({ projectId, productId, graduated: !!graduatedSolo }, "[Pipeline/promote] spec admitida na fábrica (não iniciada)");
      return reply.send({ ok: true, status: "promoted", productId, graduated: !!graduatedSolo });
    } finally {
      client.release();
    }
  });

  // ── POST /api/projects/:id/normalize — [Normalizar] no escopo de UMA spec ──
  //
  // Contraparte do `POST /api/products/:id/normalize` para o caminho atômico. É esta a rota do
  // rascunho solto no INBOX: o produto "Rascunhos" não é normalizável (os rascunhos não têm relação
  // entre si), mas a spec É. O carimbo fica em `projects.extra.normalized_hash` e é o mesmo que o
  // caminho de produto grava — um conceito só de "documentado", escrito pelos dois lados.
  app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
    "/api/projects/:id/normalize",
    async (request, reply) => {
      const user = getUser(request);
      const { id: projectId } = request.params;
      const force = (request.body ?? {}).force === true;
      const client = await pool.connect();
      try {
        const allowed = await checkProjectAccess(client, projectId, user);
        if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        const row = (await client.query(
          `SELECT p.id, p.status, p.tenant_id, p.product_id, p.title,
                  pr.name AS product_name, pr.system_id, pr.description
             FROM projects p LEFT JOIN products pr ON pr.id = p.product_id
            WHERE p.id = $1`,
          [projectId],
        )).rows[0];
        if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        // ⚠️ Documentar NÃO depende de estar na Bancada (achado do Jean, 2026-09-11). O recorte por
        // status condenava tudo que já tinha saído para a Fábrica a nunca ter RFC/ADR. Normalizar
        // não muda status — escreve documento. Quem exige `draft` é o promote, que é quem MOVE.
        //
        // A única guarda que resta é a corrida com o executor: a escrita em `docs/**` re-carimba
        // `extra.spec_hash`, e o runner valida esse hash no meio da run (runner.py:5791) — abortaria
        // com `spec_validation_failed`. Então: run em voo NESTE projeto ⇒ recusa declarada.
        {
          const inFlight = (await client.query(
            "SELECT 1 FROM pipeline_runs WHERE project_id = $1 AND finished_at IS NULL LIMIT 1",
            [projectId],
          )).rowCount ?? 0;
          if (inFlight > 0) {
            return reply.status(409).send({
              code: "RUN_IN_FLIGHT",
              message:
                "A Fábrica está executando esta spec agora. Normalizar escreveria na spec debaixo " +
                "da run e a abortaria — espere a execução terminar.",
            });
          }
        }
        const tenantId = (row.tenant_id as string | null) ?? null;
        // Orçamento antes de gastar token — normalizar é uma chamada de LLM.
        if ((process.env.PROPOSAL_BUDGET_GATE ?? "off").toLowerCase() === "on" && tenantId) {
          const budget = await checkTenantBudget(pool, tenantId);
          if (!budget.ok) {
            return reply.status(429).send({ code: "BUDGET_EXCEEDED", message: budgetExceededMessage(budget.spentUsd, budget.budgetUsd) });
          }
        }
        let outcome;
        try {
          outcome = await normalizeProject(pool, {
            projectId,
            productId: (row.product_id as string | null) ?? projectId,
            // O INBOX chama-se "Rascunhos" para todo mundo; o nome útil ao agente é o da própria spec.
            productName: String(row.title ?? row.product_name ?? "Spec"),
            systemId: (row.system_id as string | null) ?? null,
            description: (row.description as string | null) ?? null,
            tenantId,
            force,
          });
        } catch (e) {
          if (e instanceof NormalizationError) {
            request.log.warn({ projectId, code: e.code }, "[Pipeline/normalize] normalização recusada");
            // Mesmo no erro o token já foi gasto — debitar aqui evita o ponto cego do cost cap.
            if (e.usage) {
              void debitNormalizerUsage(pool, {
                productId: (row.product_id as string | null) ?? projectId, projectId: e.usage.projectId,
                inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, model: e.usage.model,
              });
            }
            return reply.status(422).send({ code: e.code, message: e.message, details: e.details });
          }
          throw e;
        }
        if (outcome.status === "already_normalized") {
          return reply.status(200).send({
            projectId, status: "already_normalized", normalized: true,
            message: "A spec não mudou desde a última normalização — nada a refazer.",
          });
        }
        const r = outcome.result!;
        // O escopo PROJETO não debitava nada (só o de produto debitava) — e é o caminho mais usado.
        void debitNormalizerUsage(pool, {
          productId: (row.product_id as string | null) ?? projectId, projectId,
          inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: r.modelUsed,
        });
        void emitValueEvent(pool, {
          tenantId,
          eventType: "spec_normalized",
          metadata: { project_id: projectId, scope: "project", documents: r.written.length, model: r.modelUsed },
        });
        return reply.status(200).send({
          projectId,
          status: "normalized",
          normalized: true,
          summary: r.summary,
          written: r.written,
          warnings: r.warnings,
          truncated: r.truncated,
          rfcProblems: r.rfcProblems,
          modelUsed: r.modelUsed,
        });
      } finally {
        client.release();
      }
    },
  );

  // GET /api/projects/:id/normalized — a UI pergunta ao SERVIDOR se pode mostrar o Promover.
  //
  // Devolve o VEREDITO inteiro (`promotion`), não só o carimbo: a tela não tem como saber que
  // promover uma spec fora de `draft` é impossível, e foi assim que o botão apareceu habilitado
  // para o Jean num produto `running`. Quem decide é aqui; a tela só mostra o motivo.
  app.get<{ Params: { id: string } }>("/api/projects/:id/normalized", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const row = (await client.query(
        "SELECT status, extra FROM projects WHERE id = $1", [projectId],
      )).rows[0] as { status: string | null; extra: Record<string, unknown> | null } | undefined;
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      let st: Awaited<ReturnType<typeof isProjectNormalized>> | null = null;
      try {
        st = await isProjectNormalized(client, projectId);
      } catch (err) {
        request.log.warn({ err, projectId }, "[Pipeline/normalized] falha ao conferir o carimbo");
      }
      // O veredito reaproveita a conferência acima — perguntar de novo leria o disco duas vezes na
      // MESMA requisição. `st === null` (a conferência falhou) ⇒ `normalized: null` ⇒ `canPromote`
      // nulo ⇒ a tela mantém o botão: erro nosso não esconde função do usuário.
      const promotion = decideSpecPromotability(row.status ?? null, st ? st.normalized : null);
      return reply.send({
        projectId,
        normalized: st ? st.normalized : null,
        storedHash: st?.storedHash ?? null,
        currentHash: st?.currentHash ?? null,
        promotion,
      });
    } finally {
      client.release();
    }
  });

  // ── POST /api/projects/:id/oracle — 🔴 F3: o ORÁCULO EXECUTÁVEL (item 3A) ────────────────────
  //
  // A Fábrica constrói o produto, o executor isolado (Host B, `/run-tests`) RODA a suíte, e o
  // resultado REAL volta por aqui para decidir as constraints declaradas que o juiz de spec não tem
  // como julgar. Medido na spec do NVX LastMile: das 119 constraints derivadas, **0 são `spec`** —
  // 62 são `build` e 57 `runtime`. Sem esta rota, 119 de 119 ficam `pending` para sempre, e uma
  // constraint pendente eternamente é uma política que nunca foi cobrada.
  //
  // Quem julga é o AGENTE, recebendo a saída verbatim (Lei do Jean: nada de automação fixa). Esta
  // rota só transporta o fato, e recusa payload que não prova execução. Direção única: veredicto de
  // oráculo só ACRESCENTA impedimento — nenhum caminho aqui torna promovível o que os GAPs barravam.
  app.post<{ Params: { id: string } }>("/api/projects/:id/oracle", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    const body = (request.body ?? {}) as { result?: unknown; spec_hash?: string; validation_run_id?: string };
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const { oracleEnabled, runSpecOracle, normalizeOracleRun, oracleOutcome, oracleEnvSha } =
        await import("../services/specOracle.js");
      if (!oracleEnabled()) {
        return reply.send({ ok: true, ran: false, reason: "SPEC_ORACLE != on" });
      }
      // A spec contra a qual medir é a que TEM constraints derivadas — é a única que o oráculo pode
      // decidir. O runner não conhece esse hash, então quem resolve é a api (e o hash volta na
      // resposta: medição sem dizer o que foi medido é a família do log mentiroso, GAP-45/46).
      const informado = String(body.spec_hash ?? "").trim();
      const specHash = informado || String((await client.query(
        "SELECT spec_hash FROM spec_constraints WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
        [projectId],
      )).rows[0]?.spec_hash ?? "");
      if (!specHash) {
        return reply.send({ ok: true, ran: false, reason: "nenhuma constraint declarada para este projeto — o Policy Gate não rodou ainda" });
      }
      // Payload que não prova execução é recusado NA CARA, com o motivo — 200 mudo aqui viraria
      // "medi e não achei nada" no log do runner, que é a família do log mentiroso (GAP-45/46).
      const norm = normalizeOracleRun(body.result ?? request.body);
      if (!norm.ok) {
        return reply.status(400).send({ code: "ORACLE_PAYLOAD_INVALID", message: norm.why });
      }
      const files = (await client.query(
        "SELECT rel_dir, filename FROM project_spec_files WHERE project_id = $1 ORDER BY created_at ASC", [projectId],
      )).rows.map((r) => {
        const row = r as { rel_dir?: unknown; filename?: unknown };
        const dir = String(row.rel_dir ?? "").trim();
        return `${dir ? dir + "/" : ""}${String(row.filename ?? "")}`;
      }).filter((f) => f && f !== "/");
      // Julgar 119 constraints custa N passes de LLM (minutos). Prender o runner nisso o faria bater
      // no timeout de 15s do cliente e registrar FALHA num julgamento que estava dando certo. Então:
      // o fato é ACEITO aqui e julgado em segundo plano. Os veredictos vão para `spec_policy_verdicts`
      // e os GAPs para `spec_oracle_runs.findings` — de onde a validação seguinte os une (estágio O).
      void runSpecOracle(pool, {
        projectId, specHash, raw: body.result ?? request.body, specFiles: files,
        validationRunId: String(body.validation_run_id ?? "") || null,
      }).then((res) => {
        request.log.info(
          { projectId, specHash: specHash.slice(0, 12), ran: res.ran, outcome: res.outcome,
            judged: res.judged, pending: res.pending, blocking: res.tally.blocking,
            findings: res.findings.length, note: res.note },
          "[Pipeline/oracle] execução real julgada contra as constraints declaradas",
        );
      }).catch((err) => {
        request.log.error({ err, projectId }, "[Pipeline/oracle] julgamento em segundo plano falhou");
      });
      return reply.code(202).send({
        ok: true, accepted: true, specHash, outcome: oracleOutcome(norm.run),
        envSha: oracleEnvSha(norm.run), specFiles: files.length,
      });
    } catch (err) {
      request.log.error({ err, projectId }, "[Pipeline/oracle] falha ao julgar a execução real");
      // Fail-CLOSED: oráculo que não roda não muda nada, e o motivo é DECLARADO ao chamador.
      return reply.status(500).send({ code: "ORACLE_FAILED", message: "Falha ao julgar a execução real contra as constraints." });
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/run", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    request.log.info({ projectId, userId: user.id }, "[Pipeline] POST /run recebido");
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) {
        request.log.warn({ projectId }, "[Pipeline] Acesso negado (projeto não encontrado ou sem permissão)");
        return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      }

      // Rate limit: 5 /run calls per minute per tenant (or per user if no tenant)
      const rateLimitKey = user.tenantId ?? user.id;
      const rl = checkRunRateLimit(rateLimitKey);
      if (!rl.allowed) {
        request.log.warn({ projectId, rateLimitKey }, "[Pipeline] Rate limit atingido no /run");
        return reply.status(429).send({
          code: "RATE_LIMITED",
          message: `Muitas tentativas de iniciar pipeline. Aguarde ${Math.ceil(rl.retryAfterMs / 1000)}s antes de tentar novamente.`,
        });
      }

      // ── Cost cap mensal de LLM por TENANT (migration 068, anti denial-of-wallet) ──
      // Após o rate-limit e ANTES do claim de slot: barra o run de graça (custo zero de
      // LLM) quando o tenant já estourou o orçamento do mês. Fail-safe: sem cap
      // configurado (tenant/plano/env) ⇒ comportamento atual; erro de infra ⇒ fail-open
      // (checkTenantBudget nunca lança — ver racional em services/tenantCostCap.ts).
      if (user.tenantId) {
        const budget = await checkTenantBudget(client, user.tenantId);
        if (!budget.ok) {
          request.log.warn(
            { projectId, tenantId: user.tenantId, spentUsd: budget.spentUsd, budgetUsd: budget.budgetUsd },
            "[Pipeline] Bloqueado pelo cap mensal de LLM do tenant"
          );
          return reply.status(402).send({
            code: "TENANT_LLM_BUDGET_EXCEEDED",
            message: budgetExceededMessage(budget.spentUsd, budget.budgetUsd),
          });
        }
      }

      const projectRow = await client.query(
        "SELECT status, product_id, title, created_by FROM projects WHERE id = $1",
        [projectId]
      );
      const project = projectRow.rows[0];
      if (!project) {
        request.log.warn({ projectId }, "[Pipeline] Projeto não existe");
        return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      }
      const status = project.status as string;
      if (!ALLOWED_STATUS_FOR_RUN.has(status)) {
        request.log.warn({ projectId, status }, "[Pipeline] Status não permite run");
        return reply.status(409).send({
          code: "CONFLICT",
          message: `Pipeline não pode ser iniciado com status "${status}". Use um projeto com spec enviada (draft, spec_submitted, pending_conversion, cto_charter ou pm_backlog).`,
        });
      }

      // ── Gate de dependência + contrato (I-4) ─────────────────────────────────
      // RFC-0003 (G3/C3): regra centralizada em services/dependencyGate.ts, compartilhada
      // com a cascata/promoção (dispatchProjectRun) — antes só o /run a aplicava.
      const gate = await checkDependencyGate(client, projectId);
      if (!gate.ok) {
        request.log.warn({ projectId, code: gate.block.code }, "[Pipeline] Bloqueado pelo gate de dependência");
        return reply.status(409).send(gate.block);
      }

      // RFC-0004 Onda 3 (F4): gate de VALIDAÇÃO — o /run inline NÃO passa pelo
      // dispatchProjectRun (fluxo próprio), então chama a MESMA função compartilhada
      // (mesmo padrão do checkDependencyGate acima). Env-flag OFF por padrão.
      {
        const { checkSpecValidationGate } = await import("../services/specValidation.js");
        const vGate = await checkSpecValidationGate(client, projectId);
        if (!vGate.ok) {
          request.log.warn({ projectId, code: vGate.code }, "[Pipeline] Bloqueado pelo gate de validação de spec");
          return reply.status(409).send({ code: vGate.code, message: vGate.message });
        }
      }

      // Evoluir E3: promoção de EVOLUÇÃO exige RFC válido na Bancada (Gherkin + files_allowed) e grava
      // evolution_rfcs/evolution_scope/evolution_request sintetizado — o escopo é o gate do E4.
      {
        const extraRow = (await client.query("SELECT extra FROM projects WHERE id = $1", [projectId])).rows[0];
        const { evaluateEvolutionGate } = await import("../services/evolutionGate.js");
        const eGate = await evaluateEvolutionGate(client, projectId, (extraRow?.extra as Record<string, unknown> | null) ?? null);
        if (!eGate.ok) {
          request.log.warn({ projectId, code: eGate.code }, "[Pipeline] Bloqueado pelo gate de evolução (RFC)");
          return reply.status(409).send({ code: eGate.code, message: eGate.message, details: eGate.details });
        }
        if (eGate.applied) {
          request.log.info({ projectId, rfcs: eGate.rfcs, scope: eGate.scope.length, compat: eGate.compat }, "[Pipeline] Evolução: RFC(s) validados, escopo gravado");
        }
      }

      const specFilePath = await getProjectSpecFilePath(client, projectId);
      if (!specFilePath) {
        request.log.warn({ projectId }, "[Pipeline] Sem arquivo .md no projeto (project_spec_files vazio ou sem .md)");
        return reply.status(400).send({
          code: "BAD_REQUEST",
          message: "Adicione uma spec em Markdown ao projeto para iniciar o pipeline.",
        });
      }
      // Gate de CONTEÚDO (incidente Cabral 2026-08-29): barra spec-template/placeholder ANTES de
      // reservar slot e chamar o runner — custo ZERO de LLM. Mensagem acionável ao usuário.
      try {
        const { readFileSync } = await import("fs");
        const specText = readFileSync(specFilePath).toString("utf8");
        const contentGate = checkSpecContentReady(specText);
        if (!contentGate.ok) {
          request.log.warn(
            { projectId, signals: contentGate.block.signals },
            "[Pipeline] Bloqueado pelo gate de conteúdo (spec ainda é template/placeholder)"
          );
          return reply.status(422).send(contentGate.block);
        }
      } catch (err) {
        // Falha ao ler o arquivo não bloqueia aqui — a checagem de existência acima já cobre
        // ausência de spec; o validador de intake do runner cobre o restante.
        request.log.warn({ projectId, err: String(err) }, "[Pipeline] Gate de conteúdo: falha ao ler spec (ignorado)");
      }

      request.log.info({ projectId, specPath: specFilePath.slice(0, 120) }, "[Pipeline] Spec encontrada, disparando runner");

      // G38: Resolve LLM config do tenant (usa conta própria se configurada)
      const tenantId = user.tenantId ?? "";
      const llmConfig = tenantId ? await getTenantLlmConfig(tenantId) : null;
      if (llmConfig) {
        request.log.info({ projectId, provider: llmConfig.provider, model: llmConfig.modelId },
          "[G38] Usando LLM config do tenant");
      } else {
        // ⚖️ LEI 2026-09-10: sem slot utilizável não há default de env. O dispatch falharia adiante
        // com uma mensagem opaca; barrar aqui devolve ao usuário a ação concreta.
        request.log.warn({ projectId, tenantId }, "[G38] Tenant sem slot de LLM utilizável — dispatch barrado");
        return reply.status(422).send({
          ok: false,
          error: "LLM_SLOT_NOT_CONFIGURED",
          message: "Nenhum slot de LLM utilizável. Configure um provider com credenciais próprias em Configurações → LLM.",
        });
      }

      // G39 / RFC-0003 (C2): claim ATÔMICO de slot de concorrência (substitui o enqueueOrStart
      // TOCTOU). Reserva o slot marcando 'running' sob advisory-lock por tenant; se não houver
      // slot, enfileira. previousStatus permite reverter se o dispatch subsequente falhar.
      let slotPreviousStatus: string | null = null;
      if (tenantId) {
        const claim = await claimSlotOrQueue(projectId, tenantId);
        if (claim.outcome === "queued") {
          request.log.info({ projectId, tenantId }, "[G39] Projeto enfileirado — tenant atingiu máximo de concorrência");
          return reply.send({
            ok: true,
            status: "queued",
            message: "Pipeline enfileirado. Será iniciado automaticamente quando houver slot disponível.",
          });
        }
        slotPreviousStatus = claim.previousStatus;
      }

      // ── §4.11 (migration 064): auto-graduação do INBOX (saga com compensação) ────
      // Um App que ENTRA NA FÁBRICA não pode viver no INBOX (invariante 064). Se a spec
      // ainda está no inbox, cria/reusa o produto HOMÔNIMO (solo) e move o App para lá
      // ANTES do dispatch. Se o dispatch falhar depois, `compensateGraduation` reverte
      // (demoteToInbox: volta o App ao inbox e remove o produto solo recém-criado vazio).
      let graduatedSolo: string | null = null;
      const compensateGraduation = async () => {
        if (!graduatedSolo || !tenantId) return;
        await demoteToInbox(client, {
          projectId, tenantId, createdBy: String(project.created_by), soloProductId: graduatedSolo,
        }).catch((e) => request.log.error({ e, projectId }, "[Pipeline §4.11] compensação de graduação falhou"));
      };
      if (tenantId && project.product_id) {
        try {
          const prod = await client.query("SELECT is_inbox FROM products WHERE id = $1", [project.product_id]);
          if ((prod.rows[0] as { is_inbox?: boolean } | undefined)?.is_inbox === true) {
            graduatedSolo = await graduateFromInbox(client, {
              projectId, tenantId, createdBy: String(project.created_by), title: String(project.title ?? projectId),
            });
            request.log.info({ projectId, soloProductId: graduatedSolo }, "[Pipeline §4.11] App graduou do INBOX para produto homônimo");
          }
        } catch (err) {
          request.log.error({ err, projectId }, "[Pipeline §4.11] Falha ao graduar App do INBOX");
          await revertSlotClaim(projectId, slotPreviousStatus);
          return reply.status(500).send({ code: "GRADUATION_FAILED", message: "Falha ao promover o App para produto próprio." });
        }
      }

      const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
      const token = signToken(
        {
          sub: user.id,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId,
          // Token de máquina: isenta os callbacks do runner do gate de suspensão H3 (RFC H1).
          svc: "runner",
          // T1: amarra o token a ESTE projeto — o endpoint interno de llm-config recusa
          // se o token for usado para ler a chave de outro projeto (defesa em profundidade).
          projectId,
        },
        "24h"
      );

      const runEnv = {
        ...process.env,
        API_BASE_URL: apiBaseUrl,
        PROJECT_ID: projectId,
        GENESIS_API_TOKEN: token,
        CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ?? "",
        API_AGENTS_URL: process.env.API_AGENTS_URL ?? "",
      };

      const runnerCommand = process.env.RUNNER_COMMAND?.trim();
      if (runnerCommand) {
        const parts = runnerCommand.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          return reply.status(500).send({
            code: "RUNNER_ERROR",
            message: "RUNNER_COMMAND está vazio ou inválido.",
          });
        }
        const executable = parts[0];
        const args = [...parts.slice(1), "--spec-file", specFilePath];
        const child = spawn(executable, args, {
          env: runEnv,
          detached: true,
          stdio: "ignore",
          cwd: process.env.REPO_ROOT ?? process.cwd(),
        });
        // spawn de binário inexistente emite 'error' (ENOENT) de forma ASSÍNCRONA; sem este
        // listener o evento viraria uncaughtException (não há handler global) → crash da API.
        // Como já respondemos 202 abaixo, aqui só logamos, marcamos o projeto como failed e
        // liberamos o slot reservado no claim atômico.
        child.on("error", (err) => {
          console.error(`[Pipeline] Falha ao iniciar runner local '${executable}':`, err);
          pool.query("UPDATE projects SET status='failed', updated_at=now() WHERE id=$1", [projectId]).catch(() => {});
          revertSlotClaim(projectId, slotPreviousStatus).catch(() => {});
        });
        child.unref();
        await client.query(
          "UPDATE projects SET status = $1, started_at = now(), updated_at = now(), stopped_by = NULL WHERE id = $2",
          ["running", projectId]
        );
        scheduleFactoryStart(pool, projectId, { origin: "interactive" });
        return reply.status(202).send({
          ok: true,
          message: "Pipeline iniciado. O diálogo será atualizado em breve.",
          status: "running",
        });
      }

      const runnerServiceUrl = process.env.RUNNER_SERVICE_URL?.trim();
      if (runnerServiceUrl) {
        try {
          request.log.info({ projectId, runnerUrl: runnerServiceUrl }, "[Pipeline] Chamando runner service");
          // When RUNNER_UPLOAD_DIR is set, the runner is in Docker and uses a
          // different path than the host. Translate specPath to the runner's path,
          // or fall back to specContent (base64) so the runner writes a temp file.
          const runnerUploadDir = process.env.RUNNER_UPLOAD_DIR?.trim();
          let runBody: Record<string, string>;
          if (runnerUploadDir && specFilePath.startsWith(UPLOAD_DIR)) {
            const relative = specFilePath.slice(UPLOAD_DIR.length);
            runBody = { projectId, specPath: `${runnerUploadDir}${relative}`, apiBaseUrl, token };
          } else {
            // Encode spec as base64 — works regardless of path differences
            const { readFileSync } = await import("fs");
            const specB64 = readFileSync(specFilePath).toString("base64");
            runBody = { projectId, specContent: specB64, apiBaseUrl, token };
          }
          const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(runBody),
          });
          if (res.status >= 200 && res.status < 300) {
            await client.query(
              "UPDATE projects SET status = $1, started_at = now(), updated_at = now(), stopped_by = NULL WHERE id = $2",
              ["running", projectId]
            );
            scheduleFactoryStart(pool, projectId, { origin: "interactive" });
            request.log.info({ projectId }, "[Pipeline] Runner iniciado com sucesso (202)");
            return reply.status(202).send({
              ok: true,
              message: "Pipeline iniciado. O diálogo será atualizado em breve.",
              status: "running",
            });
          }
          const text = await res.text();
          request.log.error({ projectId, runnerStatus: res.status, body: text.slice(0, 300) }, "[Pipeline] Runner retornou erro");
          // RFC-0003 (C2): dispatch falhou → libera o slot reservado no claim atômico.
          await revertSlotClaim(projectId, slotPreviousStatus);
          await compensateGraduation(); // §4.11: desfaz a graduação (App volta ao inbox)
          return reply.status(500).send({
            code: "RUNNER_ERROR",
            message: text || `Serviço runner retornou ${res.status}`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          request.log.error({ err, projectId }, "[Pipeline] Falha ao chamar runner");
          await revertSlotClaim(projectId, slotPreviousStatus);
          await compensateGraduation(); // §4.11: desfaz a graduação (App volta ao inbox)
          return reply.status(500).send({
            code: "RUNNER_ERROR",
            message: `Falha ao chamar serviço runner: ${message}`,
          });
        }
      }

      request.log.warn("[Pipeline] Nenhum runner configurado (RUNNER_COMMAND e RUNNER_SERVICE_URL vazios)");
      await revertSlotClaim(projectId, slotPreviousStatus);
      await compensateGraduation(); // §4.11: desfaz a graduação (App volta ao inbox)
      return reply.status(503).send({
        code: "SERVICE_UNAVAILABLE",
        message: "Nenhum runner configurado. Defina RUNNER_COMMAND ou RUNNER_SERVICE_URL.",
      });
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/stop", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    const client = await pool.connect();

    const _postStopDialogue = async () => {
      // Posta mensagem final no diálogo independente do runner — usuário sempre vê "Projeto parado"
      try {
        await client.query(
          `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
           VALUES ($1, 'system', 'system', 'step',
           '🛑 Projeto parado pelo usuário. Para retomar, clique em Reiniciar.')`,
          [projectId]
        );
      } catch { /* não crítico */ }
    };

    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

      // Migração 097 — armadilha MEDIDA em prod (2026-09-06): esta rota não tinha guarda de status e
      // marcava `stopped` qualquer projeto, inclusive um que NUNCA entrou na fábrica. Um projeto
      // `promoted` levado a `stopped` deixa o produto sem saída: `unpromote` recusa ("a fábrica já
      // começou") e `promote` recusa (lifecycle ≠ draft). Parar é para pipeline em andamento — quem
      // nunca começou volta pela Bancada, não pelo freio.
      const cur = (await client.query("SELECT status FROM projects WHERE id = $1", [projectId])).rows[0];
      const curStatus = cur ? String(cur.status) : null;
      if (curStatus === "draft" || curStatus === "promoted") {
        return reply.status(409).send({
          code: "NOTHING_TO_STOP",
          message: curStatus === "promoted"
            ? "Este projeto foi admitido na fábrica e ainda não iniciou — não há execução para parar. " +
              "Para devolvê-lo à Bancada, use “Devolver” no produto."
            : "Este projeto está na Bancada (rascunho) — não há execução para parar.",
          status: curStatus,
        });
      }

      const runnerServiceUrl = process.env.RUNNER_SERVICE_URL?.trim();
      if (runnerServiceUrl) {
        try {
          const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId }),
          });
          if (res.status >= 200 && res.status < 300) {
            await client.query(
              "UPDATE projects SET status = $1, stopped_by = 'user', updated_at = now() WHERE id = $2",
              ["stopped", projectId]
            );
            await _postStopDialogue();
            return reply.send({ ok: true, message: "Pipeline encerrado" });
          }
        } catch (err) {
          request.log.error(err, "Falha ao chamar runner service stop");
        }
      }
      await client.query(
        "UPDATE projects SET status = $1, stopped_by = 'user', updated_at = now() WHERE id = $2",
        ["stopped", projectId]
      );
      await _postStopDialogue();
      return reply.send({ ok: true, message: "Pipeline marcado como encerrado" });
    } finally {
      client.release();
    }
  });

  // GET /api/admin/failure-stats — failure metrics by agent and status (identifies systemic issues)
  app.get("/api/admin/failure-stats", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas administradores Zentriz" });
    }
    const days = parseInt((request.query as Record<string, string>).days ?? "30", 10);
    const client = await pool.connect();
    try {
      const byAgent = await client.query(
        `SELECT agent, status, COUNT(*)::int AS calls
         FROM project_agent_metrics
         WHERE created_at > now() - ($1 || ' days')::interval
           AND status IS NOT NULL
         GROUP BY agent, status
         ORDER BY agent, status`,
        [String(days)]
      );

      const failureRate = await client.query(
        `SELECT
           agent,
           COUNT(*) FILTER (WHERE status NOT IN ('OK', 'QA_PASS'))::float
             / NULLIF(COUNT(*), 0) AS failure_rate,
           COUNT(*)::int AS total_calls,
           COUNT(*) FILTER (WHERE status NOT IN ('OK', 'QA_PASS'))::int AS failed_calls
         FROM project_agent_metrics
         WHERE created_at > now() - ($1 || ' days')::interval
           AND status IS NOT NULL
         GROUP BY agent
         ORDER BY failure_rate DESC NULLS LAST`,
        [String(days)]
      );

      const dlqByType = await client.query(
        `SELECT error_type, COUNT(*)::int AS cnt
         FROM project_errors
         WHERE created_at > now() - ($1 || ' days')::interval
         GROUP BY error_type
         ORDER BY cnt DESC`,
        [String(days)]
      ).catch(() => ({ rows: [] }));

      return reply.send({
        period_days: days,
        by_agent_status: byAgent.rows,
        failure_rates: failureRate.rows,
        dlq_by_type: dlqByType.rows,
      });
    } catch {
      return reply.send({ period_days: days, by_agent_status: [], failure_rates: [], dlq_by_type: [] });
    } finally {
      client.release();
    }
  });

  // GET /api/admin/dlq — dead letter queue entries (projects that failed permanently)
  app.get("/api/admin/dlq", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas administradores Zentriz" });
    }
    const client = await pool.connect();
    try {
      const rows = await client.query(
        `SELECT e.id, e.project_id, p.title AS project_title, e.error_type, e.agent, e.task_id, e.reason, e.extra, e.created_at
         FROM project_errors e
         LEFT JOIN projects p ON p.id = e.project_id
         ORDER BY e.created_at DESC LIMIT 100`
      );
      return reply.send({ entries: rows.rows, total: rows.rowCount });
    } catch {
      // Table may not exist yet
      return reply.send({ entries: [], total: 0 });
    } finally {
      client.release();
    }
  });

  // GET /api/watchdog/status — estado atual do Watchdog + projetos órfãos no DB
  app.get("/api/watchdog/status", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas administradores Zentriz" });
    }

    const runnerServiceUrl = process.env.RUNNER_SERVICE_URL?.trim();
    interface RunnerStatusPayload { active_count?: number; projects?: Record<string, number> }
    let runnerStatus: RunnerStatusPayload | null = null;
    if (runnerServiceUrl) {
      try {
        const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/status`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) runnerStatus = await res.json() as RunnerStatusPayload;
      } catch {
        // runner unreachable
      }
    }

    const client = await pool.connect();
    try {
      const orphans = await client.query(
        `SELECT id, title, status, started_at, restart_count,
                COALESCE(restart_count, 0) AS restart_count,
                stopped_by, created_at
         FROM projects
         WHERE status = 'running'
           AND (stopped_by IS NULL OR stopped_by != 'user')
         ORDER BY started_at ASC NULLS LAST
         LIMIT 20`
      );

      const activeRunnerIds = new Set(Object.keys(runnerStatus?.projects ?? {}));
      const rows = orphans.rows as Array<{
        id: string; title: string; status: string;
        started_at: string | null; restart_count: number; stopped_by: string | null;
      }>;

      return reply.send({
        watchdog: {
          enabled: Boolean(process.env.RUNNER_SERVICE_URL),
          interval_ms: parseInt(process.env.WATCHDOG_INTERVAL_MS ?? "60000", 10),
          max_restarts: parseInt(process.env.WATCHDOG_MAX_RESTARTS ?? "5", 10),
          max_runtime_hours: parseFloat(process.env.WATCHDOG_MAX_RUNTIME_HOURS ?? "8"),
        },
        runner: runnerStatus
          ? { reachable: true, active_count: runnerStatus.active_count ?? 0, active_project_ids: Object.keys(runnerStatus.projects ?? {}) }
          : { reachable: false },
        orphan_candidates: rows.map((r) => ({
          id: r.id,
          title: r.title,
          started_at: r.started_at,
          restart_count: r.restart_count,
          has_active_process: activeRunnerIds.has(r.id),
          runtime_hours: r.started_at
            ? ((Date.now() - new Date(r.started_at).getTime()) / 3600000).toFixed(1)
            : null,
        })),
        checked_at: new Date().toISOString(),
      });
    } finally {
      client.release();
    }
  });
}
