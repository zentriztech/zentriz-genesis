/**
 * githubPush.ticketStamp.test.ts — tarefa 4.4 (RFC-0009 F3): o carimbo `TK-NNNN` chega ao título do PR, ao commit em lote e ao
 * corpo do PR. Repositório SIMULADO: o Octokit é injetado pelo seam `__setOctokitFactoryForTests` (sem rede nem credenciais).
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setOctokitFactoryForTests, pushProjectFiles } from "./github.js";
import { evolutionPrTitle } from "./githubPush.js";
import { buildPullRequestBody } from "./evolutionAccept.js";
import { ticketStamp } from "./tickets.js";

describe("evolutionPrTitle", () => {
  it("com carimbo: TK-NNNN · Evolução vX — título (remove o sufixo ' — Evolução vN' duplicado)", () => {
    expect(evolutionPrTitle("TK-0012", "1.2.0", "Extrato — Evolução v3")).toBe("TK-0012 · Evolução v1.2.0 — Extrato");
  });
  it("sem carimbo: idêntico ao histórico", () => {
    expect(evolutionPrTitle(null, "1.2.0", "Extrato")).toBe("Evolução v1.2.0 — Extrato");
  });
});

describe("buildPullRequestBody — linha **Ticket:**", () => {
  const db = { query: vi.fn(async () => ({ rows: [] })) };
  it("com ticket_number e tipo: `**Ticket:** TK-0007 (Funcionalidade|…)` presente", async () => {
    const body = await buildPullRequestBody(db as never, "c", "1.0.0", { ticket_number: 7, ticket_kind: "fix", evolution_request: "x" });
    expect(body).toMatch(/\*\*Ticket:\*\* TK-0007 \(.+\)/);
  });
  it("sem ticket: nenhuma linha Ticket", async () => {
    const body = await buildPullRequestBody(db as never, "c", "1.0.0", { evolution_request: "x" });
    expect(body).not.toContain("**Ticket:**");
  });
});

describe("pushProjectFiles — commit em lote carimbado", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "f4b-push-"));
    mkdirSync(join(root, "p1", "apps"), { recursive: true });
    writeFileSync(join(root, "p1", "apps", "a.txt"), "a");
  });
  afterEach(() => { __setOctokitFactoryForTests(null); rmSync(root, { recursive: true, force: true }); });

  function fakeRepo() {
    const messages: string[] = [];
    const git = {
      getRef: vi.fn(async () => ({ data: { object: { sha: "c0" } } })),
      getCommit: vi.fn(async () => ({ data: { tree: { sha: "t0" } } })),
      createBlob: vi.fn(async () => ({ data: { sha: "b1" } })),
      createTree: vi.fn(async () => ({ data: { sha: "t1" } })),
      createCommit: vi.fn(async (o: { message: string }) => { messages.push(o.message); return { data: { sha: "c1" } }; }),
      updateRef: vi.fn(async () => ({})),
      getTree: vi.fn(async () => ({ data: { tree: [], truncated: false } })),
    };
    __setOctokitFactoryForTests(async () => ({ git, repos: {}, pulls: {} }) as never);
    return messages;
  }

  it("messageSuffix `(TK-0012)` aparece na mensagem; stamp vem de ticketStamp", async () => {
    const messages = fakeRepo();
    const stamp = ticketStamp({ ticket_number: 12 });
    await pushProjectFiles(1, "o", "r", "evolution/v2", root, "p1", { syncDeletes: false, messageSuffix: stamp ? ` (${stamp})` : undefined });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^feat: Genesis — push 1 generated files \(TK-0012\)$/);
  });
  it("sem sufixo: mensagem histórica byte a byte", async () => {
    const messages = fakeRepo();
    await pushProjectFiles(1, "o", "r", "evolution/v2", root, "p1", { syncDeletes: false });
    expect(messages[0]).toBe("feat: Genesis — push 1 generated files");
  });

  it("N-3 (AU): excludeForeignLockfiles NÃO publica o lockfile de outro gerenciador (pnpm-lock.yaml num projeto npm); sem a flag, publica tudo", async () => {
    writeFileSync(join(root, "p1", "apps", "package-lock.json"), "{}");
    writeFileSync(join(root, "p1", "apps", "pnpm-lock.yaml"), "lockfileVersion: 9");
    const paths: string[] = [];
    const git = {
      getRef: vi.fn(async () => ({ data: { object: { sha: "c0" } } })),
      getCommit: vi.fn(async () => ({ data: { tree: { sha: "t0" } } })),
      createBlob: vi.fn(async () => ({ data: { sha: "b1" } })),
      createTree: vi.fn(async (o: { tree: Array<{ path: string }> }) => { paths.push(...o.tree.map((t) => t.path)); return { data: { sha: "t1" } }; }),
      createCommit: vi.fn(async () => ({ data: { sha: "c1" } })),
      updateRef: vi.fn(async () => ({})),
      getTree: vi.fn(async () => ({ data: { tree: [], truncated: false } })),
    };
    __setOctokitFactoryForTests(async () => ({ git, repos: {}, pulls: {} }) as never);
    const r = await pushProjectFiles(1, "o", "r", "evolution/v2", root, "p1", { syncDeletes: false, excludeForeignLockfiles: true });
    expect(paths.sort()).toEqual(["a.txt", "package-lock.json"]);
    expect(r.excludedLockfiles).toEqual(["pnpm-lock.yaml"]);
    expect(r.fileCount).toBe(2);
    paths.length = 0;
    await pushProjectFiles(1, "o", "r", "evolution/v2", root, "p1", { syncDeletes: false });
    expect(paths.sort()).toEqual(["a.txt", "package-lock.json", "pnpm-lock.yaml"]);
  });
});
