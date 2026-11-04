/**
 * evolvePg.ts — helpers de TESTE para a reprodução dos defeitos do fluxo "Evoluir projeto" (plano
 * EVOLUIR-PROJETO-BANCADA v2, tarefa 0.3) e para as fases seguintes (1', 2, 3).
 *
 * NÃO é código de produto: só é importado por `*.test.ts`. Fornece:
 *   • `pgHolder` + `dbClientMock()` / `authMock()` — para `vi.mock` das rotas contra Postgres EFÊMERO;
 *   • `seedAcceptedProduct` — produto `accepted` com pai aceito, spec em disco e (opcional) orçamento;
 *   • `seedTicket` (+ anexos) — pedido `open` do produto;
 *   • `buildApp` — Fastify com as rotas reais registradas (cliente HTTP de teste via `app.inject`);
 *   • `raceN` / `queryGate` — gerador de corridas DETERMINÍSTICAS: segura as N requisições num ponto
 *     exato do SQL (barreira) ou segura UMA requisição antes de um SQL (para intercalar outra escrita).
 *
 * Uso (modelo: src/routes/llm.reorder.pg.integration.test.ts):
 *   docker run --rm -d --name g01-pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 pgvector/pgvector:pg16
 *   DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npx tsx scripts/apply-migrations-test.ts
 *   PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres npx vitest run src/routes/<arquivo>.test.ts
 * Recusa qualquer URL que não seja localhost:55432. Sem PG_TEST_URL os blocos `describePg` são skip.
 */
import { describe } from "vitest";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash, randomUUID } from "crypto";

export const PG_URL = process.env.PG_TEST_URL;
/** `describe` que vira skip sem Postgres efêmero. */
export const describePg = PG_URL ? describe : describe.skip;

/** Pool real que `vi.mock("../db/client.js")` devolve. Preenchido por `openPg()`. */
export const pgHolder: { pool: pg.Pool | null } = { pool: null };

/** Usuário "logado" nas rotas; mutável entre testes. */
export const testUser: { id: string; email: string; role: string; tenantId: string | null } = {
  id: "", email: "", role: "tenant_admin", tenantId: null,
};

/** Fábrica para `vi.mock("../db/client.js", () => dbClientMock())`. */
export function dbClientMock() {
  return { get pool() { return pgHolder.pool; } };
}
/** Fábrica para `vi.mock("../middleware/auth.js", () => authMock())`. */
export function authMock() {
  return {
    authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = { ...testUser }; },
  };
}

export async function openPg(max = 24): Promise<pg.Pool> {
  if (!PG_URL || !/@(localhost|127\.0\.0\.1):(55432|55440|55441)\//.test(PG_URL)) {
    throw new Error("PG_TEST_URL deve apontar para o Postgres efêmero em localhost:55432, 55440 ou 55441");
  }
  const pool = new pg.Pool({ connectionString: PG_URL, max });
  pgHolder.pool = pool;
  return pool;
}

/**
 * Banco DESCARTÁVEL dentro do mesmo Postgres efêmero (isolamento para testes que criam/derrubam índices ou semeiam
 * duplicatas): `CREATE DATABASE`, pool próprio (também ligado ao `pgHolder`, para o `vi.mock` das rotas) e
 * `drop()`. As migrations ficam por conta do chamador (`initDb()` após `pgHolder.pool` apontar para cá).
 */
export async function createScratchDb(prefix = "evo_scratch"): Promise<{ pool: pg.Pool; name: string; drop(): Promise<void> }> {
  if (!PG_URL || !/@(localhost|127\.0\.0\.1):(55432|55440|55441)\//.test(PG_URL)) {
    throw new Error("PG_TEST_URL deve apontar para o Postgres efêmero em localhost:55432 ou 55440");
  }
  const name = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = PG_URL.replace(/\/[^/?]*(\?.*)?$/, `/${name}$1`);
  const pool = new pg.Pool({ connectionString: url, max: 24 });
  pgHolder.pool = pool;
  return {
    pool, name,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

let seq = 0;
export const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export interface Seed {
  tenantId: string;
  userId: string;
  productId: string;
  /** Projeto pai `accepted` (versão 1, raiz da linhagem). */
  parentId: string;
  uploadDir: string;
  cleanup(): void;
}

/**
 * Produto `accepted` com um pai `accepted` que tem spec em disco (arquivo primário `spec.md`).
 * Muda `process.env.UPLOAD_DIR` para um tmp dir (o /evolve escreve a árvore do filho ali) e
 * zera `PROJECT_FILES_ROOT` (sem clone git). `cleanup()` restaura o env e apaga o tmp.
 */
export async function seedAcceptedProduct(pool: pg.Pool, opts: {
  budgetUsd?: number | null;
  specContent?: string | null;
  extraFiles?: Array<{ relDir: string; filename: string; content: Buffer | string; mime?: string }>;
} = {}): Promise<Seed> {
  const id = uid();
  const t = await pool.query(`INSERT INTO tenants (name, plan_id) VALUES ('t-'||$1, 'plan_prata') RETURNING id`, [id]);
  const tenantId = t.rows[0].id as string;
  const u = await pool.query(
    `INSERT INTO users (email, name, role, tenant_id) VALUES ($1, 'u', 'tenant_admin', $2) RETURNING id`,
    [`u-${id}@x.test`, tenantId],
  );
  const userId = u.rows[0].id as string;
  const p = await pool.query(
    `INSERT INTO products (tenant_id, created_by, name, lifecycle_status) VALUES ($1,$2,$3,'accepted') RETURNING id`,
    [tenantId, userId, `prod-${id}`],
  );
  const productId = p.rows[0].id as string;
  const parent = await pool.query(
    `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, budget_usd)
     VALUES ($1,$2,$3,'accepted',$4,1,$5) RETURNING id`,
    [tenantId, userId, `App ${id}`, productId, opts.budgetUsd ?? null],
  );
  const parentId = parent.rows[0].id as string;

  const uploadDir = mkdtempSync(join(tmpdir(), "genesis-evo-pg-"));
  const envBackup = { UPLOAD_DIR: process.env.UPLOAD_DIR, PROJECT_FILES_ROOT: process.env.PROJECT_FILES_ROOT };
  process.env.UPLOAD_DIR = uploadDir;
  process.env.PROJECT_FILES_ROOT = "";

  const addFile = async (relDir: string, filename: string, content: Buffer | string, primary: boolean, mime: string) => {
    const dir = relDir ? join(uploadDir, parentId, relDir) : join(uploadDir, parentId);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, filename);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
    writeFileSync(fp, buf);
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [parentId, filename, fp, mime, relDir, primary, sha256(buf)],
    );
  };
  if (opts.specContent !== null) {
    await addFile("", "spec.md", opts.specContent ?? "# Spec do pai\n\nO app lista entregas.\n", true, "text/markdown");
  }
  for (const f of opts.extraFiles ?? []) await addFile(f.relDir, f.filename, f.content, false, f.mime ?? "text/markdown");

  Object.assign(testUser, { id: userId, email: `u-${id}@x.test`, role: "tenant_admin", tenantId });
  return {
    tenantId, userId, productId, parentId, uploadDir,
    cleanup() {
      rmSync(uploadDir, { recursive: true, force: true });
      process.env.UPLOAD_DIR = envBackup.UPLOAD_DIR;
      process.env.PROJECT_FILES_ROOT = envBackup.PROJECT_FILES_ROOT;
    },
  };
}

export interface SeededTicket { id: string; number: number }

/** Pedido `open` do produto (número alocado pelo contador do produto, como a rota real). */
export async function seedTicket(pool: pg.Pool, s: Seed, o: {
  kind?: "evolution" | "fix" | "feature"; body?: string; status?: string; childProjectId?: string | null;
  attachments?: Array<{ filename: string; content: Buffer; mime: string }>;
} = {}): Promise<SeededTicket> {
  const n = (await pool.query(
    "UPDATE products SET next_ticket_seq = next_ticket_seq + 1 WHERE id = $1 RETURNING next_ticket_seq - 1 AS n", [s.productId],
  )).rows[0].n as number;
  const r = await pool.query(
    `INSERT INTO tickets (tenant_id, product_id, project_id, number, title, body, change_kind, status, child_project_id, created_by)
     VALUES ($1,$2,$3,$4,'Exportar CSV',$5,$6,$7,$8,$9) RETURNING id`,
    [s.tenantId, s.productId, s.parentId, n, o.body ?? "Quero baixar a lista de entregas em CSV.", o.kind ?? "feature",
     o.status ?? "open", o.childProjectId ?? null, s.userId],
  );
  const id = r.rows[0].id as string;
  for (const a of o.attachments ?? []) {
    const dir = join(s.uploadDir, "tickets", id);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, a.filename);
    writeFileSync(fp, a.content);
    await pool.query(
      `INSERT INTO ticket_attachments (ticket_id, filename, file_path, mime_type, size_bytes, content_sha256)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, a.filename, fp, a.mime, a.content.length, sha256(a.content)],
    );
  }
  return { id, number: n };
}

/** Fastify com as rotas REAIS (`projectRoutes`, `ticketRoutes`, `pipelineRoutes`, `productRoutes`…). */
export async function buildApp(register: Array<(app: FastifyInstance) => Promise<void>>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // multipart como em app.ts (mesmos tetos) — o POST de pedido com anexo (tickets.ts) precisa dele.
  await app.register(fastifyMultipart, { limits: { files: 10, fileSize: 10 * 1024 * 1024 } });
  for (const r of register) await app.register(r);
  await app.ready();
  return app;
}

// ── Gerador de corridas ──────────────────────────────────────────────────────────

/** Dispara `n` chamadas SIMULTÂNEAS (todas iniciadas antes de qualquer await). */
export async function raceN<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}

interface GateHandle {
  /** Resolve quando `arrivals` consultas casaram o padrão. */
  reached: Promise<void>;
  /** Libera as consultas retidas (no modo `barrier`, já se libera sozinho ao atingir `arrivals`). */
  release(): void;
  hits(): number;
}

/**
 * Intercepta `pool.connect()` (as rotas reais pegam um client dedicado) e retém consultas cujo SQL casa `pattern`.
 *  - mode "barrier": a consulta EXECUTA, e o resultado só é devolvido quando `arrivals` consultas chegaram
 *    — garante que as N requisições leram o MESMO estado (ex.: "nenhuma evolução em voo") antes de qualquer escrita;
 *  - mode "hold-before": a consulta NÃO executa até `release()` — permite intercalar outra escrita antes dela.
 * Devolve o handle; `uninstall()` restaura o pool original.
 */
export function queryGate(pool: pg.Pool, pattern: RegExp, opts: { mode: "barrier" | "hold-before"; arrivals?: number }): GateHandle & { uninstall(): void } {
  const arrivals = opts.arrivals ?? 1;
  let count = 0;
  let released = false;
  let resolveReached!: () => void;
  const reached = new Promise<void>((r) => { resolveReached = r; });
  const waiters: Array<() => void> = [];
  const release = () => { released = true; for (const w of waiters.splice(0)) w(); };
  const original = pool.connect.bind(pool) as (cb?: unknown) => Promise<pg.PoolClient>;
  const wait = () => new Promise<void>((res) => { if (released) res(); else waiters.push(res); });

  (pool as unknown as { connect: (cb?: unknown) => unknown }).connect = (cb?: unknown) => {
    // `pool.query` do pg chama `this.connect(callback)` por dentro: a forma com callback passa direto (sem interceptar).
    if (typeof cb === "function") return original(cb);
    return connectGated();
  };
  const connectGated = async () => {
    const client = await original();
    const q = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      if (!pattern.test(sql)) return q(...args);
      if (opts.mode === "hold-before") {
        count++;
        if (count >= arrivals) resolveReached();
        await wait();
        return q(...args);
      }
      const res = await q(...args);
      count++;
      if (count >= arrivals) { resolveReached(); release(); }
      await wait();
      return res;
    };
    return client;
  };
  return {
    reached, release, hits: () => count,
    uninstall() { (pool as unknown as { connect: unknown }).connect = original; release(); },
  };
}

// ── Consultas de verificação ─────────────────────────────────────────────────────

export async function childrenOf(pool: pg.Pool, parentId: string) {
  return (await pool.query(
    "SELECT id, status, version_number, budget_usd, budget_owner_project_id, extra FROM projects WHERE parent_project_id = $1 ORDER BY created_at",
    [parentId],
  )).rows as Array<{ id: string; status: string; version_number: number; budget_usd: string | null; budget_owner_project_id: string | null; extra: Record<string, unknown> }>;
}

export async function ticketRow(pool: pg.Pool, id: string) {
  return (await pool.query("SELECT * FROM tickets WHERE id = $1", [id])).rows[0] as
    { id: string; status: string; child_project_id: string | null; delivered_at: Date | null; promoted_at: Date | null };
}

export const newUuid = () => randomUUID();
