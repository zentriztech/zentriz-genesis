/**
 * cnpjLookup.ts — consulta de dados cadastrais por CNPJ.
 *
 * Porta `CnpjLookup` (abstração trocável) + adapter padrão ReceitaWS. Segue o padrão
 * HTTP de deadpoolClient.ts: fetch nativo + AbortController (timeout), base URL por env,
 * degradação graciosa (erro → lança; o chamador vira 200/erro-amigável, nunca 500 seco).
 *
 * Env:
 *   CNPJ_LOOKUP_BASE_URL  → base do endpoint (default https://receitaws.com.br/v1/cnpj)
 *   CNPJ_LOOKUP_TOKEN     → token Bearer opcional (plano pago ReceitaWS)
 *
 * CNPJ: por ora só numérico (14 dígitos). A coluna é TEXT (alfanumérico-ready para a
 * nova resolução SEFAZ), mas o lookup normaliza para dígitos antes de consultar.
 */

const BASE_URL = (process.env.CNPJ_LOOKUP_BASE_URL ?? "https://receitaws.com.br/v1/cnpj")
  .trim()
  .replace(/\/+$/, "");
const LOOKUP_TOKEN = (process.env.CNPJ_LOOKUP_TOKEN ?? "").trim();
const TIMEOUT_MS = 8000;

/** Resultado normalizado, independente do provider. */
export type CnpjLookupResult = {
  cnpj: string; // só dígitos
  name: string; // razão social
  tradeName?: string; // nome fantasia
  status?: string; // situação cadastral (ATIVA, etc.)
  email?: string;
  phone?: string;
  address: {
    cep?: string;
    street?: string;
    number?: string;
    complement?: string;
    district?: string;
    city?: string;
    state?: string;
  };
};

/** Porta: qualquer provider de lookup de CNPJ implementa isto. */
export interface CnpjLookup {
  lookup(cnpj: string): Promise<CnpjLookupResult>;
}

/** Mantém apenas dígitos (remove ./-, espaços). */
export function normalizeCnpjDigits(raw: string): string {
  return (raw ?? "").replace(/\D+/g, "");
}

/** Valida CNPJ numérico (14 dígitos + dígitos verificadores). */
export function isValidCnpj(raw: string): boolean {
  const c = normalizeCnpjDigits(raw);
  if (c.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(c)) return false; // todos iguais
  const calc = (len: number): number => {
    let sum = 0;
    let pos = len - 7;
    for (let i = len; i >= 1; i--) {
      sum += Number(c.charAt(len - i)) * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(12);
  if (d1 !== Number(c.charAt(12))) return false;
  const d2 = calc(13);
  return d2 === Number(c.charAt(13));
}

type ReceitaWsResponse = {
  status?: string; // "OK" | "ERROR"
  message?: string;
  nome?: string;
  fantasia?: string;
  situacao?: string;
  cnpj?: string;
  cep?: string;
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  municipio?: string;
  uf?: string;
  email?: string;
  telefone?: string;
};

/** Adapter ReceitaWS. */
export class ReceitaWsLookup implements CnpjLookup {
  async lookup(cnpjRaw: string): Promise<CnpjLookupResult> {
    const cnpj = normalizeCnpjDigits(cnpjRaw);
    if (!isValidCnpj(cnpj)) {
      throw new Error("CNPJ inválido");
    }
    const url = `${BASE_URL}/${cnpj}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (LOOKUP_TOKEN) headers["Authorization"] = `Bearer ${LOOKUP_TOKEN}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      if (res.status === 429) {
        throw new Error("Limite de consultas de CNPJ atingido. Tente novamente em instantes.");
      }
      if (!res.ok) {
        throw new Error(`Consulta de CNPJ falhou (HTTP ${res.status})`);
      }
      const data = (await res.json()) as ReceitaWsResponse;
      if ((data.status ?? "").toUpperCase() === "ERROR") {
        throw new Error(data.message || "CNPJ não encontrado");
      }
      return {
        cnpj,
        name: (data.nome ?? "").trim(),
        tradeName: (data.fantasia ?? "").trim() || undefined,
        status: (data.situacao ?? "").trim() || undefined,
        email: (data.email ?? "").trim() || undefined,
        phone: (data.telefone ?? "").trim() || undefined,
        address: {
          cep: normalizeCnpjDigits(data.cep ?? "") || undefined,
          street: (data.logradouro ?? "").trim() || undefined,
          number: (data.numero ?? "").trim() || undefined,
          complement: (data.complemento ?? "").trim() || undefined,
          district: (data.bairro ?? "").trim() || undefined,
          city: (data.municipio ?? "").trim() || undefined,
          state: (data.uf ?? "").trim() || undefined,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Singleton do provider padrão (trocável via injeção nos testes). */
let _provider: CnpjLookup | null = null;
export function cnpjLookupProvider(): CnpjLookup {
  if (!_provider) _provider = new ReceitaWsLookup();
  return _provider;
}

/** Injeta um provider (usado nos testes). */
export function setCnpjLookupProvider(p: CnpjLookup | null): void {
  _provider = p;
}

// ─── Cache em memória (TTL) ───────────────────────────────────────────────────
// O endpoint /api/cnpj é público e anônimo (o form de signup precisa consultar antes
// do login). Sem cache, cada request bate na ReceitaWS (que tem limite ~3/min no plano
// grátis) — um atacante amplifica DoS contra o provider + esgota nossa cota. Cache por
// CNPJ com TTL curto absorve repetição sem servir dado velho por muito tempo.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const CACHE_MAX = 5000;
type CacheEntry = { at: number; value: CnpjLookupResult };
const _cache = new Map<string, CacheEntry>();

/** Limpa o cache (usado nos testes para isolamento). */
export function clearCnpjCache(): void {
  _cache.clear();
}

/** Atalho de consulta usando o provider padrão, com cache por CNPJ. */
export async function lookupCnpj(cnpj: string): Promise<CnpjLookupResult> {
  const key = normalizeCnpjDigits(cnpj);
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  const value = await cnpjLookupProvider().lookup(cnpj);

  // Poda oportunista quando o Map cresce (não vaza memória em pico de consultas).
  if (_cache.size > CACHE_MAX) {
    for (const [k, e] of _cache) if (now - e.at >= CACHE_TTL_MS) _cache.delete(k);
  }
  _cache.set(key, { at: now, value });
  return value;
}
