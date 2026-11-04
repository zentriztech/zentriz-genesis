import { apiDelete, apiGet, apiPatch, apiPost, apiPostMultipart, withQuery } from "@/lib/api";
import type { BaseSpec, CardCapabilities, CardDetail, CardJourney, CardKind, CardListResponse, CardState, CardSummary } from "./types";
import { ApiError } from "@/lib/api";

export const cardsApi = {
  capabilities: (productId: string) => apiGet<CardCapabilities>(`/api/products/${productId}/cards/capabilities`),
  list: (productId: string, p: { kind?: CardKind | ""; states?: CardState[]; limit?: number; offset?: number } = {}) =>
    apiGet<CardListResponse>(withQuery(`/api/products/${productId}/cards`, {
      kind: p.kind || undefined, state: p.states?.length ? p.states.join(",") : undefined, limit: p.limit ?? 100, offset: p.offset,
    })),
  create: (productId: string, f: { kind: CardKind; title: string; body: string; files?: File[] }) => {
    const fd = new FormData();
    fd.append("kind", f.kind);
    if (f.title.trim()) fd.append("title", f.title.trim());
    fd.append("body", f.body);
    for (const file of f.files ?? []) fd.append("files", file, file.name);
    return apiPostMultipart<CardSummary & { body: string }>(`/api/products/${productId}/cards`, fd);
  },
  get: (id: string) => apiGet<CardDetail>(`/api/cards/${id}`),
  patch: (id: string, b: { title?: string; body?: string; kind?: CardKind }) => apiPatch<CardSummary>(`/api/cards/${id}`, b),
  refine: (id: string) => apiPost<{ ok: boolean; card: CardSummary }>(`/api/cards/${id}/refine`, {}),
  ready: (id: string) => apiPost<{ ok: boolean; card: CardSummary; gate?: unknown }>(`/api/cards/${id}/ready`, {}),
  reject: (id: string) => apiPost<{ ok: boolean; card: CardSummary }>(`/api/cards/${id}/reject`, {}),
  resume: (id: string) => apiPost<{ ok: boolean; card: CardSummary }>(`/api/cards/${id}/resume`, {}),
  revalidate: (id: string) => apiPost<{ ok: boolean; card: CardSummary; message?: string }>(`/api/cards/${id}/revalidate`, {}),
  promote: (id: string) => apiPost<{ childProjectId: string; versionNumber: number; cardId: string; cardState: CardState; replayed?: boolean; resumed?: boolean }>(`/api/cards/${id}/promote`, {}),
  remove: (id: string) => apiDelete(`/api/cards/${id}`),
  baseSpec: (id: string) => apiGet<BaseSpec>(`/api/cards/${id}/base-spec`),
  /** ASSUMIDO (K1). 404/501 ⇒ `null` e o portal deriva a linha do tempo dos eventos do card. */
  journey: async (id: string): Promise<CardJourney | null> => {
    try { return await apiGet<CardJourney>(`/api/cards/${id}/journey`); }
    catch (e) { if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return null; throw e; }
  },
};
