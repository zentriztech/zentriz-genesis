import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
vi.mock("@/lib/cards/cardsApi", () => ({ cardsApi: { capabilities: vi.fn() } }));
import { cardsApi } from "@/lib/cards/cardsApi";
import { resetCardsCapabilitiesCache } from "@/lib/cards/useCardsEnabled";
import { EvolveButton } from "./EvolveButton";
const cap = cardsApi.capabilities as unknown as ReturnType<typeof vi.fn>;
const onCards = vi.fn(); const onLegacy = vi.fn();
beforeEach(() => { vi.clearAllMocks(); resetCardsCapabilitiesCache(); });
const mount = () => render(<EvolveButton productId="p1" openTickets={2} onCards={onCards} onLegacy={onLegacy} />);

describe("EvolveButton (Y-10): nunca cai no diálogo legado sem saber se a flag está ligada", () => {
  it("enquanto a flag carrega o botão fica desabilitado ('Verificando…') e o clique não abre o legado", async () => {
    cap.mockReturnValue(new Promise(() => {}));
    mount();
    const btn = screen.getByRole("button", { name: /Verificando/ });
    expect(btn).toBeDisabled();
    await userEvent.setup({ pointerEventsCheck: 0 }).click(btn);
    expect(onLegacy).not.toHaveBeenCalled(); expect(onCards).not.toHaveBeenCalled();
  });
  it("flag ligada leva ao quadro de cards; desligada abre o diálogo legado", async () => {
    cap.mockResolvedValueOnce({ cardsBancada: true });
    const user = userEvent.setup();
    const { unmount } = mount();
    await user.click(await screen.findByRole("button", { name: /Evoluir \(2 pedidos\)/ }));
    expect(onCards).toHaveBeenCalledWith("p1"); expect(onLegacy).not.toHaveBeenCalled();
    unmount(); resetCardsCapabilitiesCache();
    cap.mockResolvedValueOnce({ cardsBancada: false });
    mount();
    await user.click(await screen.findByRole("button", { name: /Evoluir \(2 pedidos\)/ }));
    expect(onLegacy).toHaveBeenCalledTimes(1);
  });
  it("falha ao consultar a flag: botão desabilitado, erro com 'Tentar de novo' e, ao acertar, o fluxo de cards", async () => {
    cap.mockRejectedValueOnce(new ApiError("indisponível", 503, "UNAVAILABLE"));
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível verificar se este produto usa cards");
    expect(screen.getByRole("button", { name: /Evoluir/ })).toBeDisabled();
    cap.mockResolvedValueOnce({ cardsBancada: true });
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Evoluir/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Evoluir/ }));
    expect(onCards).toHaveBeenCalledWith("p1");
  });
});
