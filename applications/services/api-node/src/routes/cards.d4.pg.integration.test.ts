/**
 * Rodada 4.5c / D-4 e itens 1, 2 e 4 da correção BC — Postgres REAL efêmero (rotas reais, sem LLM, GitHub simulado):
 *  1. promover um card exige que o filho-de-card anterior da linhagem esteja entregue (PR mergeado) — senão 409 CARD_PREVIOUS_UNMERGED,
 *     inclusive na corrida de duas promoções; com o PR mergeado, a corrida cria exatamente 1 filho;
 *  2. `disk-copy` silencioso: com repositório na linhagem e fetch falho, a promoção FALHA (retry) em vez de copiar do disco; com
 *     permissão explícita (EVOLVE_CARD_DISK_COPY=on) copia, mas com alerta no diálogo, no filho e no card (`codeBaseWarning`);
 *  4. `factoryHealth` do card derivado dos 5 gates reais registrados no aceite.
 * Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

const FILES_ROOT = await vi.hoisted(async () => {
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-d4-files-"));
  process.env.PROJECT_FILES_ROOT = d;
  return d;
});
const remote = vi.hoisted(() => ({ url: null as string | null }));

import {
  describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, childrenOf, raceN, sha256, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());
vi.mock("../services/github.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getInstallationTokenForClone: async () => "test-token" }));
vi.mock("../services/githubPush.js", async (orig) => {
  const real = await orig<typeof import("../services/githubPush.js")>();
  return { ...real, gitLinkProjectFolder: (o: Parameters<typeof real.gitLinkProjectFolder>[0]) => real.gitLinkProjectFolder({ ...o, remoteUrl: remote.url ?? o.remoteUrl }) };
});

import { cardRoutes } from "./cards.js";
import { projectRoutes } from "./projects.js";
import { __setOctokitFactoryForTests } from "../services/github.js";
import { syncCardForChildProject } from "../services/cardPromote.js";
import { recordScopeGate } from "../services/evolutionAccept.js";
import { factoryHealthOf } from "../services/factoryHealth.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const rfc = (n: number, title: string) => `# RFC-${String(n).padStart(4, "0")} — ${title}

## Sumário
Permitir ${title.toLowerCase()} a partir da tela de entregas.

## Non-goals
Não altera o cálculo de prazos nem a tela de mapa.

## Requisitos
- REQ-01 — O sistema DEVE atender: ${title}.

## Critérios de aceite
### Cenário: ${title}
- **Dado** um usuário autenticado com entregas
- **Quando** usa a função
- **Então** recebe o resultado esperado

## Compatibilidade
- Tipo (SemVer): MINOR
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
  - "apps/api/src/deliveries/**"
  - "tests/**"
\`\`\`
`;

describePg("Rodada 4.5c — base não mergeada, disk-copy e factoryHealth (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const prState = { merged: false };

  beforeAll(async () => { pool = await openPg(); app = await buildApp([cardRoutes, projectRoutes]); }, 60_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    for (const s of seeds) s.cleanup();
    await pool?.end();
    rmSync(FILES_ROOT, { recursive: true, force: true });
  });
  afterEach(() => { remote.url = null; __setOctokitFactoryForTests(null); prState.merged = false; vi.unstubAllEnvs(); });

  const as = (s: Seed) => Object.assign(testUser, { id: s.userId, email: `u@${s.tenantId}.test`, role: "tenant_admin", tenantId: s.tenantId });
  const mk = async (o: { repo?: boolean; apps?: boolean; filesRoot?: boolean } = {}) => {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(s);
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
    process.env.PROJECT_FILES_ROOT = o.filesRoot ? FILES_ROOT : "";
    if (o.apps) {
      mkdirSync(join(FILES_ROOT, s.parentId, "apps", "src"), { recursive: true });
      writeFileSync(join(FILES_ROOT, s.parentId, "apps", "src", "index.js"), "console.log('v1')\n");
    }
    if (o.repo) {
      await pool.query(`INSERT INTO tenant_github_installations (tenant_id, installation_id, github_login) VALUES ($1, 4242, 'acme') ON CONFLICT (tenant_id) DO NOTHING`, [s.tenantId]);
      await pool.query(`INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url) VALUES ($1,'app','acme/app','https://github.com/acme/app','https://github.com/acme/app.git')`, [s.parentId]);
    }
    as(s);
    return s;
  };
  const fakeGithub = () => __setOctokitFactoryForTests(async () => ({
    pulls: { get: async () => ({ data: { state: prState.merged ? "closed" : "open", merged: prState.merged, mergeable: true, mergeable_state: "clean", head: { sha: "H" }, base: { ref: "dev" }, merge_commit_sha: prState.merged ? "M" : null } }) },
  }) as never);
  const post = (s: Seed, url: string, payload?: unknown) => { as(s); return app.inject({ method: "POST", url, ...(payload ? { payload } : {}) }); };
  const get = (s: Seed, url: string) => { as(s); return app.inject({ method: "GET", url }); };
  const readyCard = async (s: Seed, n: number, title: string) => {
    as(s);
    const c = (await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: "feature", title, body: `Quero: ${title}.` } })).json() as { id: string; code: string; draftProjectId: string };
    const dir = join(s.uploadDir, c.draftProjectId, "docs/rfc");
    mkdirSync(dir, { recursive: true });
    const content = rfc(n, title);
    const fn = `RFC-${String(n).padStart(4, "0")}-x.md`;
    writeFileSync(join(dir, fn), content, "utf-8");
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256) VALUES ($1,$2,$3,'text/markdown','docs/rfc',false,$4)`,
      [c.draftProjectId, fn, join(dir, fn), sha256(content)],
    );
    const r = await post(s, `/api/cards/${c.id}/ready`);
    expect(r.statusCode, r.body).toBe(200);
    return c;
  };
  const state = async (id: string) => (await pool.query("SELECT card_state, child_project_id FROM tickets WHERE id = $1", [id])).rows[0] as { card_state: string; child_project_id: string | null };
  const dialogue = async (projectId: string) => (await pool.query("SELECT summary_human FROM project_dialogue WHERE project_id = $1 ORDER BY created_at, id", [projectId])).rows.map((r) => String(r.summary_human));

  /** Card A promovido, filho na fábrica e depois ACEITO com PR nº 7 aberto (não mergeado). Devolve A e o HEAD (= filho de A). */
  async function acceptedUnmergedBase(s: Seed) {
    fakeGithub();
    const A = await readyCard(s, 1, "Exportar entregas em CSV");
    const pa = await post(s, `/api/cards/${A.id}/promote`);
    expect(pa.statusCode, pa.body).toBe(201);
    const childA = pa.json().childProjectId as string;
    await pool.query("UPDATE projects SET status = 'running' WHERE id = $1", [childA]);
    await syncCardForChildProject(pool, childA);
    await pool.query("UPDATE projects SET status = 'accepted', extra = extra || $2::jsonb WHERE id = $1", [childA, JSON.stringify({ evolution_pr_number: 7, evolution_pr_url: "https://github.com/acme/app/pull/7", evolution_publish_state: "done", evolution_publish_mode: "pr" })]);
    return { A, childA };
  }

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  it("promover sobre base cujo filho-de-card está ACEITO mas NÃO mergeado ⇒ 409 CARD_PREVIOUS_UNMERGED; corrida de duas promoções: ambas recusadas, nenhum filho criado", async () => {
    const s = await mk({ repo: true });
    const { A, childA } = await acceptedUnmergedBase(s);
    const B = await readyCard(s, 2, "Filtrar entregas por data");
    const C = await readyCard(s, 3, "Ordenar entregas por prazo");
    const rs = await raceN(2, (i) => post(s, `/api/cards/${i === 0 ? B.id : C.id}/promote`));
    for (const r of rs) {
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({
        code: "CARD_PREVIOUS_UNMERGED", blockingCardCode: A.code, blockingCardState: "in_factory", blockingProjectId: childA, blockingPrNumber: 7,
        blockingPrUrl: "https://github.com/acme/app/pull/7", mergeProof: "pr_not_merged",
      });
      expect(r.json().action).toContain(A.code);
    }
    expect((await childrenOf(pool, childA)).length).toBe(0);
    expect((await state(B.id)).card_state).toBe("ready");
    expect((await state(C.id)).card_state).toBe("ready");

    // PR mergeado: a MESMA corrida cria exatamente 1 filho (o outro card responde em voo), nenhum 409 de base não mergeada.
    prState.merged = true;
    const rs2 = await raceN(2, (i) => post(s, `/api/cards/${i === 0 ? B.id : C.id}/promote`));
    expect(rs2.filter((r) => r.statusCode === 201).length).toBe(1);
    for (const r of rs2) expect(r.json().code).not.toBe("CARD_PREVIOUS_UNMERGED");
    expect((await childrenOf(pool, childA)).length).toBe(1);
  });

  it("base cujo filho-de-card está ENTREGUE, ou linhagem sem repositório, promove normalmente (regra só vale com PR a esperar)", async () => {
    const s = await mk({});   // sem repositório: o aceite do filho já é a entrega (prova no_repo)
    const A = await readyCard(s, 1, "Exportar entregas em CSV");
    const pa = await post(s, `/api/cards/${A.id}/promote`);
    expect(pa.statusCode, pa.body).toBe(201);
    await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [pa.json().childProjectId]);
    const B = await readyCard(s, 2, "Filtrar entregas por data");
    const pb = await post(s, `/api/cards/${B.id}/promote`);
    expect(pb.statusCode, pb.body).toBe(201);
    expect(pb.json().versionNumber).toBe(3);
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
  it("repositório existe e o fetch falha (404): a promoção FALHA com retry e alerta — nada é copiado do disco; corrigido o remoto, a repetição retoma por git-clone", async () => {
    const s = await mk({ repo: true, apps: true, filesRoot: true });
    const A = await readyCard(s, 1, "Exportar entregas em CSV");
    remote.url = `file://${join(FILES_ROOT, "remote-inexistente")}`;   // erro permanente (o antigo gatilho do disk-copy silencioso)
    const r1 = await post(s, `/api/cards/${A.id}/promote`);
    expect(r1.statusCode, r1.body).toBe(500);
    expect(r1.json()).toMatchObject({ code: "MATERIALIZATION_FAILED", reason: "CODE_BASE_FETCH_FAILED", retryable: true });
    expect(r1.headers["retry-after"]).toBeTruthy();
    const kid = (await childrenOf(pool, s.parentId))[0];
    expect(kid.status).toBe("materializing");
    expect((await dialogue(kid.id)).join("\n")).toContain("ALERTA");
    expect((kid.extra as { materialization: { steps: Record<string, unknown> } }).materialization.steps.code).toBeUndefined();   // o passo NÃO foi marcado: nenhuma cópia do disco

    // remoto bom: a repetição retoma o MESMO filho e clona de verdade
    const dir = join(FILES_ROOT, "remote-bom");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "dev"); git(dir, "config", "user.email", "t@x.test"); git(dir, "config", "user.name", "t"); git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "README.md"), "# app\n"); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "v1");
    remote.url = `file://${dir}`;
    const r2 = await post(s, `/api/cards/${A.id}/promote`);
    expect([200, 201], r2.body).toContain(r2.statusCode);
    expect(r2.json().evolutionSource).toBe("git-clone");
    expect((await childrenOf(pool, s.parentId)).length).toBe(1);
    const det = (await get(s, `/api/cards/${A.id}`)).json();
    expect(det.codeBaseWarning).toBeNull();
  });

  it("permissão EXPLÍCITA (EVOLVE_CARD_DISK_COPY=on): copia do disco, mas com alerta no erro de origem, no diálogo, no filho e no card (`codeBaseWarning`)", async () => {
    vi.stubEnv("EVOLVE_CARD_DISK_COPY", "on");
    const s = await mk({ repo: true, apps: true, filesRoot: true });
    const A = await readyCard(s, 1, "Exportar entregas em CSV");
    remote.url = `file://${join(FILES_ROOT, "remote-inexistente-2")}`;
    const r = await post(s, `/api/cards/${A.id}/promote`);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().evolutionSource).toBe("disk-copy");
    expect(r.json().evolutionSourceError).toContain("ATENÇÃO");
    const kid = (await childrenOf(pool, s.parentId))[0];
    expect(kid.extra.evolution_code_base_warning).toContain("NÃO mergeado");
    expect((await dialogue(kid.id)).join("\n")).toContain("ALERTA — código-base copiado do DISCO");
    const det = (await get(s, `/api/cards/${A.id}`)).json();
    expect(det.codeBaseWarning).toContain("NÃO mergeado");
  });

  it("linhagem SEM repositório: disk-copy é o único caminho, mas também deixa alerta visível (diálogo e card)", async () => {
    const s = await mk({ apps: true, filesRoot: true });
    const A = await readyCard(s, 1, "Exportar entregas em CSV");
    const r = await post(s, `/api/cards/${A.id}/promote`);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().evolutionSource).toBe("disk-copy");
    const kid = (await childrenOf(pool, s.parentId))[0];
    expect((await dialogue(kid.id)).join("\n")).toContain("ALERTA");
    expect((await get(s, `/api/cards/${A.id}`)).json().codeBaseWarning).toContain("sem repositório");
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  describe("factoryHealth", () => {
    it("regra pura: failed > attention > ok; sem gates ⇒ null", () => {
      const p = { status: "passed" };
      expect(factoryHealthOf(null)).toBeNull();
      expect(factoryHealthOf({})).toBeNull();
      expect(factoryHealthOf({ scope: p, symbols: p, qa: p, fullTest: p, baseline: p })).toBe("ok");
      expect(factoryHealthOf({ scope: p, symbols: p, qa: p, fullTest: { status: "not_run" }, baseline: p })).toBe("attention");
      expect(factoryHealthOf({ scope: p, symbols: p, qa: p, fullTest: { status: "not_run" }, baseline: { status: "failed" } })).toBe("failed");
    });

    async function acceptedCard(s: Seed) {
      const A = await readyCard(s, 1, "Exportar entregas em CSV");
      const pa = await post(s, `/api/cards/${A.id}/promote`);
      expect(pa.statusCode, pa.body).toBe(201);
      const child = pa.json().childProjectId as string;
      await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [child]);
      return { A, child };
    }
    const extraOf = async (id: string) => (await pool.query("SELECT extra FROM projects WHERE id = $1", [id])).rows[0].extra as Record<string, unknown>;

    it("filho aceito com TSK-FULL-TEST reprovada ⇒ card `failed` (com os 5 gates) no detalhe e na lista; filho sem registro de nada ⇒ `attention`; ainda não aceito ⇒ null", async () => {
      const s = await mk({ filesRoot: true });
      const { A, child } = await acceptedCard(s);
      // antes do aceite não há gates registrados
      expect((await get(s, `/api/cards/${A.id}`)).json()).toMatchObject({ factoryHealth: null, factoryGates: null });
      // sem nenhum registro (checkpoint e diálogo vazios) ⇒ todos "não executado" ⇒ atenção
      await recordScopeGate(pool as never, child, await extraOf(child));
      expect((await get(s, `/api/cards/${A.id}`)).json()).toMatchObject({ factoryHealth: "attention" });
      // QA rodou e a FULL-TEST foi REPROVADA
      await pool.query(`INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1,'qa','dev','qa.review','QA revisou a task')`, [child]);
      await pool.query(`INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1,'system','system','step','TASK-FULL-TEST (Claude Code): REPROVADA — build quebrado (TS2554)')`, [child]);
      await recordScopeGate(pool as never, child, await extraOf(child));
      const det = (await get(s, `/api/cards/${A.id}`)).json();
      expect(det.factoryHealth).toBe("failed");
      expect(det.factoryGates.fullTest).toMatchObject({ status: "failed" });
      expect(det.factoryGates.fullTest.detail).toContain("TS2554");
      expect(Object.keys(det.factoryGates).sort()).toEqual(["baseline", "fullTest", "qa", "scope", "symbols"]);
      const list = (await get(s, `/api/products/${s.productId}/cards`)).json();
      expect(list.items.find((c: { id: string }) => c.id === A.id)).toMatchObject({ factoryHealth: "failed" });
    });

    it("todos os 5 gates passaram ⇒ ok", async () => {
      const s = await mk({ filesRoot: true });
      const { A, child } = await acceptedCard(s);
      const cp = join(FILES_ROOT, ".runner-state", child);
      mkdirSync(cp, { recursive: true });
      writeFileSync(join(cp, "checkpoint.json"), JSON.stringify({ evolution_violations: {}, evolution_baseline: { status: "ok", passed: 10, final: { status: "ok", regressions: [] } } }));
      await pool.query(`INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1,'qa','dev','qa.review','QA revisou a task')`, [child]);
      await pool.query(`INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1,'system','system','step','TASK-FULL-TEST (Claude Code): aprovada')`, [child]);
      await pool.query(`INSERT INTO project_tasks (project_id, task_id, status, owner_role) VALUES ($1,'TSK-FULL-TEST','DONE','QA')`, [child]);
      await recordScopeGate(pool as never, child, await extraOf(child));
      expect((await get(s, `/api/cards/${A.id}`)).json()).toMatchObject({ factoryHealth: "ok" });
    });
  });
});
