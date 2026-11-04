import { apiDelete, apiGet, apiPatch, apiPost, apiPostMultipart, withQuery } from "@/lib/api";
import type {
  BaseSpec, CardActionResponse, CardAttachmentsResponse, CardCapabilities, CardDetail, CardJourney, CardKind, CardListResponse, CardState, CardSummary,
  PromoteResponse, ReadyResponse, ResumeResponse, RevalidateResponse,
} from "./types";

// Cliente tipado dos endpoints REAIS de cards (api-node `routes/cards.ts`). Cada retorno é validado contra as fixtures reais em
// `contract.test.ts`; não há mais rota "assumida".
export const cardsApi = {
  capabilities: (productId: string) => apiGet<CardCapabilities>(`/api/products/${productId}/cards/capabilities`),
  list: (productId: string, p: { kind?: CardKind | ""; states?: CardState[]; origin?: "manual" | "import"; limit?: number; offset?: number } = {}) =>
    apiGet<CardListResponse>(withQuery(`/api/products/${productId}/cards`, {
      kind: p.kind || undefined, state: p.states?.length ? p.states.join(",") : undefined, origin: p.origin, limit: p.limit ?? 100, offset: p.offset,
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
  refine: (id: string) => apiPost<CardActionResponse>(`/api/cards/${id}/refine`, {}),
  ready: (id: string) => apiPost<ReadyResponse>(`/api/cards/${id}/ready`, {}),
  reject: (id: string) => apiPost<CardActionResponse>(`/api/cards/${id}/reject`, {}),
  /** ready → refining: destrava a spec do rascunho (o carimbo "pronto" cai e é preciso validar de novo). */
  reopen: (id: string) => apiPost<CardActionResponse>(`/api/cards/${id}/reopen`, {}),
  resume: (id: string) => apiPost<ResumeResponse>(`/api/cards/${id}/resume`, {}),
  revalidate: (id: string) => apiPost<RevalidateResponse>(`/api/cards/${id}/revalidate`, {}),
  promote: (id: string) => apiPost<PromoteResponse>(`/api/cards/${id}/promote`, {}),
  remove: (id: string) => apiDelete(`/api/cards/${id}`),
  baseSpec: (id: string) => apiGet<BaseSpec>(`/api/cards/${id}/base-spec`),
  /** Etapas, bloqueios da próxima etapa, ação sugerida, trava da spec e base vencida: o servidor decide, a tela renderiza. */
  journey: (id: string) => apiGet<CardJourney>(`/api/cards/${id}/journey`),
  attachments: (id: string) => apiGet<CardAttachmentsResponse>(`/api/cards/${id}/attachments`),
};
