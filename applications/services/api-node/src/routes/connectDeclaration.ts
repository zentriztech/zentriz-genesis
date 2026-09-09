/**
 * connectDeclaration.ts — 🔴 GAP-133: dar DONO ao `connect.yaml` na Bancada.
 *   POST /api/projects/:id/connect-declaration   {overwrite?} → 200 {path, action, warnings, truncated}
 *
 * Síncrono de propósito (uma chamada de LLM, teto de 8k de saída): o nginx da borda permite 300 s e o
 * humano fica olhando o resultado. Um job persistido só se justificaria se houvesse várias chamadas em
 * cadeia — aqui não há, e a etapa do laço autônomo (que roda sem browser) tem caminho próprio.
 *
 * Guardas: as MESMAS de qualquer escrita de spec pela Bancada (`rfc-from-template`) — conta de gestão
 * não cria, token de serviço não é autor, projeto acessível pelo tenant, spec editável.
 * `overwrite` é obrigatório para revisar uma declaração que já existe: sobrescrever calado é o defeito
 * que o resto do ecossistema chama de "fechamento fake".
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { SPEC_EDITABLE_STATUSES } from "../services/projectStatus.js";
import { httpPost } from "./specs.js";
import { generateConnectDeclaration, CONNECT_DECL_PATH } from "../services/connectDeclaration.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

export async function connectDeclarationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { id: string }; Body: { overwrite?: boolean } }>(
    "/api/projects/:id/connect-declaration",
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const user = getUser(request);
      if (denyCreationForManagement(user, reply)) return;
      if (user.svc === "runner") return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não edita spec (autoria humana)." });
      const proj = (await pool.query(
        "SELECT id, tenant_id, created_by, status, extra FROM projects WHERE id = $1",
        [request.params.id],
      )).rows[0] as { id: string; tenant_id: string | null; created_by: string | null; status: string; extra: Record<string, unknown> | null } | undefined;
      if (!proj || !canAccessProjectRow(user, proj)) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (!SPEC_EDITABLE_STATUSES.has(proj.status)) return reply.status(409).send({ code: "SPEC_LOCKED", message: `Spec bloqueada: projeto em '${proj.status}'.` });
      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) return reply.status(503).send({ code: "AGENTS_UNAVAILABLE", message: "Serviço de agentes não configurado." });
      const base = agentsUrl.replace(/\/$/, "");

      try {
        const result = await generateConnectDeclaration(
          pool, proj.id,
          (body) => httpPost(`${base}/invoke/raw`, JSON.stringify(body), 240_000),
          { overwrite: request.body?.overwrite === true },
        );
        if (result.action === "skipped") {
          return reply.status(409).send({
            code: "EXISTS", path: result.path,
            message: `Já existe ${CONNECT_DECL_PATH} nesta spec. Reenvie com { overwrite: true } para o arquiteto revisá-lo.`,
          });
        }
        return reply.send({
          ok: true, path: result.path, action: result.action,
          warnings: result.warnings, truncated: result.truncated, modelUsed: result.modelUsed,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Motivo REAL para a tela: um "falhou" genérico aqui esconde exatamente o que o humano
        // precisa saber para agir (spec vazia, resposta fora de formato, declaração inválida).
        const known: Record<string, { code: number; body: string }> = {
          EMPTY_SPEC: { code: 409, body: "A spec deste projeto está vazia — não há material para declarar interfaces." },
          EMPTY_RESPONSE: { code: 502, body: "O arquiteto não devolveu conteúdo. Tente novamente." },
          DECL_NOT_JSON: { code: 502, body: "O arquiteto não devolveu um objeto JSON válido. Tente novamente." },
          DECL_WITHOUT_INTERFACES: { code: 502, body: "A declaração voltou sem nenhuma interface — o schema Connect exige ao menos uma. Tente novamente." },
        };
        const hit = known[msg];
        if (hit) return reply.status(hit.code).send({ code: msg, message: hit.body });
        if (msg === "DECL_SCHEMA_INVALID") {
          const warnings = (e as { warnings?: string[] }).warnings ?? [];
          return reply.status(502).send({
            code: msg, warnings,
            message: `A declaração gerada não passou no schema Connect e NÃO foi gravada: ${warnings.slice(0, 4).join(" · ")}`,
          });
        }
        if (/^FILE_TOO_LARGE/.test(msg)) return reply.status(413).send({ code: "FILE_TOO_LARGE", message: "A declaração gerada excede o teto de tamanho de arquivo da spec." });
        if (/^TOO_MANY_FILES/.test(msg)) return reply.status(413).send({ code: "TOO_MANY_FILES", message: "Teto de arquivos da spec atingido — remova um arquivo antes de gerar a declaração." });
        if (msg === "PROJECT_NOT_FOUND") return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        throw e;
      }
    },
  );
}
