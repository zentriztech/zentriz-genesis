import { test, expect, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { body } from "../lib/cards/contractFixtures";
import { detailOf, journeyOf, type FixtureState } from "../lib/cards/cardFixtures";
import type { CardDetail, CardSummary } from "../lib/cards/types";

// E2E dos cards da Bancada: portal buildado + API SIMULADA com as RESPOSTAS REAIS do backend (`lib/cards/__contract__`, geradas pelo
// teste de contrato do api-node). Nenhuma chamada sai do navegador para backend real: toda `/api/**` é interceptada.

const SHOTS = process.env.E2E_SHOTS_DIR ?? path.resolve(__dirname, "../../../../project/docs/analysis/img-x");
const PID = detailOf("draft").productId;
const CID = detailOf("draft").id;

async function seedSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("genesis_token", "e2e-token");
    localStorage.setItem("genesis_user", JSON.stringify({ id: "u1", email: "teste@example.com", name: "Pessoa de Teste", tenantId: "t1", role: "tenant_admin", status: "active", createdAt: "2026-01-01T00:00:00Z" }));
    localStorage.setItem("genesis_tenant", "");
  });
}

const JOURNEY_BY_STATE: Record<FixtureState, string> = {
  draft: "draft-no-rfc", refining: "refining", ready: "ready", promoted: "promoted", in_factory: "in_factory", blocked: "blocked-budget", delivered: "delivered", rejected: "rejected",
};
const shot = async (page: Page, name: string) => { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };
const summaryOf = (d: CardDetail): CardSummary => { const { body: _b, attachments: _a, events: _e, base: _ba, actions: _ac, ...s } = d; void _b; void _a; void _e; void _ba; void _ac; return s; };

interface MockOpts { cardsBancada?: boolean; state?: FixtureState; journey?: string; list?: CardDetail[]; staleAfterReady?: boolean }

/** API simulada: máquina de estados mínima que devolve, em cada estado, o detalhe e a jornada REAIS gravados pelo backend. */
async function mockApi(page: Page, opts: MockOpts = {}) {
  const st = { state: opts.state ?? ("draft" as FixtureState), journey: opts.journey as string | undefined, stale: !!opts.staleAfterReady, created: !!opts.state || !!opts.list };
  const calls: string[] = [];
  const json = (route: Route, status: number, b: unknown, headers: Record<string, string> = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(b) });
  const jName = () => st.journey ?? (st.state === "ready" && st.stale ? "ready-base-stale" : JOURNEY_BY_STATE[st.state]);
  const jbody = () => ({ ...journeyOf(jName()) });
  const set = (s: FixtureState, j?: string) => { st.state = s; st.journey = j; };

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const key = `${req.method()} ${p}`;
    calls.push(key);
    const m = req.method();
    if (m === "GET" && p.endsWith("/cards/capabilities")) return json(route, 200, { cardsBancada: opts.cardsBancada !== false });
    if (m === "GET" && /^\/api\/products\/[^/]+\/cards$/.test(p)) {
      const items = opts.list ? opts.list.map(summaryOf) : st.created ? [summaryOf(detailOf(st.state))] : [];
      return json(route, 200, { items, total: items.length, limit: 100, offset: 0 });
    }
    if (m === "POST" && /^\/api\/products\/[^/]+\/cards$/.test(p)) { st.created = true; set("draft"); return json(route, 201, body("create.201")); }
    let r = p.match(/^\/api\/cards\/([^/]+)$/);
    if (r && m === "GET") {
      const fromList = opts.list?.find((c) => c.id === r![1]);
      return json(route, 200, fromList ?? detailOf(st.state));
    }
    if (m === "GET" && /\/journey$/.test(p)) {
      const fromList = opts.list?.find((c) => p.includes(c.id));
      if (fromList) return json(route, 200, journeyOf(JOURNEY_BY_STATE[fromList.state as FixtureState]));
      return json(route, 200, jbody());
    }
    if (m === "GET" && /\/base-spec$/.test(p)) return json(route, 200, body("base-spec.200"));
    if (m === "GET" && /\/attachments$/.test(p)) return json(route, 200, { items: [], strict: false, conversionEnabled: false, summary: {} });
    r = p.match(/^\/api\/cards\/([^/]+)\/(refine|ready|revalidate|reopen|promote|reject|resume)$/);
    if (r && m === "POST") {
      switch (r[2]) {
        case "refine": set("refining"); return json(route, 200, body("refine.200"));
        case "ready": set("ready"); return json(route, 200, body("ready.200"));
        case "revalidate": if (st.stale && st.state === "ready") { st.stale = false; set("refining"); return json(route, 200, body("revalidate.stale")); } return json(route, 200, body("revalidate.ok"));
        case "reopen": set("refining"); return json(route, 200, body("reopen.200"));
        case "promote": set("promoted"); return json(route, 201, body("promote.201"));
        case "resume": set("in_factory"); return json(route, 200, body("resume.200-child-restart-required"));
        default: set("rejected"); return json(route, 200, body("reject.200"));
      }
    }
    if (/\/spec-files$/.test(p)) return json(route, 200, [{ id: "f1", filename: "spec.md", filePath: "/x/spec.md", relDir: "", isPrimary: false }]);
    if (/\/spec-file$/.test(p)) return json(route, 200, { path: "spec.md", content: "# Spec do card\n\nExportar entregas em CSV.", contentSha256: "sha1", isPrimary: false });
    if (/spec-versions$/.test(p)) return json(route, 200, { versions: [], total: 0 });
    if (p === "/api/notifications") return json(route, 200, []);
    return json(route, 200, []);
  });
  return { calls, st };
}

test("ciclo: criar, refinar, validar, base vencida, revalidar, validar de novo e promover", async ({ page }) => {
  await seedSession(page);
  const { calls } = await mockApi(page, { staleAfterReady: true });
  await page.goto(`/products/${PID}/cards`);

  await expect(page.getByRole("heading", { name: "Cards do produto" })).toBeVisible();
  await expect(page.getByText(/ainda não tem cards/)).toBeVisible();

  // criar (o diálogo não promete saldo nem limites que o backend não informa)
  await page.getByRole("button", { name: "Novo card" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Novo card" });
  await expect(dlg.getByText(/Como o card chega à fábrica:/)).toBeVisible();
  await expect(dlg.getByText(/O saldo é conferido pelo servidor/)).toBeVisible();
  await dlg.getByRole("radio", { name: /Recurso novo/ }).check();
  await dlg.getByLabel(/Título/).fill("Exportar entregas em CSV");
  await dlg.getByLabel(/Descrição do pedido/).fill("Quero baixar a lista de entregas em CSV.");
  await dlg.getByRole("button", { name: "Criar card" }).click();

  // tela do card em rascunho: headline, bloqueio e ação sugerida do servidor
  await expect(page.getByRole("heading", { name: /TK-0001 · Exportar entregas em CSV/ })).toBeVisible();
  await expect(page.getByTestId("journey-headline")).toHaveText("Falta o RFC do card");
  await expect(page.getByTestId("journey-blockers")).toContainText("Falta o RFC do card, com critérios de aceite em Gherkin");
  await expect(page.getByRole("button", { name: "Gerar o RFC com a IA" })).toBeVisible();
  await shot(page, "card-rascunho-sem-rfc-desktop.png");
  await page.getByRole("link", { name: "← Quadro de cards" }).click();
  await expect(page.getByRole("heading", { name: "Rascunho (1)" })).toBeVisible();
  await shot(page, "quadro-desktop.png");
  await page.getByRole("link", { name: "Exportar entregas em CSV" }).first().click();

  // refinar → spec do card (inicial × card) → validar → travada
  await page.getByRole("button", { name: "Iniciar refinamento" }).click();
  await page.getByRole("tab", { name: "Especificação do card" }).click();
  await expect(page.getByText("Spec inicial · somente leitura")).toBeVisible();
  await expect(page.getByText("Spec deste card", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Conteúdo somente leitura de spec.md")).toContainText("O app lista entregas");
  await shot(page, "card-spec-desktop.png");
  await page.getByRole("button", { name: "Validar", exact: true }).click();
  await expect(page.getByTestId("spec-locked")).toBeVisible();
  await shot(page, "card-spec-travada-desktop.png");

  // o servidor informa base vencida: aviso com versões, promover desabilitado
  await expect(page.getByTestId("base-stale")).toContainText("o produto avançou para a v2");
  await expect(page.getByRole("button", { name: "Promover à fábrica" })).toBeDisabled();
  await shot(page, "card-base-vencida-desktop.png");
  await page.getByRole("button", { name: "Revalidar contra a versão corrente" }).click();
  await expect(page.getByTestId("revalidate-stale")).toContainText("Base atualizada: valide o card de novo");
  await expect(page.getByTestId("journey-headline")).toHaveText("Pronto para validar");

  // validar de novo e promover (POST /promote, nunca o /evolve legado)
  await page.getByRole("button", { name: "Validar", exact: true }).click();
  await expect(page.getByTestId("journey-headline")).toHaveText("Pronto para promover");
  await shot(page, "card-pronto-desktop.png");
  await page.getByRole("button", { name: "Promover à fábrica" }).click();
  await expect(page.getByTestId("promote-done")).toContainText("Card promovido à fábrica.");
  await expect(page.getByRole("link", { name: /Evolução v2/ }).first()).toHaveAttribute("href", /\/projects\//);
  await shot(page, "card-promovido-desktop.png");

  expect(calls.filter((c) => c === `POST /api/cards/${CID}/promote`)).toHaveLength(1);
  expect(calls.some((c) => /evolve/.test(c))).toBe(false);
});

test("estados da tela do card: bloqueado por orçamento, entregue com PR e reabrir para edição", async ({ page }) => {
  await seedSession(page);
  const mock = await mockApi(page, { state: "blocked" });
  await page.goto(`/cards/${CID}`);
  await expect(page.getByTestId("journey-headline")).toHaveText("Bloqueado por orçamento");
  await expect(page.getByText(/Motivo do bloqueio:/)).toContainText("orçamento — O orçamento de IA está pausado");
  await expect(page.getByTestId("journey-blockers")).toContainText("O card está bloqueado por orçamento");
  await shot(page, "card-bloqueado-orcamento-desktop.png");
  await page.getByRole("button", { name: "Retomar o card" }).click();
  await expect(page.getByTestId("restart-needed")).toContainText("a execução continua parada");
  await shot(page, "card-retomado-reiniciar-desktop.png");

  mock.st.state = "delivered"; mock.st.journey = undefined;
  await page.goto(`/cards/${CID}`);
  await expect(page.getByTestId("journey-headline")).toHaveText("Entregue");
  await expect(page.getByTestId("pr-link")).toHaveAttribute("href", "https://github.com/zentriz-demo/entregas/pull/42");
  await shot(page, "card-entregue-pr-desktop.png");

  mock.st.state = "ready"; mock.st.stale = false;
  await page.goto(`/cards/${CID}?tab=spec`);
  await page.getByRole("tab", { name: "Especificação do card" }).click();
  await page.getByTestId("spec-locked").getByRole("button", { name: "Reabrir para edição" }).click();
  await expect(page.getByTestId("journey-headline")).not.toHaveText("Pronto para promover");
  expect(mock.calls).toContain(`POST /api/cards/${CID}/reopen`);
  mock.st.state = "rejected";
  await page.goto(`/cards/${CID}`);
  await expect(page.getByTestId("journey-headline")).toHaveText("Card recusado");
  await shot(page, "card-rejeitado-desktop.png");
});

test("quadro com cards em todos os estados e em 320 px: sem rolagem horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await seedSession(page);
  const states: FixtureState[] = ["draft", "refining", "ready", "promoted", "in_factory", "blocked", "delivered", "rejected"];
  const list = states.map((s, i) => ({ ...detailOf(s), id: `${detailOf(s).id.slice(0, -2)}${String(i + 10)}`, code: `TK-${String(i + 1).padStart(4, "0")}`, title: `Card ${s}` }));
  await mockApi(page, { list });
  await page.goto(`/products/${PID}/cards`);
  await expect(page.getByRole("heading", { name: "Pronto (1)" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect(page.getByRole("group", { name: "Estados exibidos" })).toBeVisible();
  await expect(page.getByTestId("card-tile-TK-0006")).toContainText("Bloqueado: orçamento — O orçamento de IA está pausado");
  await shot(page, "quadro-320.png");
});

for (const [state, journey] of [["ready", "ready-base-stale"], ["blocked", undefined], ["delivered", undefined], ["draft", undefined]] as Array<[FixtureState, string | undefined]>) {
  test(`tela do card em 320 px (${journey ?? state}): sem rolagem horizontal e conteúdo legível`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await seedSession(page);
    await mockApi(page, { state, journey });
    await page.goto(`/cards/${CID}`);
    await expect(page.getByTestId("journey-headline")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await shot(page, `card-${journey ?? state}-320.png`);
  });
}

test("flag desligada: o quadro explica que cards não estão habilitados", async ({ page }) => {
  await seedSession(page);
  await mockApi(page, { cardsBancada: false });
  await page.goto(`/products/${PID}/cards`);
  await expect(page.getByText(/não estão habilitados para este tenant/)).toBeVisible();
});

// ── Acessibilidade medida (WCAG 2.2): foco visível, alvos ≥ 24 px, contraste de texto ───────────────────────────
function lum(rgb: number[]) { const f = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; }

for (const mode of ["dark", "light"] as const) test(`acessibilidade (tema ${mode}): alvos ≥ 24 px, foco visível e contraste do texto na tela do card (evidência em a11y-${mode}.json)`, async ({ page }) => {
  await seedSession(page);
  await page.addInitScript((m) => localStorage.setItem("genesis_theme", m), mode);
  await mockApi(page, { state: "ready", journey: "ready-base-stale" });
  await page.goto(`/cards/${CID}`);
  await expect(page.getByTestId("journey-headline")).toBeVisible();

  const targets = await page.evaluate(() => {
    const out: Array<{ name: string; w: number; h: number }> = [];
    document.querySelectorAll<HTMLElement>("main button, main [role=tab], main a[href], main input, main select, button").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") return;
      out.push({ name: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
    });
    return out;
  });
  // links em linha de texto são isentos (WCAG 2.5.8, exceção "inline"); botões, abas e controles precisam de 24x24
  const controls = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("button, [role=tab], input, select")).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).opacity !== "0" && el.getAttribute("aria-hidden") !== "true"; }).map((el) => { const r = el.getBoundingClientRect(); return { name: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; }));
  const small = controls.filter((c) => c.w < 24 || c.h < 24);

  // foco visível: percorre os primeiros controles com Tab e mede outline/box-shadow do elemento focado
  const focus: Array<{ name: string; visible: boolean; inMain: boolean }> = [];
  await page.getByRole("link", { name: "← Quadro de cards" }).focus();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    focus.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { name: "(corpo)", visible: true, inMain: false };
      const cs = getComputedStyle(el);
      const ring = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2;
      const field = !!el.closest(".Mui-focused");          // campos de texto: a borda de 2 px do MUI
      return { name: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40), visible: ring || field, inMain: !!el.closest("main") };
    }));
  }

  // contraste: cor do texto × fundo efetivo (sobe a árvore até achar fundo opaco)
  const contrast = await page.evaluate(() => {
    const parse = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const bgOf = (el: Element | null): number[] => {
      let cur = el; const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
      while (cur) { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } cur = cur.parentElement; }
      let base = [255, 255, 255];
      for (const l of layers.reverse()) base = [l.r * l.a + base[0] * (1 - l.a), l.g * l.a + base[1] * (1 - l.a), l.b * l.a + base[2] * (1 - l.a)];
      return base;
    };
    const out: Array<{ text: string; fg: number[]; bg: number[]; size: number; weight: number }> = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = (n.textContent ?? "").trim(); const el = n.parentElement;
      if (!t || !el || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none") continue;
      if (el.closest("button:disabled, [aria-disabled=true], .Mui-disabled, nav, aside, header")) continue;   // desabilitado é isento (1.4.3); o menu do portal é de outra tela
      const fgc = parse(cs.color); if (!fgc) continue;
      const bg = bgOf(el);
      const fg = [fgc.r * fgc.a + bg[0] * (1 - fgc.a), fgc.g * fgc.a + bg[1] * (1 - fgc.a), fgc.b * fgc.a + bg[2] * (1 - fgc.a)];
      out.push({ text: t.slice(0, 50) + " <" + el.tagName.toLowerCase() + "." + String(el.className).split(" ").slice(0, 2).join(".") + ">", fg, bg, size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400 });
    }
    return out;
  });
  const rows = contrast.map((c) => { const a = lum(c.fg), b = lum(c.bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); const large = c.size >= 24 || (c.size >= 18.66 && c.weight >= 700); return { text: c.text, ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5 }; });
  const failing = rows.filter((r) => r.ratio < r.need);

  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `a11y-${mode}.json`), JSON.stringify({
    pagina: "/cards/:id (pronto, base vencida)", tema: mode, alvos: { total: controls.length, menoresQue24px: small, linksEmLinhaNaoContados: targets.length - controls.length },
    foco: focus, contraste: { amostras: rows.length, minimo: Math.min(...rows.map((r) => r.ratio)), abaixoDoMinimo: failing },
  }, null, 2));

  expect.soft(small, "controles menores que 24x24").toEqual([]);
  expect.soft(focus.filter((f) => f.inMain && !f.visible), "controles do card sem foco visível").toEqual([]);
  expect.soft(failing, "textos abaixo do contraste mínimo (4.5:1; 3:1 para texto grande)").toEqual([]);
  await shot(page, `card-a11y-${mode}-desktop.png`);
});
