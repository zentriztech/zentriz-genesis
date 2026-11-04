import { test, expect, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// E2E dos cards da Bancada (plano EVOLUIR-PROJETO 3.x): portal buildado + API SIMULADA em memória.
// Nenhuma chamada sai do navegador para backend real: toda `/api/**` é interceptada.
// Contrato simulado: relatório R §2 (rotas reais) + `GET /api/cards/:id/journey` (ASSUMIDO, responde 404).

const SHOTS = process.env.E2E_SHOTS_DIR ?? path.resolve(__dirname, "../../../../project/docs/analysis/img-w");

type State = "draft" | "refining" | "ready" | "promoted";
interface MockCard { id: string; number: number; kind: string; title: string; body: string; state: State }

async function seedSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("genesis_token", "e2e-token");
    localStorage.setItem("genesis_user", JSON.stringify({ id: "u1", email: "teste@example.com", name: "Pessoa de Teste", tenantId: "t1", role: "tenant_admin", status: "active", createdAt: "2026-01-01T00:00:00Z" }));
    localStorage.setItem("genesis_tenant", "");
  });
}

function mockApi(page: Page, opts: { cardsBancada?: boolean; seed?: MockCard[] } = {}) {
  const cards: MockCard[] = opts.seed ? [...opts.seed] : [];
  const calls: string[] = [];
  let staleOnce = true;
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const summary = (c: MockCard) => ({
    id: c.id, code: `TK-${String(c.number).padStart(4, "0")}`, number: c.number, productId: "p1", projectId: "proj-head", kind: c.kind, title: c.title, state: c.state,
    status: c.state === "promoted" ? "promoted" : "open", origin: "manual", externalRef: null, blockedReason: null, draftProjectId: "draft-" + c.id,
    childProjectId: c.state === "promoted" ? "child-1" : null, executionStatus: c.state === "promoted" ? "materializing" : null, executionTitle: c.state === "promoted" ? "Produto Exemplo v2" : null,
    prUrl: null, attachmentsCount: 0, createdAt: "2026-11-04T10:00:00Z", updatedAt: new Date().toISOString(), promotedAt: null, deliveredAt: null,
  });
  const actions = (c: MockCard) => ({
    edit: c.state === "draft" || c.state === "refining", refine: c.state === "draft" || c.state === "ready", ready: c.state === "draft" || c.state === "refining",
    promote: c.state === "ready", revalidate: c.state === "ready" || c.state === "refining", reject: c.state !== "promoted", resume: false, delete: c.state === "draft",
  });
  const detail = (c: MockCard) => ({ ...summary(c), body: c.body, attachments: [], events: [{ from: null, to: "draft", actor: "user", reason: null, childProjectId: null, at: "2026-11-04T10:00:00Z" }],
    base: { headProjectId: "proj-head", headVersion: 1, validatedAt: null }, actions: actions(c) });

  return page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const key = `${req.method()} ${p}`;
    calls.push(key);
    const m = (re: RegExp) => p.match(re);
    if (req.method() === "GET" && p === "/api/products/p1/cards/capabilities") return json(route, 200, { cardsBancada: opts.cardsBancada !== false, budget: { freeUsd: 12.5, minFreeUsd: 5 } });
    if (req.method() === "GET" && p === "/api/products/p1/cards") return json(route, 200, { items: cards.map(summary), total: cards.length, limit: 100, offset: 0 });
    if (req.method() === "POST" && p === "/api/products/p1/cards") {
      const body = req.postData() ?? "";
      const get = (n: string) => new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1] ?? "";
      const c: MockCard = { id: `c${cards.length + 1}`, number: cards.length + 1, kind: get("kind") || "evolution", title: get("title") || "Sem título", body: get("body"), state: "draft" };
      cards.push(c);
      return json(route, 201, { ...summary(c), body: c.body });
    }
    let r = m(/^\/api\/cards\/([^/]+)$/);
    if (r && req.method() === "GET") { const c = cards.find((x) => x.id === r![1]); return c ? json(route, 200, detail(c)) : json(route, 404, { code: "NOT_FOUND", message: "x" }); }
    r = m(/^\/api\/cards\/([^/]+)\/(refine|ready|revalidate|promote|reject)$/);
    if (r && req.method() === "POST") {
      const c = cards.find((x) => x.id === r![1])!;
      if (r[2] === "refine") c.state = "refining";
      if (r[2] === "ready") c.state = "ready";
      if (r[2] === "revalidate") c.state = "refining";
      if (r[2] === "promote") {
        if (staleOnce) { staleOnce = false; c.state = "refining"; return json(route, 409, { code: "CARD_BASE_STALE", message: "base", expectedHead: "a", currentHead: "b", revalidate: `/api/cards/${c.id}/revalidate` }); }
        c.state = "promoted";
        return json(route, 201, { childProjectId: "child-1", versionNumber: 2, cardId: c.id, cardState: "promoted" });
      }
      return json(route, 200, { ok: true, card: summary(c) });
    }
    r = m(/^\/api\/cards\/([^/]+)\/base-spec$/);
    if (r) return json(route, 200, { readOnly: true, headProjectId: "proj-head", headVersion: 1, title: "Produto Exemplo", specHash: "h", baseHeadProjectId: "proj-head", stale: false,
      files: [{ path: "spec.md", relDir: "", filename: "spec.md", isPrimary: true, sizeBytes: 40, contentSha256: "s", content: "# Produto Exemplo\n\nEspecificação inicial v1.", truncated: false }] });
    if (m(/^\/api\/cards\/[^/]+\/journey$/)) return json(route, 404, { code: "NOT_FOUND", message: "x" });
    if (p === "/api/projects/draft-c1/spec-files" || p.endsWith("/spec-files")) return json(route, 200, [{ id: "f1", filename: "spec.md", filePath: "/x/spec.md", relDir: "", isPrimary: false }]);
    if (p.endsWith("/spec-file")) return json(route, 200, { path: "spec.md", content: "# Spec do card\n\nExportar relatório em CSV.", contentSha256: "sha1", isPrimary: false });
    if (p.endsWith("/spec-versions")) return json(route, 200, { versions: [], total: 0 });
    if (p.endsWith("/spec-validation") || p.includes("validation")) return json(route, 200, {});
    if (p === "/api/notifications") return json(route, 200, []);
    return json(route, 200, []);
  }).then(() => calls);
}

test("criar card, ver no quadro, abrir, validar e promover (com base vencida e revalidação)", async ({ page }) => {
  await seedSession(page);
  const calls = await mockApi(page);
  await page.goto("/products/p1/cards");

  await expect(page.getByRole("heading", { name: "Cards do produto" })).toBeVisible();
  await expect(page.getByText(/ainda não tem cards/)).toBeVisible();
  fs.mkdirSync(SHOTS, { recursive: true });

  // criar
  await page.getByRole("button", { name: "Novo card" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Novo card" });
  await expect(dlg.getByText("Modo de trabalho: Branch git.")).toBeVisible();
  await expect(dlg.getByText(/Saldo livre: US\$ 12\.50 · mínimo exigido para promover: US\$ 5\.00/)).toBeVisible();
  await dlg.getByRole("radio", { name: /Correção/ }).check();
  await dlg.getByLabel(/Título/).fill("Relatório em CSV vem vazio");
  await dlg.getByLabel(/Descrição do pedido/).fill("Ao exportar o relatório mensal o CSV vem vazio.");
  await dlg.getByRole("button", { name: "Criar card" }).click();

  // abre a tela do card; volta ao quadro e vê o card em Rascunho
  await expect(page.getByRole("heading", { name: /TK-0001 · Relatório em CSV vem vazio/ })).toBeVisible();
  await expect(page.getByTestId("kind-rite")).toContainText("cenário de reprodução");
  await page.getByRole("link", { name: "← Quadro de cards" }).click();
  await expect(page.getByRole("heading", { name: "Rascunho (1)" })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "quadro-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "Relatório em CSV vem vazio" }).click();

  // refinar → spec do card (inicial × card) → validar
  await page.getByRole("button", { name: "Iniciar refinamento" }).click();
  await page.getByRole("tab", { name: "Especificação do card" }).click();
  await expect(page.getByText("Spec inicial · somente leitura")).toBeVisible();
  await expect(page.getByText("Spec deste card", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Conteúdo somente leitura de spec.md")).toContainText("Especificação inicial v1");
  await page.screenshot({ path: path.join(SHOTS, "card-spec-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Validar" }).click();
  await expect(page.getByTestId("spec-locked")).toBeVisible();

  // promover: base vencida → revalidar → validar → promover
  await page.getByRole("button", { name: "Promover à fábrica" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "base vencida" })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "card-base-vencida-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Revalidar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Base revalidada" })).toBeVisible();
  await page.getByRole("button", { name: "Validar" }).click();
  await page.getByRole("button", { name: "Promover à fábrica" }).click();
  await expect(page.getByTestId("promote-done")).toContainText("Card promovido à fábrica.");
  await expect(page.getByRole("link", { name: "Produto Exemplo v2" })).toHaveAttribute("href", "/projects/child-1");

  expect(calls.filter((c) => c === "POST /api/cards/c1/promote")).toHaveLength(2);
  expect(calls.some((c) => /evolve/.test(c))).toBe(false);
});

test("quadro em 320 px: sem rolagem horizontal, colunas empilhadas e rótulos acessíveis", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await seedSession(page);
  await mockApi(page, { seed: [
    { id: "c1", number: 1, kind: "evolution", title: "Exportar relatório em CSV", body: "x", state: "draft" },
    { id: "c2", number: 2, kind: "fix", title: "Corrigir cálculo do frete", body: "x", state: "refining" },
    { id: "c3", number: 3, kind: "feature", title: "Painel de métricas", body: "x", state: "ready" },
  ] });
  await page.goto("/products/p1/cards");
  await expect(page.getByRole("heading", { name: "Pronto (1)" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("group", { name: "Estados exibidos" })).toBeVisible();
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, "quadro-320.png"), fullPage: true });
});

test("flag desligada: o quadro explica que cards não estão habilitados", async ({ page }) => {
  await seedSession(page);
  await mockApi(page, { cardsBancada: false });
  await page.goto("/products/p1/cards");
  await expect(page.getByText(/não estão habilitados para este tenant/)).toBeVisible();
});
