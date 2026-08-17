/**
 * Máscaras de entrada (padrão BR) para formulários. Funções puras, sem dependência de
 * biblioteca de máscara — o valor exibido é derivado do texto digitado a cada onChange.
 *
 * Cada campo tem um par: `normalizeX` (valor canônico, sem máscara, para validação/envio)
 * e `maskX` (valor formatado para exibição no input).
 */

/**
 * Normaliza a entrada de CNPJ para o valor canônico (sem máscara), já no NOVO modelo
 * alfanumérico da SEFAZ (vigência jul/2026): 14 posições — as 12 primeiras alfanuméricas
 * (A-Z, 0-9) e as 2 últimas (dígitos verificadores) numéricas. Retrocompatível: um CNPJ
 * puramente numérico passa inalterado.
 */
export function normalizeCnpjInput(raw: string): string {
  const c = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const base = c.slice(0, 12); // 12 posições alfanuméricas
  const dv = c.slice(12).replace(/[^0-9]/g, "").slice(0, 2); // 2 DV numéricos
  return base + dv;
}

/** Aplica a máscara visual XX.XXX.XXX/XXXX-XX ao CNPJ (ciente do formato alfanumérico). */
export function maskCnpj(raw: string): string {
  const p = normalizeCnpjInput(raw);
  let out = p.slice(0, 2);
  if (p.length > 2) out += "." + p.slice(2, 5);
  if (p.length > 5) out += "." + p.slice(5, 8);
  if (p.length > 8) out += "/" + p.slice(8, 12);
  if (p.length > 12) out += "-" + p.slice(12, 14);
  return out;
}

/** Só dígitos do CEP (máx. 8). */
export function normalizeCep(raw: string): string {
  return (raw ?? "").replace(/\D+/g, "").slice(0, 8);
}

/** Máscara de CEP: #####-###. */
export function maskCep(raw: string): string {
  const d = normalizeCep(raw);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

/** Só dígitos do telefone (máx. 11 — DDD + 9 do celular). */
export function normalizePhone(raw: string): string {
  return (raw ?? "").replace(/\D+/g, "").slice(0, 11);
}

/** Máscara de telefone BR: (##) ####-#### (fixo) ou (##) #####-#### (celular). */
export function maskPhone(raw: string): string {
  const d = normalizePhone(raw);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
