/**
 * format.ts — formatadores únicos do portal (pt-BR).
 *
 * Épico Spec/Bancada Onda 5 (G12): um só lugar para US$, duração, percentual e delta,
 * reusado por KpiCard/DashboardKpis (e, futuramente, DashboardLiveOps).
 * Regras: entrada tolerante (null/undefined/NaN/string numérica) → saída "—" quando
 * não houver valor; nunca lançar exceção por dado ruim vindo da API.
 */

const EM_DASH = "—";

const intFmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const usdFmt = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdCompactFmt = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const pctFmtCache = new Map<number, Intl.NumberFormat>();

/** Converte qualquer entrada da API em número finito ou null. */
export function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Inteiro com separador de milhar pt-BR: 1234 → "1.234". */
export function formatInt(v: unknown): string {
  const n = toFiniteNumber(v);
  if (n === null) return EM_DASH;
  return intFmt.format(Math.round(n));
}

/**
 * Dólar em pt-BR: 1234.5 → "US$ 1.234,50". Valores minúsculos (> 0 e < US$ 0,01)
 * viram "< US$ 0,01" para não exibir "US$ 0,00" num custo que existe.
 * `compact` usa notação curta (US$ 1,2 mil) para caber em cards estreitos.
 */
export function formatUsd(v: unknown, opts: { compact?: boolean } = {}): string {
  const n = toFiniteNumber(v);
  if (n === null) return EM_DASH;
  if (n > 0 && n < 0.01) return `< ${usdFmt.format(0.01)}`;
  if (opts.compact && Math.abs(n) >= 10_000) return usdCompactFmt.format(n);
  return usdFmt.format(n);
}

/**
 * Duração legível a partir de segundos: 45 → "45 s", 750 → "12 min",
 * 7 380 → "2 h 03 min", 100 000 → "1 d 3 h". Negativo/NaN/null → "—".
 */
export function formatDuration(sec: unknown): string {
  const n = toFiniteNumber(sec);
  if (n === null || n < 0) return EM_DASH;
  const s = Math.round(n);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (s < 3600) return `${m} min`;
  const h = Math.floor(s / 3600);
  if (s < 86_400) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  const d = Math.floor(s / 86_400);
  return `${d} d ${h % 24} h`;
}

/** Percentual a partir de razão 0–1: 0.125 → "12,5%" (digits=1) / "13%" (digits=0). */
export function formatPercent(ratio: unknown, digits = 0): string {
  const n = toFiniteNumber(ratio);
  if (n === null) return EM_DASH;
  let f = pctFmtCache.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits });
    pctFmtCache.set(digits, f);
  }
  return f.format(n);
}

export type DeltaDirection = "up" | "down" | "flat";

/**
 * Delta com sinal explícito (nunca só cor): +3 → "+3", -2 → "−2", 0 → "0".
 * Devolve também a direção para o ícone de seta. null quando não há dado.
 */
export function formatDelta(delta: unknown): { text: string; direction: DeltaDirection } | null {
  const n = toFiniteNumber(delta);
  if (n === null) return null;
  const r = Math.round(n);
  if (r === 0) return { text: "0", direction: "flat" };
  return r > 0
    ? { text: `+${intFmt.format(r)}`, direction: "up" }
    : { text: `−${intFmt.format(Math.abs(r))}`, direction: "down" };
}

/** "há 12 s" / "há 3 min" / "há 2 h" — para o carimbo "atualizado há …". */
export function formatAgo(from: number | Date | null | undefined, now: number = Date.now()): string {
  if (from === null || from === undefined) return EM_DASH;
  const t = typeof from === "number" ? from : from.getTime();
  if (!Number.isFinite(t)) return EM_DASH;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  return `há ${Math.floor(s / 3600)} h`;
}

/** Hora curta pt-BR de um ISO/Date: "14:05" (hoje) ou "03/09 14:05" (outro dia). */
export function formatShortTime(iso: string | Date | null | undefined, now: Date = new Date()): string {
  if (!iso) return EM_DASH;
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return EM_DASH;
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
