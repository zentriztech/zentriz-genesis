import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// E2E REAL (Y-15): navegador → portal buildado → api-node REAL (rotas, auth, SQL e travas do servidor; Postgres efêmero 55441; LLM stub).
// Nada de respostas gravadas: o que a tela mostra vem do servidor. As chamadas `/api/**` do navegador são encaminhadas à API real
// (o `next start` desta build tem o proxy apontando para o stack Docker, que não existe aqui).
const API = "http://127.0.0.1:3461";
const CTL = "http://127.0.0.1:3462";
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.resolve(__dirname, "../../../../project/docs/analysis/img-aa");
const shot = async (page: Page, name: string) => { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };

interface Seed { tenantId: string; userId: string; productId: string; parentId: string; email: string; token: string }
const seed = async (): Promise<Seed> => (await fetch(`${CTL}/seed`)).json() as Promise<Seed>;

async function login(page: Page, s: Seed) {
  const calls: string[] = [];
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    calls.push(`${route.request().method()} ${u.pathname}`);
    return route.continue({ url: `${API}${u.pathname}${u.search}` });
  });
  await page.addInitScript((a) => {
    localStorage.setItem("genesis_token", a.token);
    localStorage.setItem("genesis_user", JSON.stringify({ id: a.userId, email: a.email, name: "Pessoa de Teste", tenantId: a.tenantId, role: "tenant_admin", status: "active", createdAt: "2026-01-01T00:00:00Z" }));
    localStorage.setItem("genesis_tenant", "");
  }, s);
  return calls;
}

async function createCard(page: Page, s: Seed) {
  await page.goto(`/products/${s.productId}/cards`);
  await expect(page.getByRole("heading", { name: "Cards do produto" })).toBeVisible();
  await page.getByRole("button", { name: "Novo card" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Novo card" });
  await dlg.getByRole("radio", { name: /Recurso novo/ }).check();
  await dlg.getByLabel(/Título/).fill("Exportar entregas em CSV");
  await dlg.getByLabel(/Descrição do pedido/).fill("Quero baixar a lista de entregas em CSV.");
  await dlg.getByRole("button", { name: "Criar card" }).click();
  await expect(page.getByRole("heading", { name: /TK-0001 · Exportar entregas em CSV/ })).toBeVisible();
}

async function writeRfc(page: Page) {
  await page.getByRole("tab", { name: "Especificação do card" }).click();
  // rascunho novo: só o pedido (tickets/TK-0001/request.md), e o servidor real devolve esse arquivo
  await expect(page.getByRole("combobox", { name: /Arquivo do card/ })).toContainText("tickets/TK-0001/request.md");
  await expect(page.locator(".cm-content").first()).toContainText("Quero baixar a lista de entregas em CSV");
  await page.getByRole("button", { name: "Gerar RFC com a IA" }).click();
  await expect(page.getByTestId("plan-done")).toContainText("docs/rfc/RFC-0001-exportar-csv.md", { timeout: 30_000 });
  await expect(page.getByRole("combobox", { name: /Arquivo do card/ })).toContainText("docs/rfc/RFC-0001-exportar-csv.md");
  await expect(page.locator(".cm-content").first()).toContainText("Exportar entregas em CSV");
}

test("API real: criar card → escrever o RFC (planner) → validar → promover", async ({ page }) => {
  const s = await seed();
  const calls = await login(page, s);
  await createCard(page, s);
  await expect(page.getByTestId("journey-headline")).toHaveText("Falta o RFC do card");
  await writeRfc(page);
  await shot(page, "real-card-rfc-gerado.png");

  // o caminho antigo que a tela sugeria é recusado ANTES de chamar o servidor (escopo do card)
  await page.getByLabel(/Novo arquivo/).fill("rfc/RFC-001.md");
  await expect(page.getByText(/O card só escreve em tickets\/TK-0001\/\*\*, docs\/rfc\/\*\*, docs\/adr\/\*\*\./).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Criar arquivo" })).toBeDisabled();

  // editar o RFC e salvar com If-Match (servidor real confere o sha)
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n- Observação do refinamento.\n");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText(/Salvo\. Valide o card/)).toBeVisible();

  // validar: o gate de RFC é do servidor
  await page.getByRole("button", { name: "Validar", exact: true }).click();
  await expect(page.getByTestId("journey-headline")).toHaveText("Pronto para promover", { timeout: 20_000 });
  await expect(page.getByTestId("spec-locked")).toBeVisible();
  await shot(page, "real-card-pronto.png");

  // travado: o servidor recusa escrita; reabrir destrava; validar de novo
  await page.getByTestId("spec-locked").getByRole("button", { name: "Reabrir para edição" }).click();
  await expect(page.getByTestId("journey-headline")).not.toHaveText("Pronto para promover");
  await page.getByRole("button", { name: "Validar", exact: true }).click();
  await expect(page.getByTestId("journey-headline")).toHaveText("Pronto para promover", { timeout: 20_000 });

  await page.getByRole("button", { name: "Promover à fábrica" }).click();
  await expect(page.getByTestId("promote-done")).toContainText("Card promovido à fábrica.", { timeout: 30_000 });
  await expect(page.getByRole("link", { name: /Evolução v2|v2/ }).first()).toHaveAttribute("href", /\/projects\//);
  await shot(page, "real-card-promovido.png");

  expect(calls.filter((c) => /\/promote$/.test(c))).toHaveLength(1);
  expect(calls.some((c) => /\/evolve$/.test(c))).toBe(false);
  expect(calls.some((c) => /\/evolution-plan$/.test(c))).toBe(true);
});

test("API real: base vencida (o produto avançou de versão) bloqueia a promoção; revalidar e validar de novo promovem", async ({ page }) => {
  const s = await seed();
  await login(page, s);
  await createCard(page, s);
  await writeRfc(page);
  await page.getByRole("button", { name: "Validar", exact: true }).click();
  await expect(page.getByTestId("journey-headline")).toHaveText("Pronto para promover", { timeout: 20_000 });

  expect((await fetch(`${CTL}/add-v2?parent=${s.parentId}`)).ok).toBe(true);
  await page.reload();
  await expect(page.getByTestId("base-stale")).toContainText("o produto avançou para a v2", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Promover à fábrica" })).toBeDisabled();
  await shot(page, "real-card-base-vencida.png");

  await page.getByRole("button", { name: "Revalidar contra a versão corrente" }).click();
  await expect(page.getByTestId("revalidate-stale")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Validar", exact: true }).click();
  await expect(page.getByTestId("journey-headline")).toHaveText("Pronto para promover", { timeout: 20_000 });
  await page.getByRole("button", { name: "Promover à fábrica" }).click();
  await expect(page.getByTestId("promote-done")).toContainText("Card promovido à fábrica.", { timeout: 30_000 });
});
