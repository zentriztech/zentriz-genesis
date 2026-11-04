import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiErrorFrom, detailOf, journeyOf, makeDetail, specApiErrorFrom } from "@/lib/cards/cardFixtures";
import { body, specBody } from "@/lib/cards/contractFixtures";
import { resetCardsCapabilitiesCache } from "@/lib/cards/useCardsEnabled";
import type { BaseSpec, CardAttachmentsResponse, CardDetail, CardJourney } from "@/lib/cards/types";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return { ...real, apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn() };
});
vi.mock("@/components/SpecCodeEditor", () => ({
  default: ({ value, onChange, readOnly }: { value: string; onChange?: (v: string) => void; readOnly?: boolean }) =>
    <textarea aria-label="Editor da spec" value={value} readOnly={readOnly} onChange={(e) => onChange?.(e.target.value)} />,
}));
vi.mock("@/components/SpecValidationPanel", () => ({ default: ({ projectId }: { projectId: string }) => <div data-testid="gaps-panel">GAPs de {projectId}</div> }));
vi.mock("@/components/SpecVersionsPanel", () => ({ default: ({ projectId }: { projectId: string }) => <div data-testid="versions-panel">Versões de {projectId}</div> }));
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { CardDetailView } from "./CardDetailView";

const get = apiGet as unknown as ReturnType<typeof vi.fn>;
const post = apiPost as unknown as ReturnType<typeof vi.fn>;
const put = apiPut as unknown as ReturnType<typeof vi.fn>;
const del = apiDelete as unknown as ReturnType<typeof vi.fn>;

const BASE = body<BaseSpec>("base-spec.200");
const RFC = "docs/rfc/RFC-0001-exportar-csv.md";
const REQ = "tickets/TK-0001/request.md";
const RFC_FILE = specBody<{ content: string; contentSha256: string }>("spec-file.get-200");
const ID = detailOf("draft").id;
const DRAFT = detailOf("draft").draftProjectId;

/** Roteia os GET como o backend real: detalhe, jornada, base-spec, anexos, arquivos da spec. `journey: Error` simula a rota fora do ar. */
function route(card: CardDetail, journey: CardJourney | Error | null, extra: Record<string, unknown> = {}) {
  get.mockImplementation(async (url: string) => {
    if (url in extra) { const v = extra[url]; if (v instanceof Error) throw v; return v; }
    if (url === `/api/cards/${card.id}`) return card;
    if (url === `/api/cards/${card.id}/journey`) { if (journey instanceof Error) throw journey; return journey; }
    if (url === `/api/cards/${card.id}/base-spec`) return BASE;
    if (url === `/api/cards/${card.id}/attachments`) return { items: [], strict: false, conversionEnabled: false, summary: {} };
    // Rotas de spec do rascunho: as RESPOSTAS REAIS gravadas pelo backend (`__contract__/spec/`). `onlyRequest` = rascunho novo (só o pedido).
    if (url.endsWith("/spec-tree")) return specBody(extra.__onlyRequest ? "spec-tree.draft" : "spec-tree.with-rfc");
    if (url.includes("/spec-file?path=")) {
      const p = decodeURIComponent(url.split("path=")[1]);
      return p === REQ ? specBody("spec-file.get-request") : { ...specBody<object>("spec-file.get-200"), path: p };
    }
    throw new Error(`GET inesperado ${url}`);
  });
}
const render_ = (props: Partial<Parameters<typeof CardDetailView>[0]> = {}) => render(<CardDetailView cardId={ID} {...props} />);
beforeEach(() => { vi.clearAllMocks(); resetCardsCapabilitiesCache(); });

describe("CardDetailView — cabeçalho, abas e rito", () => {
  it("mostra cabeçalho, as 4 abas e o rito do tipo (Correção exige reprodução)", async () => {
    route(makeDetail({ kind: "fix" }), journeyOf("draft-no-rfc"));
    render_();
    expect(await screen.findByRole("heading", { name: /TK-0001 · Exportar entregas em CSV/ })).toBeInTheDocument();
    for (const t of ["Pedido", "Especificação do card", "Versões", "Estado e linha do tempo"]) expect(screen.getByRole("tab", { name: t })).toBeInTheDocument();
    expect(screen.getByTestId("kind-rite")).toHaveTextContent(/cenário de reprodução \(FAIL_TO_PASS\).*patch/);
  });

  it("rito do Recurso novo cita Non-goals; da Evolução, o rito atual", async () => {
    route(makeDetail({ kind: "feature" }), journeyOf("draft-no-rfc"));
    const { unmount } = render_();
    expect(await screen.findByTestId("kind-rite")).toHaveTextContent(/Non-goals/);
    unmount();
    route(makeDetail({ kind: "evolution" }), journeyOf("draft-no-rfc"));
    render_();
    expect(await screen.findByTestId("kind-rite")).toHaveTextContent(/Rito atual/);
  });

  it("erro ao carregar o card mostra a mensagem do servidor e 'Tentar de novo'", async () => {
    get.mockRejectedValue(apiErrorFrom("get.404-not-found"));
    render_();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não encontramos este item");
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });
});

describe("CardDetailView — situação do card (jornada do servidor)", () => {
  it("rascunho sem RFC: headline, detail, o que impede a próxima etapa e a ação sugerida levam à aba da spec", async () => {
    route(makeDetail(), journeyOf("draft-no-rfc"));
    const user = userEvent.setup();
    render_();
    expect(await screen.findByTestId("journey-headline")).toHaveTextContent("Falta o RFC do card");
    expect(screen.getByTestId("journey-detail")).toHaveTextContent(/RFC/);
    const blockers = screen.getByTestId("journey-blockers");
    expect(blockers).toHaveTextContent("Falta o RFC do card, com critérios de aceite em Gherkin e os arquivos que podem mudar.");
    expect(screen.getByText(/O que impede a próxima etapa \(Refinando\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Gerar o RFC com a IA" }));
    expect(await screen.findByText("Spec inicial · somente leitura")).toBeInTheDocument();
  });

  it("rascunho com RFC ok: sem bloqueios e 'Validar o card' valida pela API", async () => {
    route(makeDetail({ actions: { ...detailOf("draft").actions, ready: true } }), journeyOf("draft-ready-to-validate"));
    post.mockResolvedValue(body("ready.200"));
    const user = userEvent.setup();
    render_();
    expect(await screen.findByTestId("journey-headline")).toHaveTextContent("Pronto para validar");
    expect(screen.queryByTestId("journey-blockers")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Validar o card" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/cards/${ID}/ready`, {}));
    expect(await screen.findByText("Especificação validada: o card está pronto para promover.")).toBeInTheDocument();
  });

  it("orçamento pausado no rascunho: aponta o projeto dono do orçamento (link), sem executar nada", async () => {
    route(makeDetail(), journeyOf("draft-budget-paused"));
    render_();
    expect(await screen.findByTestId("journey-headline")).toHaveTextContent("Orçamento de IA indisponível");
    expect(screen.getByTestId("journey-blockers")).toHaveTextContent("O orçamento de IA está pausado. Aumente o orçamento para continuar.");
    const link = screen.getByRole("link", { name: /Aumentar o orçamento/ });
    expect(link.getAttribute("href")).toMatch(/^\/projects\/[0-9a-f-]{36}$/);
  });

  it("em execução e entregue: link do projeto filho e do PR (execution.prUrl)", async () => {
    route(detailOf("delivered"), journeyOf("delivered"));
    render_();
    expect(await screen.findByTestId("journey-headline")).toHaveTextContent("Entregue");
    expect(screen.getByTestId("pr-link")).toHaveAttribute("href", "https://github.com/zentriz-demo/entregas/pull/42");
    for (const l of screen.getAllByRole("link", { name: /Evolução v2/ })) expect(l).toHaveAttribute("href", expect.stringMatching(/^\/projects\//));
    expect(screen.getByTestId("promote-done")).toHaveTextContent("Card entregue.");
  });

  it("na fábrica: bloqueio 'ainda não foi aceita' em texto e sem botão de promover", async () => {
    route(detailOf("in_factory"), journeyOf("in_factory"));
    render_();
    expect(await screen.findByTestId("journey-headline")).toHaveTextContent("Em execução na fábrica");
    expect(screen.getByTestId("journey-blockers")).toHaveTextContent("A execução do card ainda não foi aceita.");
    expect(screen.queryByRole("button", { name: /Promover/ })).not.toBeInTheDocument();
  });

  it("bloqueado por orçamento: motivo legível, 'Retomar o card' e o 402 do servidor se ainda não há saldo", async () => {
    route(detailOf("blocked"), journeyOf("blocked-budget"));
    post.mockRejectedValueOnce(apiErrorFrom("resume.402-budget-still-blocked"));
    const user = userEvent.setup();
    render_();
    expect(await screen.findByTestId("journey-headline")).toHaveTextContent("Bloqueado por orçamento");
    expect(screen.getByText(/Motivo do bloqueio:/)).toHaveTextContent("orçamento — O orçamento de IA está pausado");
    await user.click(screen.getByRole("button", { name: "Retomar o card" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/cards/${ID}/resume`, {}));
    expect(await screen.findByRole("alert")).toHaveTextContent("O card está bloqueado por orçamento. Aumente o orçamento da versão e retome o card.");
  });

  it("retomada com saldo: avisa que o filho segue parado e leva ao projeto (childRestartRequired)", async () => {
    route(detailOf("blocked"), journeyOf("blocked-budget"));
    post.mockResolvedValueOnce(body("resume.200-child-restart-required"));
    const user = userEvent.setup();
    render_();
    await user.click(await screen.findByRole("button", { name: "Retomar o card" }));
    const restart = await screen.findByTestId("restart-needed");
    expect(restart).toHaveTextContent("O orçamento voltou, mas a execução continua parada: reinicie-a para a fábrica seguir.");
    expect(within(restart).getByRole("link", { name: /Abrir o projeto/ })).toHaveAttribute("href", expect.stringMatching(/^\/projects\//));
  });

  it("falha na jornada: aviso com 'Tentar de novo', sem inventar a linha do tempo, e as ações do detalhe continuam", async () => {
    route(makeDetail({ actions: { ...detailOf("draft").actions, ready: true } }), apiErrorFrom("get.404-other-tenant"));
    render_();
    expect(await screen.findByText(/Não foi possível carregar a situação do card: Não encontramos este item/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validar" })).toBeInTheDocument();
    expect(screen.queryByTestId("journey-headline")).not.toBeInTheDocument();
  });
});

describe("CardDetailView — promover, base vencida e revalidação", () => {
  const readyCard = () => detailOf("ready");

  it("pronto: pré-requisitos vêm dos bloqueios do servidor e promover chama a API uma vez (clique duplo)", async () => {
    route(readyCard(), journeyOf("ready"));
    let resolve!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => { resolve = r; }));
    const user = userEvent.setup();
    render_();
    const list = await screen.findByRole("list", { name: "Pré-requisitos da promoção" });
    expect(list).toHaveTextContent("Atendido: especificação do card validada e pronta.");
    expect(list).toHaveTextContent("Atendido: saldo livre do orçamento da versão corrente, conforme o servidor.");
    expect(list).toHaveTextContent("Atendido: base atual");
    const btn = screen.getByRole("button", { name: "Promover à fábrica" });
    await user.dblClick(btn);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(`/api/cards/${ID}/promote`, {});
    expect(await screen.findByRole("button", { name: "Promovendo…" })).toBeDisabled();
    get.mockImplementation(async (url: string) => (url.endsWith("/journey") ? journeyOf("promoted") : url === `/api/cards/${ID}` ? detailOf("promoted") : null));
    resolve(body("promote.201"));
    expect(await screen.findByTestId("promote-done")).toHaveTextContent("Card promovido à fábrica.");
    expect(screen.getByTestId("promote-done")).toHaveTextContent("(v2)");
  });

  it("promoção repetida (replayed, 200): avisa que nada foi duplicado", async () => {
    route(readyCard(), journeyOf("ready"));
    const user = userEvent.setup();
    render_();
    const btn = await screen.findByRole("button", { name: "Promover à fábrica" });
    post.mockImplementation(async () => {
      get.mockImplementation(async (url: string) => (url.endsWith("/journey") ? journeyOf("promoted") : url === `/api/cards/${ID}` ? detailOf("promoted") : null));
      return body("promote.200-replayed");
    });
    await user.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(await screen.findByTestId("promote-done")).toHaveTextContent("A promoção já havia sido feita; nada foi duplicado.");
  });

  it("base vencida (jornada): aviso com as versões, promover desabilitado e 'Revalidar' mostra o resultado stale com os motivos", async () => {
    route(readyCard(), journeyOf("ready-base-stale"));
    post.mockResolvedValue(body("revalidate.stale"));
    const user = userEvent.setup();
    render_();
    const warn = await screen.findByTestId("base-stale");
    expect(warn).toHaveTextContent("o produto avançou para a v2 (o card foi escrito sobre a v1)");
    expect(screen.getByRole("button", { name: "Promover à fábrica" })).toBeDisabled();
    expect(screen.getByRole("list", { name: "Pré-requisitos da promoção" })).toHaveTextContent("Pendente: base atual");
    expect(within(warn).queryByRole("button")).not.toBeInTheDocument();      // a ação sugerida do servidor já é “revalidar”
    expect(screen.getByTestId("journey-action")).toHaveTextContent("Revalidar contra a versão corrente");
    await user.click(screen.getByRole("button", { name: "Revalidar contra a versão corrente" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/cards/${ID}/revalidate`, {}));
    const res = await screen.findByTestId("revalidate-stale");
    expect(res).toHaveTextContent("Base atualizada: valide o card de novo");
    expect(within(res).getByRole("list", { name: "Motivos da revalidação" })).toHaveTextContent("A versão corrente avançou (agora v2)");
  });

  it("revalidação com conflito: alerta com o motivo que exige ajustar o RFC", async () => {
    route(readyCard(), journeyOf("ready"));
    post.mockResolvedValue(body("revalidate.conflict"));
    const user = userEvent.setup();
    render_();
    await user.click(await screen.findByRole("button", { name: "Revalidar" }));
    const res = await screen.findByTestId("revalidate-conflict");
    expect(res).toHaveAttribute("role", "alert");
    expect(res).toHaveTextContent("Conflito: O card cita `docs/regras.md`, que foi REMOVIDO da spec da versão corrente.");
  });

  it("revalidação ok: confirma alinhamento", async () => {
    route(readyCard(), journeyOf("ready"));
    post.mockResolvedValue(body("revalidate.ok"));
    render_();
    await userEvent.click(await screen.findByRole("button", { name: "Revalidar" }));
    expect(await screen.findByTestId("revalidate-ok")).toHaveTextContent("O card está alinhado com a versão corrente.");
  });

  it.each([
    ["promote.409-base-stale", /A versão-base mudou desde a validação/, true],
    ["promote.409-not-ready", /O card não está pronto/, false],
    ["promote.402-budget-paused", /O orçamento de IA está pausado/, false],
    ["promote.409-materialization-in-progress", /A promoção deste card já está em andamento\. Aguarde alguns instantes\. Tente de novo em 2 s\./, false],
  ])("erro real %s: mensagem do servidor, sem sumir o botão%s", async (name, re, hasRevalidate) => {
    // sem a jornada (rota fora do ar) o botão fica ativo: o servidor decide e a tela mostra a resposta
    route(readyCard(), new Error("fora do ar"));
    post.mockRejectedValue(apiErrorFrom(name));
    render_();
    await userEvent.click(await screen.findByRole("button", { name: "Promover à fábrica" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(re);
    if (hasRevalidate) expect(screen.getByRole("button", { name: "Revalidar agora" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Promover à fábrica" })).toBeEnabled();
    expect(get.mock.calls.filter((c) => c[0] === `/api/cards/${ID}`).length).toBeGreaterThanOrEqual(2);   // recarregou o card depois do erro
  });

  it("USE_CARD_PROMOTE (corpo do /evolve, sem userMessage) cai na tabela local", async () => {
    route(makeDetail({ actions: { ...detailOf("draft").actions, ready: true } }), journeyOf("draft-ready-to-validate"));
    post.mockRejectedValue(apiErrorFrom("legacy-evolve.409-use-card-promote"));
    render_();
    await userEvent.click(await screen.findByRole("button", { name: "Validar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este pedido é um card: promova-o pelo próprio card.");
  });

  it("antes de 'pronto' não há botão de promover e a tela orienta a validar", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    render_();
    expect(await screen.findByText(/valide a especificação do card/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Promover/ })).not.toBeInTheDocument();
  });
});

describe("CardDetailView — ações, tipo e erros do gate", () => {
  it("Validar: erros do gate REAIS (tipo exigido, incompatibilidade, RFC inválido) com os detalhes do servidor", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    const user = userEvent.setup();
    render_();
    post.mockRejectedValueOnce(apiErrorFrom("ready.409-kind-requirement-fix"));
    await user.click(await screen.findByRole("button", { name: "Validar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Falta algo exigido pelo tipo do card.*Falta: cenário de reprodução \(FAIL_TO_PASS\)\./);
    post.mockRejectedValueOnce(apiErrorFrom("ready.409-kind-mismatch"));
    await user.click(screen.getByRole("button", { name: "Validar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Uma correção não pode mudar a compatibilidade da versão além de patch."));
    post.mockRejectedValueOnce(apiErrorFrom("ready.409-rfc-invalid"));
    await user.click(screen.getByRole("button", { name: "Validar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/O RFC do card está incompleto.*escopo irrestrito em files_allowed/));
    post.mockRejectedValueOnce(apiErrorFrom("ready.402-budget-free-below-min"));
    await user.click(screen.getByRole("button", { name: "Validar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/O saldo livre está abaixo do mínimo.*Saldo livre: US\$ 3\.00; mínimo exigido: US\$ 5\.00\./));
  });

  it("Reabrir para edição (barra de ações) chama POST /reopen — não /refine", async () => {
    route(detailOf("ready"), journeyOf("ready"));
    post.mockResolvedValue(body("reopen.200"));
    render_();
    await userEvent.click(await screen.findByRole("button", { name: "Reabrir para edição" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/cards/${ID}/reopen`, {}));
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/refine"), expect.anything());
    expect(await screen.findByText("Card reaberto: a spec voltou a aceitar edição. Valide de novo antes de promover.")).toBeInTheDocument();
  });

  it("rejeitar pede confirmação; excluir remove e volta ao quadro", async () => {
    route(detailOf("draft"), journeyOf("draft-no-rfc"));
    del.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render_();
    await user.click(await screen.findByRole("button", { name: "Excluir" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(`/api/cards/${ID}`));
    expect(push).toHaveBeenCalledWith(`/products/${detailOf("draft").productId}/cards`);
  });

  it("anexos: usa o estado da conversão do servidor (GET /attachments)", async () => {
    const card = detailOf("draft");
    const withAtt = makeDetail({ attachments: body<CardDetail>("detail.with-attachments").attachments, attachmentsCount: 2 });
    const list = body<CardAttachmentsResponse>("attachments.list-conversion-failed");
    // ids da lista e do detalhe vêm de fixtures diferentes: alinha por nome de arquivo
    list.items.forEach((i) => { const m = withAtt.attachments.find((a) => a.filename === i.filename); if (m) i.id = m.id; });
    route(withAtt, journeyOf("draft-no-rfc"), { [`/api/cards/${card.id}/attachments`]: list });
    render_();
    expect(await screen.findByRole("link", { name: "contrato.pdf" })).toHaveAttribute("href", expect.stringContaining("/attachments/"));
    expect(await screen.findByText(/a conversão para \.md falhou: sem camada de texto \(3 tentativa\(s\)\); o original segue guardado/)).toBeInTheDocument();
    expect(screen.getByText(/Texto: entra na especificação do card/)).toBeInTheDocument();
  });
});

describe("CardDetailView — aba da especificação", () => {
  it("distingue 'Spec inicial' (somente leitura) de 'Spec deste card' (editável), abre o RFC do card e não altera nada ao abrir", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    render_({ initialTab: "spec" });
    expect(await screen.findByText("Spec inicial · somente leitura")).toBeInTheDocument();
    expect(screen.getByText("Spec deste card")).toBeInTheDocument();
    expect(await screen.findByLabelText("Conteúdo somente leitura de spec.md")).toHaveTextContent("O app lista entregas. Prazo de 48h.");
    const editor = await screen.findByLabelText("Editor da spec");
    await waitFor(() => expect(editor).toHaveValue(RFC_FILE.content));
    expect(editor).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Arquivo do card")).toHaveTextContent(RFC);
    expect(screen.getByTestId("writable-scope")).toHaveTextContent("tickets/TK-0001/**, docs/rfc/**, docs/adr/**");
    expect(post).not.toHaveBeenCalled();
    expect(get.mock.calls.map((c) => c[0] as string).some((u) => /evolve|promote|clone|spec-files/.test(u))).toBe(false);
    expect(await screen.findByTestId("gaps-panel")).toHaveTextContent(`GAPs de ${DRAFT}`);
  });

  it("Y-03: rascunho NOVO (só tickets/TK-0001/request.md) mostra o pedido, não 'sem arquivos'; o pedido é imutável e o Chat explica o que fazer", async () => {
    route(detailOf("draft"), journeyOf("draft-no-rfc"), { __onlyRequest: true });
    render_({ initialTab: "spec" });
    expect(await screen.findByLabelText("Arquivo do card")).toHaveTextContent(REQ);
    expect(screen.queryByText(/ainda não tem arquivos/)).not.toBeInTheDocument();
    const editor = await screen.findByLabelText("Editor da spec");
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("Quero baixar a lista de entregas em CSV."));
    expect(editor).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    expect(screen.getByText(/O card ainda não tem RFC/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar RFC com a IA" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Novo RFC a partir do modelo" })).toBeEnabled();
    expect(screen.getByLabelText("Mensagem para o assistente")).toBeDisabled();
    expect(screen.getByText(/O pedido original é imutável\. Selecione ou crie um RFC/)).toBeInTheDocument();
  });

  it("salva o RFC com baseSha (If-Match) pelo caminho em docs/rfc e mostra confirmação", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    put.mockResolvedValue(specBody("spec-file.put-200"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    const editor = await screen.findByLabelText("Editor da spec");
    await waitFor(() => expect(editor).toHaveValue(RFC_FILE.content));
    await user.type(editor, " mais");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(`/api/projects/${DRAFT}/spec-file?path=${encodeURIComponent(RFC)}`, { content: `${RFC_FILE.content} mais`, baseSha: RFC_FILE.contentSha256 }));
    expect(await screen.findByText(/Salvo\. Valide o card/)).toBeInTheDocument();
  });

  it("conflito de edição (CONFLICT real do servidor): mostra a mensagem e oferece 'Recarregar'", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    put.mockRejectedValue(specApiErrorFrom("spec-file.put-409-conflict"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    const editor = await screen.findByLabelText("Editor da spec");
    await waitFor(() => expect(editor).toHaveValue(RFC_FILE.content));
    await user.type(editor, "x");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText(/O arquivo mudou desde a sua leitura/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Recarregar" }));
    await waitFor(() => expect(editor).toHaveValue(RFC_FILE.content));
  });

  it("card pronto (spec.locked + canReopen do servidor): editor somente leitura, sem geradores, e 'Reabrir para edição' usa /reopen", async () => {
    route(detailOf("ready"), journeyOf("ready"));
    post.mockResolvedValue(body("reopen.200"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    const lock = await screen.findByTestId("spec-locked");
    expect(lock).toHaveTextContent("está travada");
    expect(await screen.findByLabelText("Editor da spec")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Salvar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gerar RFC com a IA" })).not.toBeInTheDocument();
    await user.click(within(lock).getByRole("button", { name: "Reabrir para edição" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/cards/${ID}/reopen`, {}));
  });

  it("promovido (spec.locked sem canReopen): travada, SEM botão de reabrir", async () => {
    route(detailOf("promoted"), journeyOf("promoted"));
    render_({ initialTab: "spec" });
    const lock = await screen.findByTestId("spec-locked");
    expect(lock).toHaveTextContent("nem reaberta");
    expect(within(lock).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reabrir para edição" })).not.toBeInTheDocument();
  });

  it("a trava vem de journey.spec.locked do servidor, mesmo que o estado do detalhe pareça editável", async () => {
    route(detailOf("refining"), { ...journeyOf("refining"), spec: { locked: true, canReopen: false } });
    render_({ initialTab: "spec" });
    expect(await screen.findByTestId("spec-locked")).toBeInTheDocument();
    expect(await screen.findByLabelText("Editor da spec")).toHaveAttribute("readonly");
  });

  it("CARD_SPEC_LOCKED ao salvar (corpo real do escritor de spec) mostra a mensagem do servidor", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    put.mockRejectedValue(apiErrorFrom("spec-write.409-card-spec-locked"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    const editor = await screen.findByLabelText("Editor da spec");
    await waitFor(() => expect(editor).toHaveValue(RFC_FILE.content));
    await user.type(editor, "x");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("A spec do card está travada. Reabra o card para voltar a editar.")).toBeInTheDocument();
  });

  it("Y-03(b): o campo 'Novo arquivo' sugere um caminho VÁLIDO (docs/rfc/RFC-NNNN-…) e recusa no cliente o que o backend recusa (spec.md, rfc/RFC-001.md)", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    const field = await screen.findByLabelText(/Novo arquivo/);
    await waitFor(() => expect(field).toHaveValue("docs/rfc/RFC-0002-exportar-entregas-em-csv.md"));
    expect(screen.getByRole("button", { name: "Criar arquivo" })).toBeEnabled();
    for (const ruim of ["spec.md", "rfc/RFC-001.md", "docs/rfc/../../x.md", "docs/regras.md"]) {
      await user.clear(field); await user.type(field, ruim);
      expect(screen.getByRole("button", { name: "Criar arquivo" }), ruim).toBeDisabled();
      expect(screen.getByText(/O card só escreve em tickets\/TK-0001\/\*\*, docs\/rfc\/\*\*, docs\/adr\/\*\*\./), ruim).toBeInTheDocument();
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("cria o arquivo em docs/rfc (corpo da fixture real), recarrega a árvore e abre o novo arquivo", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    post.mockResolvedValue(specBody("spec-file.post-201"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    const field = await screen.findByLabelText(/Novo arquivo/);
    await waitFor(() => expect(field).toHaveValue("docs/rfc/RFC-0002-exportar-entregas-em-csv.md"));
    await user.click(screen.getByRole("button", { name: "Criar arquivo" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/projects/${DRAFT}/spec-file`, expect.objectContaining({ path: "docs/rfc/RFC-0002-exportar-entregas-em-csv.md" })));
    await waitFor(() => expect(get.mock.calls.filter((c) => String(c[0]).endsWith("/spec-tree")).length).toBeGreaterThanOrEqual(2));
  });

  it("CARD_PATH_OUT_OF_SCOPE vindo do servidor (caminho que passou na checagem do cliente): mensagem + pastas permitidas", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    post.mockRejectedValue(apiErrorFrom("spec-write.400-path-out-of-scope"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    const field = await screen.findByLabelText(/Novo arquivo/);
    await user.clear(field); await user.type(field, "docs/adr/ADR-001-x.md");
    await user.click(screen.getByRole("button", { name: "Criar arquivo" }));
    expect(await screen.findByText(/O card só escreve na própria pasta e no RFC\/ADR dele.*Pastas permitidas: tickets\/TK-0003\/\*\*, docs\/rfc\/\*\*, docs\/adr\/\*\*\./)).toBeInTheDocument();
  });

  it("Y-03(c): 'Gerar RFC com a IA' chama o planner (evolution-plan), mostra o progresso e o resultado, abre o RFC gerado e recarrega o card", async () => {
    route(detailOf("draft"), journeyOf("draft-no-rfc"), { __onlyRequest: true });
    post.mockResolvedValue(specBody("evolution-plan.post-202"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    await user.type(await screen.findByLabelText(/Instruções para o arquiteto/), "Exportar em CSV com ponto e vírgula");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = get.getMockImplementation()!;
    get.mockImplementation(async (url: string) => {
      if (url.includes("/evolution-plan/")) { await gate; return specBody("evolution-plan.get-done"); }
      return base(url);
    });
    await user.click(screen.getByRole("button", { name: "Gerar RFC com a IA" }));
    expect(await screen.findByRole("button", { name: "Gerando o RFC…" })).toBeDisabled();
    expect(screen.getByText(/O arquiteto está escrevendo o RFC/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(`/api/projects/${DRAFT}/evolution-plan`, { request: "Exportar em CSV com ponto e vírgula" });
    release();
    const done = await screen.findByTestId("plan-done");
    expect(done).toHaveTextContent("Exportar entregas em CSV");
    expect(done).toHaveTextContent("docs/rfc/RFC-0002-exportar-csv.md");
    expect(within(done).getByLabelText("Perguntas do arquiteto")).toHaveTextContent("O CSV deve incluir entregas canceladas?");
    expect(within(done).getByLabelText("Avisos do arquiteto")).toBeInTheDocument();
    expect(get.mock.calls.filter((c) => String(c[0]).endsWith("/spec-tree")).length).toBeGreaterThanOrEqual(2);   // recarregou a árvore
    expect(get.mock.calls.filter((c) => c[0] === `/api/cards/${ID}`).length).toBeGreaterThanOrEqual(2);              // e o card (o RFC move o rascunho para 'Refinando')
  });

  it("planner: 402 de orçamento (corpo real) e job em erro (fixture real) viram mensagens claras, sem travar a tela", async () => {
    route(detailOf("draft"), journeyOf("draft-no-rfc"), { __onlyRequest: true });
    post.mockRejectedValueOnce(apiErrorFrom("promote.402-budget-paused"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    await user.click(await screen.findByRole("button", { name: "Gerar RFC com a IA" }));
    expect(await screen.findByTestId("plan-error")).toHaveTextContent("O orçamento de IA está pausado");
    post.mockResolvedValueOnce(specBody("evolution-plan.post-202"));
    const base = get.getMockImplementation()!;
    get.mockImplementation(async (url: string) => (url.includes("/evolution-plan/") ? specBody("evolution-plan.get-error") : base(url)));
    await user.click(screen.getByRole("button", { name: "Gerar RFC com a IA" }));
    await waitFor(() => expect(screen.getByTestId("plan-error")).toHaveTextContent("EMPTY_RESPONSE"));
    expect(screen.getByRole("button", { name: "Gerar RFC com a IA" })).toBeEnabled();
  });

  it("a ação sugerida 'Gerar o RFC com a IA' da situação do card abre a aba e dispara o planner", async () => {
    route(makeDetail(), journeyOf("draft-no-rfc"));
    post.mockResolvedValue(specBody("evolution-plan.post-202"));
    get.mockImplementation(((impl) => async (url: string) => (url.includes("/evolution-plan/") ? specBody("evolution-plan.get-done") : impl(url)))(get.getMockImplementation()!));
    const user = userEvent.setup();
    render_();
    await user.click(await screen.findByRole("button", { name: "Gerar o RFC com a IA" }));
    expect(await screen.findByText("Spec inicial · somente leitura")).toBeInTheDocument();
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/projects/${DRAFT}/evolution-plan`, {}));
    expect(await screen.findByTestId("plan-done")).toBeInTheDocument();
  });

  it("'Novo RFC a partir do modelo' cria docs/rfc/RFC-NNNN pelo servidor e abre o arquivo", async () => {
    route(detailOf("draft"), journeyOf("draft-no-rfc"), { __onlyRequest: true });
    post.mockResolvedValue(specBody("rfc-from-template.201"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    await user.click(await screen.findByRole("button", { name: "Novo RFC a partir do modelo" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/projects/${DRAFT}/rfc-from-template`, { title: "Exportar entregas em CSV" }));
    await waitFor(() => expect(get.mock.calls.filter((c) => String(c[0]).endsWith("/spec-tree")).length).toBeGreaterThanOrEqual(2));
  });

  it("Y-03: o Chat funciona sobre o arquivo selecionado (RFC), com as respostas reais do spec-chat, e só aplica no editor quando o usuário manda", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    post.mockResolvedValue(specBody("spec-chat.post-202"));
    const base = get.getMockImplementation()!;
    get.mockImplementation(async (url: string) => (/^\/api\/spec-chat\//.test(url) ? specBody("spec-chat.get-done") : base(url)));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    const editor = await screen.findByLabelText("Editor da spec");
    await waitFor(() => expect(editor).toHaveValue(RFC_FILE.content));
    await user.click(screen.getByText("Chat IA sobre o arquivo do card"));
    await user.type(screen.getByLabelText("Mensagem para o assistente"), "Acrescente o separador do CSV.");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/spec-chat", expect.objectContaining({ projectId: DRAFT, filePath: RFC, baseSha: RFC_FILE.contentSha256 })));
    await user.click(await screen.findByRole("button", { name: "Aplicar no editor" }));
    expect((editor as HTMLTextAreaElement).value).toContain("ponto e vírgula como separador");
    expect(put).not.toHaveBeenCalled();   // nada é salvo sem o usuário salvar
  });

  it("Chat com o card pronto: a trava do servidor (CARD_SPEC_LOCKED real do spec-chat) aparece como mensagem", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    post.mockRejectedValue(specApiErrorFrom("spec-chat.post-409-locked"));
    const user = userEvent.setup();
    render_({ initialTab: "spec" });
    await waitFor(() => expect(screen.getByLabelText("Editor da spec")).toHaveValue(RFC_FILE.content));
    await user.click(screen.getByText("Chat IA sobre o arquivo do card"));
    await user.type(screen.getByLabelText("Mensagem para o assistente"), "oi");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("A spec do card está travada. Reabra o card para voltar a editar.")).toBeInTheDocument();
  });

  it("base-spec truncada (content null) não quebra a tela", async () => {
    const trunc = { ...BASE, files: [{ ...BASE.files[0], content: null, truncated: true }] };
    route(detailOf("refining"), journeyOf("refining"), { [`/api/cards/${ID}/base-spec`]: trunc });
    render_({ initialTab: "spec" });
    expect(await screen.findByLabelText("Conteúdo somente leitura de spec.md")).toHaveTextContent("acima do teto de leitura");
  });

  it("aba Versões usa o painel de versões da Bancada sobre o rascunho", async () => {
    route(detailOf("refining"), journeyOf("refining"));
    render_({ initialTab: "versions" });
    expect(await screen.findByTestId("versions-panel")).toHaveTextContent(`Versões de ${DRAFT}`);
  });
});

describe("CardDetailView — Y-20 (recarga, carregamento e histórico legível) e Y-18", () => {
  it("falha na RECARGA com o card já na tela: aviso não bloqueante, o card continua visível e 'Atualizar' tenta de novo", async () => {
    route(detailOf("draft"), journeyOf("draft-ready-to-validate"));
    post.mockResolvedValue(body("ready.200"));
    const base = get.getMockImplementation()!;
    let falhar = false;
    get.mockImplementation(async (url: string) => { if (falhar && url === `/api/cards/${ID}`) throw new Error("Failed to fetch"); return base(url); });
    const user = userEvent.setup();
    render_();
    await user.click(await screen.findByRole("button", { name: "Validar o card" }));
    falhar = true;
    await user.click(screen.getByRole("button", { name: "Validar o card" }));
    const warn = await screen.findByTestId("reload-warning");
    expect(warn).toHaveTextContent("Não foi possível atualizar o card: Failed to fetch");
    expect(warn).toHaveTextContent("podem estar desatualizados");
    expect(screen.getByRole("heading", { name: /TK-0001 · Exportar entregas em CSV/ })).toBeInTheDocument();
    falhar = false;
    await user.click(within(warn).getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(screen.queryByTestId("reload-warning")).not.toBeInTheDocument());
  });

  it("enquanto a jornada carrega: 'Promover' desabilitado e spinner na aba Estado; quando chega, habilita", async () => {
    route(detailOf("ready"), journeyOf("ready"));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = get.getMockImplementation()!;
    get.mockImplementation(async (url: string) => { if (url === `/api/cards/${ID}/journey`) { await gate; } return base(url); });
    render_();
    const btn = await screen.findByRole("button", { name: "Promover à fábrica" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Conferindo a situação do card/)).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Promover à fábrica" })).toBeEnabled());
  });

  it("aba Estado: spinner enquanto a jornada carrega e motivos do histórico em português (sem 'spec_write'/'budget:…' crus)", async () => {
    const d = detailOf("ready");
    const comMotivos = { ...d, events: [
      { ...d.events[0], reason: "spec_write" }, { ...d.events[0], reason: "budget:BUDGET_PAUSED" }, { ...d.events[0], reason: "validated" }, { ...d.events[0], reason: "motivo_novo_do_backend" },
    ] };
    route(comMotivos, journeyOf("ready"));
    render_({ initialTab: "state" });
    expect(await screen.findByTestId("journey-ready")).toBeInTheDocument();
    const lista = screen.getByText("Histórico").parentElement!;
    expect(lista).toHaveTextContent("(especificação alterada)");
    expect(lista).toHaveTextContent("(orçamento — O orçamento de IA está pausado");
    expect(lista).toHaveTextContent("(especificação validada)");
    expect(lista).toHaveTextContent("(motivo_novo_do_backend)");   // desconhecido volta como veio
    expect(lista).not.toHaveTextContent("(spec_write)");
    expect(lista).not.toHaveTextContent("(budget:");
  });

  it("Y-18: PR com javascript: na situação do card não vira link", async () => {
    const j = journeyOf("delivered");
    route({ ...detailOf("delivered"), prUrl: "javascript:alert(1)" }, { ...j, execution: j.execution ? { ...j.execution, prUrl: "javascript:alert(1)" } : null });
    render_();
    await screen.findByTestId("journey-headline");
    expect(screen.queryByTestId("pr-link")).not.toBeInTheDocument();
  });
});

describe("CardDetailView — aba Estado", () => {
  it("mostra as etapas do servidor, a próxima etapa, a ação sugerida e o histórico (mais recente primeiro)", async () => {
    route(detailOf("ready"), journeyOf("ready"));
    render_({ initialTab: "state" });
    expect(await screen.findByTestId("journey-ready")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("journey-draft")).toHaveTextContent("Rascunho — Concluída");
    expect(screen.getByTestId("journey-delivered")).toHaveTextContent("Entregue — A fazer");
    expect(screen.getByTestId("journey-next")).toHaveTextContent("Próxima etapa: Promovido");
    expect(screen.getByText(/Ação sugerida:/)).toHaveTextContent("Promover à fábrica");
    const items = screen.getAllByRole("listitem").filter((li) => /→/.test(li.textContent ?? ""));
    expect(items[0]).toHaveTextContent("Refinando → Pronto");
  });

  it("card bloqueado mostra o motivo legível; rejeitado, o aviso de fora da trilha", async () => {
    route(detailOf("blocked"), journeyOf("blocked-budget"));
    const { unmount } = render_({ initialTab: "state" });
    expect(await screen.findByText(/Motivo do bloqueio: orçamento — O orçamento de IA está pausado/, { selector: ".MuiAlert-message" })).toBeInTheDocument();
    expect(screen.getByTestId("journey-in_factory")).toHaveTextContent("Na fábrica — Bloqueada");
    unmount();
    route(detailOf("rejected"), journeyOf("rejected"));
    render_({ initialTab: "state" });
    expect(await screen.findByText(/Card recusado: ele saiu da trilha/)).toBeInTheDocument();
  });
});
