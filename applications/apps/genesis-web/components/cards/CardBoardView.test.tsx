import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { makeCard } from "@/lib/cards/cardFixtures";
import { resetCardsCapabilitiesCache } from "@/lib/cards/useCardsEnabled";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/cards/cardsApi", () => ({ cardsApi: { capabilities: vi.fn(), list: vi.fn(), create: vi.fn() } }));
import { cardsApi } from "@/lib/cards/cardsApi";
import { CardBoardView } from "./CardBoardView";

const api = cardsApi as unknown as { capabilities: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };

const CARDS = [
  makeCard({ id: "a", code: "TK-0001", title: "Rascunho A", state: "draft" }),
  makeCard({ id: "b", code: "TK-0002", title: "Correção B", kind: "fix", state: "refining" }),
  makeCard({ id: "c", code: "TK-0003", title: "Recurso C", kind: "feature", state: "blocked", blockedReason: "materialization_failed:CODE" }),
  makeCard({ id: "d", code: "TK-0004", title: "Na fábrica D", state: "in_factory", childProjectId: "child-1", executionTitle: "Produto v2", executionStatus: "running", prUrl: "https://github.com/x/y/pull/3" }),
];

beforeEach(() => { vi.clearAllMocks(); resetCardsCapabilitiesCache(); api.capabilities.mockResolvedValue({ cardsBancada: true }); });

describe("CardBoardView", () => {
  it("mostra uma coluna por estado com contagem e cartões com código, tipo, ligação e próxima ação", async () => {
    api.list.mockResolvedValue({ items: CARDS, total: 4, limit: 100, offset: 0 });
    render(<CardBoardView productId="p1" />);
    expect(await screen.findByRole("heading", { name: "Rascunho (1)" })).toBeInTheDocument();
    for (const h of ["Refinando (1)", "Pronto (0)", "Promovido (0)", "Na fábrica (1)", "Entregue (0)", "Bloqueado (1)", "Rejeitado (0)"]) {
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    }
    const tile = screen.getByTestId("card-tile-TK-0004");
    expect(within(tile).getByText("Evolução")).toBeInTheDocument();
    expect(within(tile).getByRole("link", { name: /Produto v2/ })).toHaveAttribute("href", "/projects/child-1");
    expect(within(tile).getByRole("link", { name: /abrir no GitHub/ })).toHaveAttribute("href", "https://github.com/x/y/pull/3");
    expect(within(tile).getByText(/Acompanhar o projeto filho/)).toBeInTheDocument();
    expect(within(screen.getByTestId("card-tile-TK-0001")).getByRole("link", { name: /rascunho TK-0001/ })).toHaveAttribute("href", "/cards/a?tab=spec");
  });

  it("bloqueio aparece em texto (não só cor) com o motivo", async () => {
    api.list.mockResolvedValue({ items: CARDS, total: 4, limit: 100, offset: 0 });
    render(<CardBoardView productId="p1" />);
    const tile = await screen.findByTestId("card-tile-TK-0003");
    expect(within(tile).getByRole("status")).toHaveTextContent("Bloqueado: materialization_failed:CODE");
  });

  it("filtra por tipo e oculta/mostra colunas por estado (aria-pressed)", async () => {
    api.list.mockResolvedValue({ items: CARDS, total: 4, limit: 100, offset: 0 });
    const user = userEvent.setup();
    render(<CardBoardView productId="p1" />);
    await screen.findByTestId("card-tile-TK-0001");
    await user.selectOptions(screen.getByLabelText("Filtrar por tipo"), "fix");
    expect(screen.queryByTestId("card-tile-TK-0001")).not.toBeInTheDocument();
    expect(screen.getByTestId("card-tile-TK-0002")).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: /Bloqueado/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("heading", { name: /Bloqueado \(/ })).not.toBeInTheDocument();
  });

  it("estado vazio oferece criar o primeiro card", async () => {
    api.list.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    render(<CardBoardView productId="p1" />);
    expect(await screen.findByText(/ainda não tem cards/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar o primeiro card" })).toBeInTheDocument();
  });

  it("erro de listagem mostra a mensagem traduzida e permite tentar de novo", async () => {
    api.list.mockRejectedValueOnce(new ApiError("x", 409, "PRODUCT_ARCHIVED")).mockResolvedValueOnce({ items: CARDS, total: 4, limit: 100, offset: 0 });
    const user = userEvent.setup();
    render(<CardBoardView productId="p1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("O produto está arquivado");
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByTestId("card-tile-TK-0001")).toBeInTheDocument();
  });

  it("flag desligada: aviso, sem chamar a listagem", async () => {
    api.capabilities.mockResolvedValue({ cardsBancada: false });
    render(<CardBoardView productId="p1" />);
    expect(await screen.findByText(/não estão habilitados para este tenant/)).toBeInTheDocument();
    await waitFor(() => expect(api.list).not.toHaveBeenCalled());
  });

  it("avisa quando há mais cards do que a página carregada", async () => {
    api.list.mockResolvedValue({ items: CARDS, total: 250, limit: 100, offset: 0 });
    render(<CardBoardView productId="p1" />);
    expect(await screen.findByText(/Mostrando 4 de 250 cards/)).toBeInTheDocument();
  });
});
