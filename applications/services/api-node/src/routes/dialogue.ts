import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

type DialogueRow = Record<string, unknown>;

export interface DialogueItem {
  id: unknown;
  fromAgent: unknown;
  toAgent: unknown;
  eventType: unknown;
  summaryHuman: unknown;
  requestId: unknown;
  createdAt?: string;
}

/** Mapeia uma linha de ``project_dialogue`` para o shape camelCase servido ao portal. */
export function mapDialogueRow(row: DialogueRow): DialogueItem {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    eventType: row.event_type,
    summaryHuman: row.summary_human,
    requestId: row.request_id,
    createdAt: (row.created_at as Date)?.toISOString(),
  };
}

interface QueryClient {
  query: (q: string, p?: unknown[]) => Promise<{ rows: DialogueRow[] }>;
}

const DIALOGUE_TAIL_SQL =
  `SELECT id, from_agent, to_agent, event_type, summary_human, request_id, created_at
   FROM project_dialogue WHERE project_id = $1 AND created_at >= $2
   ORDER BY created_at ASC LIMIT 200`;

/**
 * "Cauda" incremental do diálogo para o stream SSE. Stateful e PURO (recebe o client) — testável
 * sem socket nem timers. Cursor por ``created_at`` (>=, id é UUID não-sequencial) com dedupe por id:
 * empates de timestamp reaparecem na query mas são filtrados aqui, então nenhum evento é perdido nem
 * duplicado. O set de ``seen`` é limitado — ao estourar o teto zera (o cursor já avançou, eventos
 * antigos não voltam). ``nowISO`` é injetável para teste determinístico do default.
 */
export function createDialogueTail(
  projectId: string,
  sinceISO?: string,
  opts?: { seenCap?: number; nowISO?: string }
) {
  const fallback = opts?.nowISO ?? new Date().toISOString();
  let cursor = sinceISO && !Number.isNaN(Date.parse(sinceISO)) ? new Date(sinceISO).toISOString() : fallback;
  const seen = new Set<string>();
  const seenCap = opts?.seenCap ?? 4000;
  return {
    get cursor() {
      return cursor;
    },
    async poll(client: QueryClient): Promise<DialogueItem[]> {
      const res = await client.query(DIALOGUE_TAIL_SQL, [projectId, cursor]);
      const out: DialogueItem[] = [];
      for (const row of res.rows) {
        const rowId = String(row.id);
        if (seen.has(rowId)) continue;
        seen.add(rowId);
        const item = mapDialogueRow(row);
        out.push(item);
        if (item.createdAt) cursor = item.createdAt; // avança só quando há timestamp
      }
      if (seen.size > seenCap) seen.clear();
      return out;
    },
  };
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

export async function dialogueRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { id: string } }>("/api/projects/:id/dialogue", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

      const result = await client.query(
        `SELECT id, from_agent, to_agent, event_type, summary_human, request_id, created_at
         FROM project_dialogue WHERE project_id = $1 ORDER BY created_at ASC`,
        [projectId]
      );
      const items = result.rows.map(mapDialogueRow);
      return reply.send(items);
    } finally {
      client.release();
    }
  });

  // SSE — stream ao vivo de novas entradas do diálogo (Living Team Mesh: "sistema nervoso").
  // Transporte: text/event-stream lido no browser via fetch+ReadableStream (preserva o Bearer;
  // EventSource não manda Authorization). O cliente carrega o histórico pelo GET normal e abre o
  // stream com ?since=<ISO createdAt do último evento visto> para receber SÓ o que é novo. Cursor
  // por created_at (>=, com dedupe por id no servidor e no cliente) — id é UUID, não sequencial.
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/api/projects/:id/dialogue/stream",
    async (request, reply) => {
      const user = getUser(request);
      const { id: projectId } = request.params;
      const sinceRaw = request.query?.since;

      // Autorização ANTES de assumir o socket (mesma regra do GET/POST).
      const gate = await pool.connect();
      let allowed = false;
      try {
        allowed = await checkProjectAccess(gate, projectId, user);
      } finally {
        gate.release();
      }
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

      reply.hijack(); // Fastify não gerencia mais esta resposta — escrevemos direto no socket.
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // desliga o buffering do nginx para SSE fluir de imediato
      });
      // Reusa a cauda incremental TESTADA (createDialogueTail): o caminho que roda em prod é o
      // mesmo coberto pelos testes — cursor por created_at (>=) + dedupe por id + teto do set.
      const tail = createDialogueTail(projectId, sinceRaw);
      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;

      // Escreve no socket com guarda: nunca escreve após fechar/encerrar; erro de escrita para o loop.
      const safeWrite = (chunk: string): boolean => {
        if (closed || raw.writableEnded) return false;
        try {
          raw.write(chunk);
          return true;
        } catch {
          stop();
          return false;
        }
      };

      const tick = async () => {
        if (closed) return;
        // pool.connect() DENTRO do try: se o pool estiver indisponível (banco fora), connect()
        // rejeita — e como o agendador faz `void tick().finally(scheduleNext)` sem .catch, uma
        // rejeição aqui viraria unhandledRejection (sem handler global → risco de crash do processo).
        // tick() NUNCA rejeita: toda falha vira lista vazia e a próxima passada tenta de novo.
        let c: PoolClient | null = null;
        let items: DialogueItem[] = [];
        try {
          c = await pool.connect();
          items = await tail.poll(c);
        } catch {
          items = []; // falha transitória (inclui pool/banco indisponível) — próxima passada tenta de novo
        } finally {
          if (c) c.release();
        }
        if (closed) return; // cliente saiu durante a query — não escreve em socket morto
        for (const item of items) {
          if (!safeWrite(`event: dialogue\ndata: ${JSON.stringify(item)}\n\n`)) return;
        }
      };

      // Agenda NÃO-sobreposta: o próximo tick só dispara quando o anterior termina — evita
      // empilhar conexões do pool (max 10, compartilhado) se o banco estiver lento.
      const scheduleNext = () => {
        if (closed) return;
        pollTimer = setTimeout(() => {
          void tick().finally(scheduleNext);
        }, 1200);
      };

      const hbTimer = setInterval(() => {
        safeWrite(": hb\n\n"); // heartbeat: segura a conexão viva e prova fluxo de bytes ao cliente
      }, 15000);

      function stop() {
        if (closed) return;
        closed = true;
        if (pollTimer) clearTimeout(pollTimer);
        clearInterval(hbTimer);
        try {
          raw.end();
        } catch {
          /* socket já fechado */
        }
      }

      request.raw.on("close", stop);
      request.raw.on("error", stop);
      raw.on("error", stop); // captura EPIPE / write-after-end assíncrono no socket de resposta
      safeWrite(": connected\n\n");
      await tick(); // primeira passada imediata (pega o que chegou entre o GET e o open)
      scheduleNext();
    }
  );

  app.post<{
    Params: { id: string };
    Body: { from_agent: string; to_agent: string; event_type?: string; summary_human: string; request_id?: string };
  }>("/api/projects/:id/dialogue", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    const { from_agent, to_agent, event_type, summary_human, request_id } = request.body ?? {};
    if (!from_agent || !to_agent || !summary_human) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "from_agent, to_agent e summary_human são obrigatórios" });
    }
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human, request_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [projectId, from_agent, to_agent, event_type ?? null, summary_human, request_id ?? null]
      );
      return reply.status(201).send({ ok: true });
    } finally {
      client.release();
    }
  });
}
