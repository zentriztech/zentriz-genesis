import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
vi.mock("./cardsApi", () => ({ cardsApi: { capabilities: vi.fn() } }));
import { cardsApi } from "./cardsApi";
import { resetCardsCapabilitiesCache, useCardsEnabled } from "./useCardsEnabled";
const cap = cardsApi.capabilities as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { vi.clearAllMocks(); resetCardsCapabilitiesCache(); });

describe("useCardsEnabled (indicador da flag CARDS_BANCADA)", () => {
  it("true só com cardsBancada === true", async () => {
    cap.mockResolvedValue({ cardsBancada: true });
    const { result } = renderHook(() => useCardsEnabled("p1"));
    await waitFor(() => expect(result.current).toBe(true));
  });
  it("flag off, 404 ou falha de rede ⇒ false (portal idêntico ao atual)", async () => {
    cap.mockResolvedValue({ cardsBancada: false });
    expect(renderHook(() => useCardsEnabled("p1")).result.current).toBe(false);
    resetCardsCapabilitiesCache();
    cap.mockRejectedValue(new Error("404"));
    const { result } = renderHook(() => useCardsEnabled("p2"));
    await waitFor(() => expect(cap).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(false);
  });
  it("sem produto não consulta a API", () => {
    const { result } = renderHook(() => useCardsEnabled(undefined));
    expect(result.current).toBe(false);
    expect(cap).not.toHaveBeenCalled();
  });
  it("consulta uma vez por produto (cache)", async () => {
    cap.mockResolvedValue({ cardsBancada: true });
    const a = renderHook(() => useCardsEnabled("p1")); await waitFor(() => expect(a.result.current).toBe(true));
    const b = renderHook(() => useCardsEnabled("p1")); await waitFor(() => expect(b.result.current).toBe(true));
    expect(cap).toHaveBeenCalledTimes(1);
  });
});
