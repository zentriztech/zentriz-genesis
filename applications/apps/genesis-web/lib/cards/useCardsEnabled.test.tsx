import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api";
vi.mock("./cardsApi", () => ({ cardsApi: { capabilities: vi.fn() } }));
import { cardsApi } from "./cardsApi";
import { resetCardsCapabilitiesCache, useCardsCapabilities, useCardsEnabled } from "./useCardsEnabled";
const cap = cardsApi.capabilities as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { vi.clearAllMocks(); resetCardsCapabilitiesCache(); });

describe("useCardsEnabled (indicador da flag CARDS_BANCADA)", () => {
  it("true só com cardsBancada === true", async () => {
    cap.mockResolvedValue({ cardsBancada: true });
    const { result } = renderHook(() => useCardsEnabled("p1"));
    await waitFor(() => expect(result.current).toBe(true));
  });
  it("flag desligada ou 404 (produto de outro tenant/inexistente) ⇒ false e fica em cache", async () => {
    cap.mockResolvedValue({ cardsBancada: false });
    const a = renderHook(() => useCardsCapabilities("p1"));
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    expect(a.result.current).toMatchObject({ caps: { cardsBancada: false }, error: false });
    cap.mockRejectedValue(new ApiError("não encontrado", 404, "NOT_FOUND"));
    const b = renderHook(() => useCardsCapabilities("p2"));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(b.result.current).toMatchObject({ caps: null, error: false });
    renderHook(() => useCardsCapabilities("p2"));
    await new Promise((r) => setTimeout(r, 20));
    expect(cap).toHaveBeenCalledTimes(2);   // o 404 não é consultado de novo
  });
  it("Y-10: enquanto carrega o estado é 'loading' (não 'desligada'); a falha de rede é 'error' com retry e NÃO fica em cache", async () => {
    let resolve!: (v: unknown) => void;
    cap.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useCardsCapabilities("p1"));
    expect(result.current).toMatchObject({ loading: true, error: false, caps: null });
    await act(async () => { resolve({ cardsBancada: true }); });
    expect(result.current.caps?.cardsBancada).toBe(true);

    resetCardsCapabilitiesCache();
    cap.mockRejectedValueOnce(new Error("Failed to fetch"));
    const f = renderHook(() => useCardsCapabilities("p3"));
    await waitFor(() => expect(f.result.current.error).toBe(true));
    expect(f.result.current).toMatchObject({ loading: false, caps: null });
    cap.mockResolvedValueOnce({ cardsBancada: true });
    act(() => f.result.current.retry());
    await waitFor(() => expect(f.result.current.caps?.cardsBancada).toBe(true));
    expect(f.result.current.error).toBe(false);
    expect(cap).toHaveBeenCalledTimes(3);   // 1 ok + 1 falha + 1 nova tentativa: a falha não foi cacheada
  });
  it("500 e 401 também são erro (não 'desligada')", async () => {
    cap.mockRejectedValue(new ApiError("erro", 500, "INTERNAL"));
    const { result } = renderHook(() => useCardsCapabilities("p1"));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(useCardsEnabled).toBeDefined();
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
  it("Y-19: a sonda por TENANT divide o cache entre tenants (um produto de qualquer tenant não decide pelo outro)", async () => {
    cap.mockResolvedValueOnce({ cardsBancada: true }).mockResolvedValueOnce({ cardsBancada: false });
    const a = renderHook(() => useCardsEnabled("pA", { tenantKey: "tenant-a" })); await waitFor(() => expect(a.result.current).toBe(true));
    const b = renderHook(() => useCardsEnabled("pB", { tenantKey: "tenant-b" })); await waitFor(() => expect(cap).toHaveBeenCalledTimes(2));
    expect(b.result.current).toBe(false);
    const a2 = renderHook(() => useCardsEnabled("pA2", { tenantKey: "tenant-a" })); await waitFor(() => expect(a2.result.current).toBe(true));
    expect(cap).toHaveBeenCalledTimes(2);   // o mesmo tenant reaproveita a resposta
  });
  it("Y-19: o logout (authStore.logout) zera o cache de capacidades", async () => {
    const { authStore } = await import("@/stores/authStore");
    cap.mockResolvedValue({ cardsBancada: true });
    const a = renderHook(() => useCardsEnabled("p1")); await waitFor(() => expect(a.result.current).toBe(true));
    authStore.logout();
    cap.mockResolvedValue({ cardsBancada: false });
    const b = renderHook(() => useCardsEnabled("p1")); await waitFor(() => expect(cap).toHaveBeenCalledTimes(2));
    expect(b.result.current).toBe(false);
  });
});
