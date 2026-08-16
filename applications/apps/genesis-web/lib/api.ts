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
  try {
    const obj = JSON.parse(text) as { message?: string };
    if (obj && typeof obj.message === "string") return obj.message;
  } catch {
    // não é JSON, usa o texto
  }
  return text || "Erro na requisição";
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
