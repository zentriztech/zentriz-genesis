import { test, expect, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { body, specBody } from "../lib/cards/contractFixtures";
import { detailOf, journeyOf, type FixtureState } from "../lib/cards/cardFixtures";
import type { CardDetail, CardSummary } from "../lib/cards/types";

// E2E dos cards da Bancada: portal buildado + API SIMULADA com as RESPOSTAS REAIS do backend (`lib/cards/__contract__`, geradas pelo
// teste de contrato do api-node). Nenhuma chamada sai do navegador para backend real: toda `/api/**` é interceptada.

const SHOTS = process.env.E2E_SHOTS_DIR ?? path.resolve(__dirname, "../../../../project/docs/analysis/img-aa");
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

interface MockOpts { cardsBancada?: boolean; state?: FixtureState; journey?: string; list?: CardDetail[]; staleAfterReady?: boolean; withRfc?: boolean }

/** API simulada: máquina de estados mínima que devolve, em cada estado, o detalhe e a jornada REAIS gravados pelo backend. */
async function mockApi(page: Page, opts: MockOpts = {}) {
  const st = { state: opts.state ?? ("draft" as FixtureState), journey: opts.journey as string | undefined, stale: !!opts.staleAfterReady, created: !!opts.state || !!opts.list, planned: false, rfc: !!opts.withRfc || (!!opts.state && opts.state !== "draft") };
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
    // Rotas de spec do rascunho: as RESPOSTAS REAIS do backend (`__contract__/spec/`), nunca arquivos na raiz que o servidor recusa.
    if (m === "GET" && /\/spec-tree$/.test(p)) return json(route, 200, specBody(st.planned ? "spec-tree.after-plan" : st.rfc ? "spec-tree.with-rfc" : "spec-tree.draft"));
    if (m === "GET" && /\/spec-file$/.test(p)) {
      const q = new URL(req.url()).searchParams.get("path") ?? "";
      return q.startsWith("tickets/") ? json(route, 200, specBody("spec-file.get-request")) : json(route, 200, specBody("spec-file.get-200"));
    }
    if (m === "PUT" && /\/spec-file$/.test(p)) return json(route, 200, specBody("spec-file.put-200"));
    if (m === "POST" && /\/spec-file$/.test(p)) {
      const sent = req.postDataJSON() as { path?: string };
      if (!/^(docs\/rfc\/|docs\/adr\/|tickets\/)/.test(sent.path ?? "")) return json(route, 400, specBody("spec-file.post-400-fora-do-escopo"));
      st.rfc = true; return json(route, 201, specBody("spec-file.post-201"));
    }
    if (m === "POST" && /\/evolution-plan$/.test(p)) { st.rfc = true; st.planned = true; return json(route, 202, specBody("evolution-plan.post-202")); }
    if (m === "GET" && /\/evolution-plan\/[^/]+$/.test(p)) { if (st.state === "draft") set("refining", "refining"); return json(route, 200, specBody("evolution-plan.get-done")); }
    if (m === "POST" && p === "/api/spec-chat") return json(route, 202, specBody("spec-chat.post-202"));
    if (m === "GET" && /^\/api\/spec-chat\/[^/]+$/.test(p)) return json(route, 200, specBody("spec-chat.get-done"));
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
  // Y-03: o rascunho NOVO só tem o pedido (tickets/TK-0001/request.md); a aba o mostra e oferece gerar o RFC (planner), não um spec.md na raiz
  await expect(page.getByRole("combobox", { name: /Arquivo do card/ })).toContainText("tickets/TK-0001/request.md");
  await expect(page.getByText("O rascunho ainda não tem arquivos")).toHaveCount(0);
  await expect(page.getByText("O pedido original (TK-0001) é imutável")).toBeVisible();
  await shot(page, "card-spec-desktop.png");
  await page.getByRole("button", { name: "Gerar RFC com a IA" }).click();
  await expect(page.getByTestId("plan-done")).toContainText("Exportar entregas em CSV");
  await expect(page.getByRole("combobox", { name: /Arquivo do card/ })).toContainText("docs/rfc/RFC-0002-exportar-csv.md");
  await expect(page.locator(".cm-content").first()).toContainText("Exportar entregas em CSV");
  await shot(page, "card-spec-rfc-gerado-desktop.png");
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
  expect(calls.filter((c) => /\/evolution-plan$/.test(c))).toHaveLength(1);
  expect(calls.some((c) => /\/spec-files$/.test(c))).toBe(false);
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
  await expect(page.getByRole("combobox", { name: /Arquivo do card/ })).toContainText("docs/rfc/RFC-0001-exportar-csv.md");
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

// ── Acessibilidade medida (WCAG 2.2) + axe-core (Y-12) ─────────────────────────────────────────────────────────
// Para cada tela de cards e tema: alvos ≥ 24 px (inclui `a[role=button]` e `a.MuiButton-root`), foco visível por Tab, contraste de texto
// (fórmula WCAG com composição de alfa e `opacity` dos ancestrais) e axe-core (regras WCAG 2.x A/AA + best-practice). Os números dos
// relatórios saem destes JSON (`a11y-<tela>-<tema>.json`, `axe-<tela>-<tema>.json`), nunca de contagem manual.
import AxeBuilder from "@axe-core/playwright";

function lum(rgb: number[]) { const f = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; }

type Screen = { key: string; width: number; open: (page: Page, mock: Awaited<ReturnType<typeof mockApi>>) => Promise<void>; scope: string; focusStart: string };
const SCREENS: Screen[] = [
  { key: "card", width: 1280, scope: "main", focusStart: "← Quadro de cards", open: async (page) => { await page.goto(`/cards/${CID}`); await expect(page.getByTestId("journey-headline")).toBeVisible(); } },
  { key: "card-spec", width: 1280, scope: "main", focusStart: "← Quadro de cards", open: async (page) => {
    await page.goto(`/cards/${CID}?tab=spec`); await page.getByRole("tab", { name: "Especificação do card" }).click();
    await expect(page.getByRole("combobox", { name: /Arquivo do card/ })).toContainText("RFC-0001"); } },
  { key: "quadro", width: 1280, scope: "main", focusStart: "Novo card", open: async (page) => { await page.goto(`/products/${PID}/cards`); await expect(page.getByRole("heading", { name: "Pronto (1)" })).toBeVisible(); } },
  { key: "dialogo-criacao", width: 1280, scope: ".MuiDialog-paper", focusStart: "", open: async (page) => {
    await page.goto(`/products/${PID}/cards`); await page.getByRole("button", { name: "Novo card" }).first().click(); await expect(page.getByRole("dialog", { name: "Novo card" })).toBeVisible(); await expect(page.locator(".MuiDialog-paper")).toHaveCSS("opacity", "1"); } },
  { key: "card-320", width: 320, scope: "main", focusStart: "← Quadro de cards", open: async (page) => { await page.goto(`/cards/${CID}`); await expect(page.getByTestId("journey-headline")).toBeVisible(); } },
  { key: "quadro-320", width: 320, scope: "main", focusStart: "Novo card", open: async (page) => { await page.goto(`/products/${PID}/cards`); await expect(page.getByRole("heading", { name: "Pronto (1)" })).toBeVisible(); } },
  { key: "dialogo-criacao-320", width: 320, scope: ".MuiDialog-paper", focusStart: "", open: async (page) => {
    await page.goto(`/products/${PID}/cards`); await page.getByRole("button", { name: "Novo card" }).first().click(); await expect(page.getByRole("dialog", { name: "Novo card" })).toBeVisible(); await expect(page.locator(".MuiDialog-paper")).toHaveCSS("opacity", "1"); } },
];

for (const mode of ["dark", "light"] as const) for (const sc of SCREENS) test(`acessibilidade (${sc.key}, tema ${mode}): alvos, foco, contraste e axe-core (evidência em a11y-${sc.key}-${mode}.json / axe-${sc.key}-${mode}.json)`, async ({ page }) => {
  await page.setViewportSize({ width: sc.width, height: 900 });
  await seedSession(page);
  await page.addInitScript((m) => localStorage.setItem("genesis_theme", m), mode);
  const states: FixtureState[] = ["draft", "refining", "ready", "promoted", "in_factory", "blocked", "delivered", "rejected"];
  const list = states.map((s, i) => ({ ...detailOf(s), id: `${detailOf(s).id.slice(0, -2)}${String(i + 10)}`, code: `TK-${String(i + 1).padStart(4, "0")}`, title: `Card ${s}` }));
  await mockApi(page, sc.key.startsWith("quadro") || sc.key.startsWith("dialogo") ? { list } : sc.key === "card-spec" ? { state: "refining", withRfc: true } : { state: "ready", journey: "ready-base-stale" });
  await sc.open(page, undefined as never);

  // alvos: botões, abas, campos e também links renderizados como botão (`a[role=button]`, `a.MuiButton-root`); links em linha de texto são isentos (2.5.8)
  const controls = await page.evaluate((scope) => {
    const root = document.querySelector(scope) ?? document.body;
    const sel = "button, [role=tab], [role=combobox], [role=radio], input, select, textarea, a[role=button], a.MuiButton-root";
    return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter((el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && el.getAttribute("aria-hidden") !== "true" && !(el as HTMLInputElement).hidden && !(cs.opacity === "0" && (el as HTMLInputElement).type !== "radio" && (el as HTMLInputElement).type !== "checkbox" && (el as HTMLInputElement).type !== "file");
    }).map((el) => { const r = el.getBoundingClientRect(); return { name: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40), tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) }; });
  }, sc.scope);
  const small = controls.filter((c) => c.w < 24 || c.h < 24);

  // foco visível: percorre os controles com Tab (até 20) e mede outline OU box-shadow do elemento focado
  const focus: Array<{ name: string; visible: boolean; inScope: boolean }> = [];
  // Começa pelo teclado de verdade: foco "programático" não aciona :focus-visible e daria falso negativo; `focusVisible: true` simula o Tab.
  if (sc.focusStart) await page.getByRole(sc.focusStart.startsWith("←") ? "link" : "button", { name: sc.focusStart }).first().evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions)); else await page.keyboard.press("Tab");
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(60);   // o CodeMirror aplica .cm-focused de forma assíncrona
    focus.push(await page.evaluate((scope) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { name: "(corpo)", visible: true, inScope: false };
      // radio/checkbox do MUI: o <input> é invisível e o anel de foco é desenhado no elemento pai (SwitchBase)
      const host = (el as HTMLInputElement).type === "radio" || (el as HTMLInputElement).type === "checkbox" ? (el.parentElement as HTMLElement) : el;
      const cmHost = el.closest(".cm-editor.cm-focused") as HTMLElement | null;   // CodeMirror: o anel fica no .cm-editor
      const cs = getComputedStyle(cmHost ?? host);
      const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow !== "none" && /\d+px/.test(cs.boxShadow));
      const field = !!el.closest(".Mui-focused");          // campos de texto: a borda de 2 px do MUI
      return { name: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40), visible: ring || field, inScope: !!el.closest(scope) };
    }, sc.scope));
    // O editor de código (CodeMirror) usa Tab para recuar; Esc e depois Tab sai dele (dito na tela). Fora dele, Tab direto.
    if (await page.evaluate(() => !!document.activeElement?.closest(".cm-content"))) await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
  }

  // contraste do texto: cor × fundo efetivo (sobe a árvore compondo alfa de fundos e a `opacity` dos ancestrais)
  const contrast = await page.evaluate((scope) => {
    const parse = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const opacityOf = (el: Element | null) => { let o = 1; for (let c = el; c; c = c.parentElement) o *= parseFloat(getComputedStyle(c).opacity); return o; };
    const bgOf = (el: Element | null): number[] => {
      let cur = el; const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
      while (cur) { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } cur = cur.parentElement; }
      let base = [255, 255, 255];
      for (const l of layers.reverse()) base = [l.r * l.a + base[0] * (1 - l.a), l.g * l.a + base[1] * (1 - l.a), l.b * l.a + base[2] * (1 - l.a)];
      return base;
    };
    const root = document.querySelector(scope) ?? document.body;
    // Fundo em degradê (botões contained do tema): vale o PIOR contraste entre as paradas do gradiente.
    const gradientStops = (el: Element | null): number[][] => {
      for (let cur = el; cur; cur = cur.parentElement) {
        const bi = getComputedStyle(cur).backgroundImage;
        if (bi && bi.includes("gradient")) return (bi.match(/rgba?\([^)]+\)/g) ?? []).map((c) => { const p = parse(c)!; return [p.r, p.g, p.b]; });
        const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a >= 1) break;
      }
      return [];
    };
    const out: Array<{ text: string; fg: number[]; bg: number[]; size: number; weight: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = (n.textContent ?? "").trim(); const el = n.parentElement;
      if (!t || !el || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none") continue;
      if (el.closest("button:disabled, [aria-disabled=true], .Mui-disabled")) continue;   // desabilitado é isento (1.4.3)
      const fgc = parse(cs.color); if (!fgc) continue;
      const op = opacityOf(el);
      if (op < 0.01) continue;                       // texto invisível (ex.: <legend> do campo outlined do MUI): não é lido por ninguém
      const stops = gradientStops(el);
      const bgs = stops.length ? stops : [bgOf(el)];
      const a = fgc.a * op;
      for (const bg of bgs) {
        const fg = [fgc.r * a + bg[0] * (1 - a), fgc.g * a + bg[1] * (1 - a), fgc.b * a + bg[2] * (1 - a)];
        out.push({ text: t.slice(0, 50) + " <" + el.tagName.toLowerCase() + "." + String(el.className).split(" ").slice(0, 2).join(".") + ">", fg, bg, size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400 });
      }
    }
    return out;
  }, sc.scope);
  const rows = contrast.map((c) => { const a = lum(c.fg), b = lum(c.bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); const large = c.size >= 24 || (c.size >= 18.66 && c.weight >= 700); return { text: c.text, ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5 }; });
  const failing = rows.filter((r) => r.ratio < r.need);

  // reflow (1.4.10): sem rolagem horizontal
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // axe-core no escopo da tela (o layout do portal, fora dos cards, não entra na conta)
  const axe = await new AxeBuilder({ page }).include(sc.scope).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  const violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")), detalhe: v.nodes[0]?.any[0]?.message ?? "" }));

  fs.mkdirSync(SHOTS, { recursive: true });
  const inScope = focus.filter((f) => f.inScope);
  fs.writeFileSync(path.join(SHOTS, `a11y-${sc.key}-${mode}.json`), JSON.stringify({
    tela: sc.key, largura: sc.width, tema: mode, escopo: sc.scope,
    alvos: { total: controls.length, menoresQue24px: small },
    foco: { passos: focus.length, noEscopo: inScope.length, visiveisNoEscopo: inScope.filter((f) => f.visible).length, semFoco: inScope.filter((f) => !f.visible), sequencia: focus },
    contraste: { amostras: rows.length, minimo: rows.length ? Math.min(...rows.map((r) => r.ratio)) : null, abaixoDoMinimo: failing },
    reflow: { excessoHorizontalPx: overflow },
  }, null, 2));
  fs.writeFileSync(path.join(SHOTS, `axe-${sc.key}-${mode}.json`), JSON.stringify({ tela: sc.key, tema: mode, escopo: sc.scope, axe: axe.testEngine, regrasAprovadas: axe.passes.length, violacoes: violations, incompletas: axe.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })) }, null, 2));

  expect.soft(small, "controles menores que 24x24").toEqual([]);
  expect.soft(inScope.filter((f) => !f.visible), "controles da tela sem foco visível").toEqual([]);
  expect.soft(failing, "textos abaixo do contraste mínimo (4.5:1; 3:1 para texto grande)").toEqual([]);
  expect.soft(overflow, "rolagem horizontal").toBeLessThanOrEqual(0);
  expect.soft(violations.filter((v) => v.impact === "serious" || v.impact === "critical"), "axe-core: violações serious/critical").toEqual([]);
  await shot(page, `a11y-${sc.key}-${mode}.png`);
});
