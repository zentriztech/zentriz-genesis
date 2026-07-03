/**
 * typePolicyNormalizer.ts
 *
 * Normaliza project_type recebido de qualquer entrada (portal, Telegram, API)
 * aplicando type_aliases de policies.json.
 *
 * Fonte: applications/services/api-node/src/generated/policies.json
 * (gerado no build a partir de applications/agents/policies/project_types.yaml)
 *
 * Uso:
 *   import { normalizeProjectType } from "../services/typePolicyNormalizer.js";
 *   const canonical = normalizeProjectType(rawFromUser);
 *
 * Retorno:
 *   - Se `raw` é canônico → retorna `raw`
 *   - Se `raw` é alias → retorna canônico correspondente
 *   - Se `raw` é vazio ou desconhecido → retorna `raw` inalterado (não força _default;
 *     a resolução para _default acontece do lado do Python (pipeline_context) via
 *     _resolve_type — este helper só normaliza aliases conhecidos)
 */

import { readFileSync } from "fs";
import path from "path";

let CACHE: { types: Record<string, unknown>; type_aliases: Record<string, string> } | null = null;

function loadPolicies(): { types: Record<string, unknown>; type_aliases: Record<string, string> } {
  if (CACHE) return CACHE;
  // dist/services → dist → src/generated. Resolver relativo ao arquivo compilado.
  const candidates = [
    path.join(process.cwd(), "src", "generated", "policies.json"),
    path.join(process.cwd(), "dist", "generated", "policies.json"),
    path.join(process.cwd(), "generated", "policies.json"),
    // Fallback dev: __dirname relativo — pode ser útil em contextos de teste
    path.join(process.cwd(), "applications", "services", "api-node", "src", "generated", "policies.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as { types?: Record<string, unknown>; type_aliases?: Record<string, string> };
      CACHE = {
        types: parsed.types ?? {},
        type_aliases: parsed.type_aliases ?? {},
      };
      return CACHE;
    } catch {
      // tenta próximo
    }
  }
  // Se nenhum candidato existe, retornar vazio — modo dev antes do primeiro build
  console.warn("[typePolicyNormalizer] policies.json não encontrado; normalização será NO-OP");
  CACHE = { types: {}, type_aliases: {} };
  return CACHE;
}

/**
 * Aplica type_aliases se `raw` for um alias conhecido. Senão devolve `raw`.
 * NÃO transforma tipos desconhecidos em _default — isso é feito no Python side.
 */
export function normalizeProjectType(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const { types, type_aliases } = loadPolicies();
  // Se já é canônico, mantém
  if (types[trimmed]) return trimmed;
  // Se é alias, resolve
  if (type_aliases[trimmed]) return type_aliases[trimmed];
  // Desconhecido — devolve como está (Python side vira _default)
  return trimmed;
}

/**
 * Retorna true se `raw` é reconhecido pelo policy (canônico ou alias).
 * Útil para telemetria: distinguir "tipo válido" de "tipo fantasma".
 */
export function isKnownProjectType(raw: string | null | undefined): boolean {
  if (!raw || typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const { types, type_aliases } = loadPolicies();
  return Boolean(types[trimmed] || type_aliases[trimmed]);
}
