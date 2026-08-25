// URL base da API — NEXT_PUBLIC_API_BASE_URL é embutida em build time pelo Next.js.
// Fallback vazio faz o browser usar origem relativa (funciona em qualquer deploy).
const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

function getAuthHeaders(): Record<string, string> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("genesis_token") : null;
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

/** Extrai mensagem amigável do corpo de erro da API (ex.: { code, message }) */
async function getErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => res.statusText);
  let message = text || "Erro na requisição";
  try {
    const obj = JSON.parse(text) as { message?: string; code?: string };
    if (obj && typeof obj.message === "string") message = obj.message;
    // F2/H3: tenant suspenso/inativado no meio da sessão. O token ainda é válido,
    // mas o gate de inadimplência bloqueia. Encerra a sessão e volta ao login, onde
    // a mensagem de bloqueio (mesma origem) é exibida de forma clara.
    if (
      res.status === 403 &&
      obj?.code === "TENANT_INACTIVE" &&
      typeof window !== "undefined"
    ) {
      localStorage.removeItem("genesis_token");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
  } catch {
    // não é JSON, usa o texto
  }
  return message;
}

/** Anexa query params a um path, ignorando valores null/undefined/"". Ex.: withQuery("/api/projects", { tenantId }) */
export function withQuery(path: string, params: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(await getErrorMessage(res));
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await getErrorMessage(res));
  return res.json() as Promise<T>;
}

export async function apiPostMultipart<T>(
  path: string,
  formData: FormData
): Promise<T> {
  const headers = getAuthHeaders();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    credentials: "include",
    body: formData,
  });
  if (!res.ok) throw new Error(await getErrorMessage(res));
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await getErrorMessage(res));
  return res.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await getErrorMessage(res));
  return res.json() as Promise<T>;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(await getErrorMessage(res));
}

// DELETE que envia body JSON (ex.: confirmação de exclusão) e devolve a resposta parseada.
export async function apiDeleteJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(await getErrorMessage(res));
  return res.json() as Promise<T>;
}
