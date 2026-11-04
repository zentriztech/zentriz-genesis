import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeDetail, NO_ACTIONS } from "@/lib/cards/cardFixtures";
import { resetCardsCapabilitiesCache } from "@/lib/cards/useCardsEnabled";
import type { CardDetail } from "@/lib/cards/types";

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
import { apiGet, apiPost, apiPut, ApiError } from "@/lib/api";
import { CardDetailView } from "./CardDetailView";

const get = apiGet as unknown as ReturnType<typeof vi.fn>;
const post = apiPost as unknown as ReturnType<typeof vi.fn>;
const put = apiPut as unknown as ReturnType<typeof vi.fn>;

const BASE = { readOnly: true, headProjectId: "proj-head", headVersion: 3, title: "Meu Produto", specHash: "h", baseHeadProjectId: "proj-head", stale: false,
  files: [{ path: "spec.md", relDir: "", filename: "spec.md", isPrimary: true, sizeBytes: 10, contentSha256: "s", content: "# Spec inicial do produto", truncated: false }] };

function route(card: CardDetail, extra: Record<string, unknown> = {}) {
  get.mockImplementation(async (url: string) => {
    if (url in extra) { const v = extra[url]; if (v instanceof Error) throw v; return v; }
    if (url === `/api/cards/${card.id}`) return card;
    if (url === `/api/cards/${card.id}/base-spec`) return BASE;
    if (url === `/api/cards/${card.id}/journey`) throw new ApiError("nf", 404, "NOT_FOUND");
    if (url.endsWith("/spec-files")) return [{ id: "f1", filename: "spec.md", filePath: "/x/spec.md", relDir: "", isPrimary: false }, { id: "f2", filename: "request.md", filePath: "/x", relDir: "tickets/TK-0001", isPrimary: false }];
    if (url.includes("/spec-file?path=")) return { path: "spec.md", content: "# Spec do card", contentSha256: "sha1", isPrimary: false };
    if (url.includes("/cards/capabilities")) return { cardsBancada: true, budget: { freeUsd: 10, minFreeUsd: 5 } };
    throw new Error(`GET inesperado ${url}`);
  });
}
beforeEach(() => { vi.clearAllMocks(); resetCardsCapabilitiesCache(); });

const refining = () => makeDetail({ state: "refining", actions: { ...NO_ACTIONS, edit: true, ready: true, reject: true } });

describe("CardDetailView", () => {
  it("mostra cabeçalho, as 4 abas e o rito do tipo (Correção exige reprodução)", async () => {
    route(makeDetail({ kind: "fix" }));
    render(<CardDetailView cardId="c1" />);
    expect(await screen.findByRole("heading", { name: /TK-0001 · Exportar relatório em CSV/ })).toBeInTheDocument();
    for (const t of ["Pedido", "Especificação do card", "Versões", "Estado e linha do tempo"]) expect(screen.getByRole("tab", { name: t })).toBeInTheDocument();
    expect(screen.getByTestId("kind-rite")).toHaveTextContent(/cenário de reprodução \(FAIL_TO_PASS\).*patch/);
  });

  it("rito do Recurso novo cita Non-goals; da Evolução, o rito atual", async () => {
    route(makeDetail({ kind: "feature" }));
    const { unmount } = render(<CardDetailView cardId="c1" />);
    expect(await screen.findByTestId("kind-rite")).toHaveTextContent(/Non-goals/);
    unmount();
    route(makeDetail({ kind: "evolution" }));
    render(<CardDetailView cardId="c1" />);
    expect(await screen.findByTestId("kind-rite")).toHaveTextContent(/Rito atual/);
  });

  it("anexos: estado da conversão (guardado, convertido, texto)", async () => {
    route(makeDetail({ attachments: [
      { id: "a1", filename: "manual.pdf", mimeType: "application/pdf", sizeBytes: 2048, downloadUrl: "/api/cards/c1/attachments/a1", kind: "binary" },
      { id: "a2", filename: "manual.md", mimeType: "text/markdown", sizeBytes: 100, downloadUrl: "/api/cards/c1/attachments/a2", origin: "converted", derivedFromAttachmentId: "a1" },
      { id: "a3", filename: "notas.txt", mimeType: "text/plain", sizeBytes: 100, downloadUrl: "/api/cards/c1/attachments/a3" },
    ] }));
    render(<CardDetailView cardId="c1" />);
    expect(await screen.findByRole("link", { name: "manual.pdf" })).toHaveAttribute("href", "/api/cards/c1/attachments/a1");
    expect(screen.getByText(/Guardado no card · conversão para \.md concluída/)).toBeInTheDocument();
    expect(screen.getByText(/Convertido automaticamente de manual\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/Texto: entra na especificação do card/)).toBeInTheDocument();
  });

  it("aba da spec distingue 'Spec inicial' (somente leitura) de 'Spec deste card' (editável) e não altera nada ao abrir", async () => {
    route(refining());
    render(<CardDetailView cardId="c1" initialTab="spec" />);
    expect(await screen.findByText("Spec inicial · somente leitura")).toBeInTheDocument();
    expect(screen.getByText("Spec deste card")).toBeInTheDocument();
    expect(await screen.findByLabelText("Conteúdo somente leitura de spec.md")).toHaveTextContent("# Spec inicial do produto");
    const editor = await screen.findByLabelText("Editor da spec");
    await waitFor(() => expect(editor).toHaveValue("# Spec do card"));
    expect(editor).not.toHaveAttribute("readonly");
    // os arquivos do pedido (tickets/…) não entram na lista editável
    expect(screen.queryByText("tickets/TK-0001/request.md")).not.toBeInTheDocument();
    // abrir/editar a spec não dispara clone, versão nem promoção
    expect(post).not.toHaveBeenCalled();
    expect(get.mock.calls.map((c) => c[0] as string).some((u) => /evolve|promote|clone/.test(u))).toBe(false);
    expect(await screen.findByTestId("gaps-panel")).toHaveTextContent("GAPs de draft-1");
  });

  it("salva o arquivo com baseSha (If-Match) e mostra confirmação", async () => {
    route(refining());
    put.mockResolvedValue({ ok: true, contentSha256: "sha2" });
    const user = userEvent.setup();
    render(<CardDetailView cardId="c1" initialTab="spec" />);
    const editor = await screen.findByLabelText("Editor da spec");
    await waitFor(() => expect(editor).toHaveValue("# Spec do card"));
    await user.type(editor, " mais");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/projects/draft-1/spec-file?path=spec.md", { content: "# Spec do card mais", baseSha: "sha1" }));
    expect(await screen.findByText(/Salvo\. Valide o card/)).toBeInTheDocument();
  });

  it("card pronto: spec travada, editor somente leitura e 'Reabrir para edição' volta a refinando", async () => {
    const card = makeDetail({ state: "ready", actions: { ...NO_ACTIONS, promote: true, reject: true } });
    route(card);
    post.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<CardDetailView cardId="c1" initialTab="spec" />);
    const lock = await screen.findByTestId("spec-locked");
    expect(lock).toHaveTextContent("está travada");
    const editor = await screen.findByLabelText("Editor da spec");
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Salvar" })).not.toBeInTheDocument();
    await user.click(within(lock).getByRole("button", { name: "Reabrir para edição" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/cards/c1/refine", {}));
  });

  it("usa o campo specLocked do backend quando existir (mesmo fora de 'ready')", async () => {
    route(makeDetail({ state: "refining", specLocked: true, actions: { ...NO_ACTIONS, edit: true } }));
    render(<CardDetailView cardId="c1" initialTab="spec" />);
    expect(await screen.findByTestId("spec-locked")).toBeInTheDocument();
  });

  it("CARD_SPEC_LOCKED ao salvar vira a mensagem de reabrir", async () => {
    route(refining());
    put.mockRejectedValue(new ApiError("locked", 409, "CARD_SPEC_LOCKED"));
    const user = userEvent.setup();
    render(<CardDetailView cardId="c1" initialTab="spec" />);
    const editor = await screen.findByLabelText("Editor da spec");
    await waitFor(() => expect(editor).toHaveValue("# Spec do card"));
    await user.type(editor, "x");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText(/Use “Reabrir para edição”/)).toBeInTheDocument();
  });

  it("Validar: erro do rito por tipo traduzido (CARD_KIND_REQUIREMENT / MISMATCH)", async () => {
    route(refining());
    const user = userEvent.setup();
    render(<CardDetailView cardId="c1" />);
    post.mockRejectedValueOnce(new ApiError("x", 409, "CARD_KIND_REQUIREMENT", { details: { missing: "repro_scenario" } }));
    await user.click(await screen.findByRole("button", { name: "Validar" }));
    expect(await screen.findByText(/exige um cenário de reprodução/)).toBeInTheDocument();
    post.mockRejectedValueOnce(new ApiError("x", 409, "CARD_KIND_MISMATCH"));
    await user.click(screen.getByRole("button", { name: "Validar" }));
    await waitFor(() => expect(screen.getByText(/não pode alterar a compatibilidade além de patch/)).toBeInTheDocument());
  });

  it("aba Versões usa o painel de versões da Bancada sobre o rascunho", async () => {
    route(refining());
    render(<CardDetailView cardId="c1" initialTab="versions" />);
    expect(await screen.findByTestId("versions-panel")).toHaveTextContent("Versões de draft-1");
  });

  it("aba Estado: sem a rota journey (404) deriva a linha do tempo dos eventos", async () => {
    route(refining());
    render(<CardDetailView cardId="c1" initialTab="state" />);
    expect(await screen.findByText(/calculada a partir dos eventos/)).toBeInTheDocument();
    expect(screen.getByTestId("journey-refining")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("journey-draft")).toHaveTextContent("Concluída");
    expect(screen.getByText(/Próxima ação:/)).toHaveTextContent("Refinar a especificação e validar");
  });

  it("aba Estado: usa a resposta de GET /journey quando existe", async () => {
    route(refining(), { "/api/cards/c1/journey": { cardId: "c1", state: "refining", steps: [{ key: "x", label: "Etapa do servidor", state: "current" }], nextAction: { label: "Fazer X" } } });
    render(<CardDetailView cardId="c1" initialTab="state" />);
    expect(await screen.findByText(/Etapa do servidor — Etapa atual/)).toBeInTheDocument();
    expect(screen.getByText("Fazer X")).toBeInTheDocument();
  });

  it("bloqueado: mostra o motivo em texto e a ação Retomar", async () => {
    route(makeDetail({ state: "blocked", blockedReason: "materialization_failed:CODE", actions: { ...NO_ACTIONS, resume: true, reject: true } }));
    render(<CardDetailView cardId="c1" />);
    expect(await screen.findByText(/Card bloqueado: materialization_failed:CODE/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retomar" })).toBeInTheDocument();
  });

  it("erro ao carregar o card mostra mensagem e 'Tentar de novo'", async () => {
    get.mockRejectedValue(new ApiError("nf", 404, "NOT_FOUND"));
    render(<CardDetailView cardId="zzz" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Recurso indisponível ou não encontrado");
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });
});
