/**
 * T-16: Hook useProjectTypes()
 *
 * Lê policies.json via /api/internal/policies/list para derivar a lista
 * de tipos canônicos disponíveis, ao invés de hardcode em spec/page.tsx.
 *
 * Retorna:
 *   {
 *     loading: boolean,
 *     types: [{ value, label, group }],  // ordenado por group + label
 *     aliases: { [alias]: canonical },   // para normalização client-side
 *     version: string,                    // v0.3.0, etc.
 *   }
 *
 * Uso:
 *   const { types, loading } = useProjectTypes();
 *   {types.map(t => <MenuItem value={t.value}>{t.label}</MenuItem>)}
 */
"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

export interface ProjectTypeOption {
  value: string;
  label: string;
  group: string;
}

interface PolicyTypeMeta {
  labels?: { pt_br?: string; en?: string };
  inherit_from?: string | null;
}

interface PoliciesJson {
  version: string;
  types: Record<string, PolicyTypeMeta>;
  type_aliases: Record<string, string>;
}

// Fallback estático — usado quando policies.json falha ao carregar (offline dev).
// Mantido curto (5 tipos-piloto Wave 0) para nunca deixar o portal vazio.
const FALLBACK: ProjectTypeOption[] = [
  { group: "Backend",  value: "backend_api",         label: "🔌 API REST (Node)" },
  { group: "Backend",  value: "backend_api_python",  label: "🐍 API REST (Python)" },
  { group: "Frontend", value: "frontend_dashboard",  label: "📊 Dashboard / Admin" },
  { group: "Frontend", value: "frontend_landing",    label: "🏠 Landing Page" },
  { group: "Outros",   value: "other",               label: "❓ Outro (declarado)" },
];

/**
 * Deriva o "group" (Backend / Frontend / etc.) do canonical_type.
 * Preferência: inherit_from (mais fiel ao YAML) → prefix do id.
 */
function deriveGroup(id: string, meta: PolicyTypeMeta): string {
  const parent = meta.inherit_from ?? "";
  if (parent === "backend")   return "Backend";
  if (parent === "frontend")  return "Frontend";
  if (parent === "fullstack") return "Fullstack";
  if (parent === "mobile")    return "Mobile";
  if (parent === "bot")       return "Automação / Bots";
  // fallback pelo prefix do id
  if (id.startsWith("backend_"))   return "Backend";
  if (id.startsWith("frontend_"))  return "Frontend";
  if (id.startsWith("fullstack_")) return "Fullstack";
  if (id.startsWith("mobile_"))    return "Mobile";
  if (id.startsWith("bot_"))       return "Automação / Bots";
  if (id.startsWith("lib_"))       return "Bibliotecas";
  if (id.startsWith("infra_"))     return "Infraestrutura";
  return "Outros";
}

let CACHE: {
  types: ProjectTypeOption[];
  aliases: Record<string, string>;
  version: string;
} | null = null;

export function useProjectTypes(): {
  loading: boolean;
  types: ProjectTypeOption[];
  aliases: Record<string, string>;
  version: string;
} {
  const [loading, setLoading] = useState(!CACHE);
  const [types, setTypes]     = useState<ProjectTypeOption[]>(CACHE?.types ?? FALLBACK);
  const [aliases, setAliases] = useState<Record<string, string>>(CACHE?.aliases ?? {});
  const [version, setVersion] = useState<string>(CACHE?.version ?? "fallback");

  useEffect(() => {
    if (CACHE) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<PoliciesJson>("/api/internal/policies/list");
        // Filtra tipos privados (_default, mobile_crossplatform stub e similares
        // são mantidos porque podem aparecer via alias, mas _default e reservados
        // com prefixo _ ficam fora do dropdown).
        const entries = Object.entries(data.types).filter(([id]) => !id.startsWith("_"));
        const out: ProjectTypeOption[] = entries.map(([id, meta]) => ({
          value: id,
          label: meta.labels?.pt_br ?? meta.labels?.en ?? id,
          group: deriveGroup(id, meta),
        }));
        // Ordenar: group então label
        out.sort((a, b) => {
          if (a.group !== b.group) return a.group.localeCompare(b.group);
          return a.label.localeCompare(b.label);
        });
        CACHE = { types: out, aliases: data.type_aliases ?? {}, version: data.version };
        if (!cancelled) {
          setTypes(out);
          setAliases(data.type_aliases ?? {});
          setVersion(data.version);
        }
      } catch (err) {
        console.warn("[useProjectTypes] falha ao carregar policies.json — usando FALLBACK", err);
        // Mantém FALLBACK
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { loading, types, aliases, version };
}

/**
 * Normaliza um valor bruto (potencialmente alias) para tipo canônico.
 * Uso: `const canonical = normalize(rawFromApi, aliases);`
 */
export function normalizeType(raw: string | null | undefined, aliases: Record<string, string>): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return aliases[trimmed] ?? trimmed;
}
