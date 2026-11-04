import { test, expect } from "@playwright/test";

// Página pública do portal buildado (sem login real). Toda chamada a /api/** é interceptada e
// respondida por uma API simulada — o teste nunca depende de backend.
test("página /login renderiza o formulário de acesso do usuário", async ({ page }) => {
  const apiCalls: string[] = [];
  await page.route("**/api/**", async (route) => {
    apiCalls.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) });
  });

  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Acesso — Usuário" })).toBeVisible();
  await expect(page.getByLabel(/E-mail/)).toBeVisible();
  await expect(page.getByLabel(/Senha/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Entrar" })).toBeEnabled();
});
