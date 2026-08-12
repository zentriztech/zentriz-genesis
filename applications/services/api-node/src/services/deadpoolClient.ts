/**
 * deadpoolClient — Cliente HTTP server-side para a API do Deadpool.
 *
 * Reusa a MESMA env do vínculo #60 (services/githubPush.ts):
 *   - DEADPOOL_BASE_URL  → base URL da API do Deadpool (vazio = integração desligada)
 *   - DEADPOOL_API_TOKEN → token Bearer opcional
 *
 * As credenciais nunca saem do servidor: o gateway /api/deadpool/* (routes/deadpool.ts)
 * é o único ponto que fala com o Deadpool; o portal só conversa com o Genesis.
 *
 * Filosofia: degradação graciosa. Se a base URL estiver ausente OU a chamada
 * falhar/estourar timeout, o chamador trata como "indisponível" e responde 200 com
 * payload vazio — o painel degrada limpo, nunca 500.
 */

const DEADPOOL_BASE_URL = (process.env.DEADPOOL_BASE_URL ?? "").trim().replace(/\/+$/, "");
const DEADPOOL_API_TOKEN = (process.env.DEADPOOL_API_TOKEN ?? "").trim();
const DEADPOOL_TIMEOUT_MS = 5000;

export function isDeadpoolConfigured(): boolean {
  return DEADPOOL_BASE_URL.length > 0;
}

/**
 * GET autenticado na API do Deadpool. Retorna o JSON já parseado.
 * Lança em: base URL ausente, timeout, erro de rede, status não-2xx ou JSON inválido.
 * O chamador captura e converte em resposta degradada (available:false).
 * NUNCA loga o token nem os headers de autorização.
 */
export async function deadpoolGet<T = unknown>(path: string): Promise<T> {
  if (!DEADPOOL_BASE_URL) {
    throw new Error("DEADPOOL_BASE_URL not configured");
  }
  const url = `${DEADPOOL_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (DEADPOOL_API_TOKEN) headers["Authorization"] = `Bearer ${DEADPOOL_API_TOKEN}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEADPOOL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Deadpool GET ${path} returned ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
