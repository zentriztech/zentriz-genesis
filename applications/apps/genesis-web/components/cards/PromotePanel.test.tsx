import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { makeDetail, NO_ACTIONS } from "@/lib/cards/cardFixtures";

vi.mock("@/lib/cards/cardsApi", () => ({ cardsApi: { promote: vi.fn(), revalidate: vi.fn() } }));
import { cardsApi } from "@/lib/cards/cardsApi";
import { PromotePanel } from "./PromotePanel";
const promote = cardsApi.promote as unknown as ReturnType<typeof vi.fn>;
const revalidate = cardsApi.revalidate as unknown as ReturnType<typeof vi.fn>;

const ready = () => makeDetail({ state: "ready", actions: { ...NO_ACTIONS, promote: true, reject: true, revalidate: true } });
function setup(over: Partial<Parameters<typeof PromotePanel>[0]> = {}) {
  const props = { card: ready(), caps: null, baseStale: null as boolean | null, onBaseStale: vi.fn(), onChanged: vi.fn(), ...over };
  render(<PromotePanel {...props} />);
  return props;
}
beforeEach(() => vi.clearAllMocks());

describe("PromotePanel", () => {
  it("lista os pré-requisitos (spec pronta, saldo, base atual) em texto", () => {
    setup({ caps: { cardsBancada: true, budget: { freeUsd: 9, minFreeUsd: 5 } }, baseStale: false });
    const list = screen.getByRole("list", { name: "Pré-requisitos da promoção" });
    expect(list).toHaveTextContent("Atendido: especificação do card validada e pronta.");
    expect(list).toHaveTextContent("Atendido: saldo livre do orçamento (US$ 9.00 livres, mínimo US$ 5.00)");
    expect(list).toHaveTextContent("Atendido: base atual");
  });

  it("antes de 'pronto' o botão não existe e orienta a validar", () => {
    setup({ card: makeDetail({ state: "refining", actions: { ...NO_ACTIONS, ready: true } }) });
    expect(screen.queryByRole("button", { name: /Promover/ })).not.toBeInTheDocument();
    expect(screen.getByText(/valide a especificação do card/)).toBeInTheDocument();
  });

  it("promove uma vez (clique duplo) e mostra a ligação com o filho", async () => {
    let resolve!: (v: unknown) => void;
    promote.mockReturnValue(new Promise((r) => { resolve = r; }));
    const props = setup();
    const btn = screen.getByRole("button", { name: "Promover à fábrica" });
    fireEvent.click(btn); fireEvent.click(btn);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Promovendo…" })).toBeDisabled();
    resolve({ childProjectId: "child-9", versionNumber: 2, cardId: "c1", cardState: "promoted" });
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  });

  it("depois da promoção mostra filho e PR, sem botão", () => {
    setup({ card: makeDetail({ state: "in_factory", childProjectId: "child-9", executionTitle: "Produto v2", prUrl: "https://github.com/x/y/pull/1" }) });
    expect(screen.getByRole("link", { name: "Produto v2" })).toHaveAttribute("href", "/projects/child-9");
    expect(screen.getByRole("link", { name: /abrir no GitHub/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Promover/ })).not.toBeInTheDocument();
  });

  it("base vencida: mostra aviso e 'Revalidar'; revalidar chama a API e limpa o aviso", async () => {
    promote.mockRejectedValue(new ApiError("x", 409, "CARD_BASE_STALE"));
    revalidate.mockResolvedValue({ ok: true });
    const props = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Promover à fábrica" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("base vencida");
    expect(props.onBaseStale).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Revalidar" }));
    await waitFor(() => expect(revalidate).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(props.onBaseStale).toHaveBeenCalledWith(false));
    expect(await screen.findByRole("status")).toHaveTextContent("valide o card de novo antes de promover");
  });

  it.each([
    [402, "BUDGET_FREE_BELOW_MIN", { freeUsd: 1, minFreeUsd: 5 }, /Saldo livre insuficiente/],
    [402, "BUDGET_MISSING", undefined, /não tem orçamento definido/],
    [409, "USE_CARD_PROMOTE", undefined, /Promova-o pela tela do card/],
    [409, "EVOLUTION_IN_FLIGHT", undefined, /evolução em andamento/],
    [409, "MATERIALIZATION_IN_PROGRESS", undefined, /já está em andamento/],
  ])("erro %s %s traduzido, sem sumir o botão", async (status, code, body, re) => {
    promote.mockRejectedValue(new ApiError("x", status as number, code as string, body as Record<string, unknown> | undefined));
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Promover à fábrica" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(re as RegExp);
    expect(screen.getByRole("button", { name: "Promover à fábrica" })).toBeEnabled();
  });

  it("depois de a base vencer o card volta a 'Refinando': o aviso e o 'Revalidar' continuam visíveis, sem botão de promover", () => {
    setup({ card: makeDetail({ state: "refining", actions: { ...NO_ACTIONS, ready: true, revalidate: true } }), baseStale: true });
    expect(screen.getByRole("button", { name: "Revalidar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Promover à fábrica" })).not.toBeInTheDocument();
  });

  it("CARD_NOT_READY recarrega o card (voltou a refinando)", async () => {
    promote.mockRejectedValue(new ApiError("x", 409, "CARD_NOT_READY"));
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: "Promover à fábrica" }));
    await screen.findByRole("alert");
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it("promoção repetida (replayed) avisa que nada foi duplicado", async () => {
    promote.mockResolvedValue({ childProjectId: "child-9", versionNumber: 2, cardId: "c1", cardState: "promoted", replayed: true });
    const { rerender } = render(<PromotePanel card={ready()} caps={null} baseStale={null} onBaseStale={vi.fn()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Promover à fábrica" }).at(-1)!);
    await waitFor(() => expect(promote).toHaveBeenCalled());
    rerender(<PromotePanel card={makeDetail({ state: "promoted", childProjectId: "child-9" })} caps={null} baseStale={null} onBaseStale={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByTestId("promote-done")).toHaveTextContent("Card promovido");
  });
});
