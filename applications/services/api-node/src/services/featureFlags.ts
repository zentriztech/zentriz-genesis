/**
 * featureFlags.ts — RESOLUÇÃO ÚNICA das flags da Fase 1' (achado M-03 da revisão adversarial).
 *
 * Flags cobertas (todas `off` por padrão): EVOLVE_CLAIM, TICKET_TRANSITIONS, EVOLUTION_PROMOTE_BANCADA,
 * ATTACHMENTS_STRICT, ATTACHMENT_CONVERSION, TASK_INHERIT_TRANSITIVE, CARDS_BANCADA (bool 0|1) e EVOLVE_RECONCILER (tri 0=off | 1=shadow | 2=on).
 *
 * PRECEDÊNCIA (a mais específica vence; NUNCA o ambiente sobrepõe o tenant):
 *   1. `genesis_runtime_config` com `tenant_id = <tenant do recurso>`  — decisão EXPLÍCITA do tenant (só zentriz_admin grava);
 *   2. `genesis_runtime_config` com `tenant_id IS NULL`                 — padrão GLOBAL da plataforma, em configuração;
 *   3. variável de ambiente (`EVOLVE_CLAIM=on` etc.)                    — DEFAULT de plataforma (compose/boot), só vale quando
 *                                                                          nenhuma linha de config existe para a chave
 *                                                                          (EXCETO flags `configOnly`, como CARDS_BANCADA: o env é ignorado — S-06);
 *   4. nada / valor inválido / erro de banco                            — `off` (fail-safe).
 * Uma linha de config com valor inválido é IGNORADA (com aviso) e a resolução segue para o nível seguinte.
 *
 * Quem grava: `PUT /api/admin/runtime-config/:key` — chaves desta lista são `adminOnly` (só `zentriz_admin`; `tenant_admin`
 * recebe 403), porque ligar/desligar uma flag de rollout é decisão de plataforma, não do tenant.
 *
 * Api e runner nunca divergem: o runner NÃO lê `ATTACHMENTS_STRICT`/`TASK_INHERIT_TRANSITIVE` do próprio ambiente; ele recebe
 * o valor efetivo do projeto por `GET /api/projects/:id/effective-flags` (routes/projectFlags.ts), calculado por esta função.
 */
import type { RuntimeConfigDb } from "./runtimeTunables.js";

export type FlagKind = "bool" | "tri";
export interface FlagDef {
  key: string; kind: FlagKind; label: string;
  /** `true` = a flag só vale por CONFIGURAÇÃO (`genesis_runtime_config`); o ambiente (compose/boot) é IGNORADO (S-06). */
  configOnly?: boolean;
}

export const FLAG_DEFS = {
  EVOLVE_CLAIM: { key: "EVOLVE_CLAIM", kind: "bool", label: "Evoluir: claim transacional do /evolve" },
  TICKET_TRANSITIONS: { key: "TICKET_TRANSITIONS", kind: "bool", label: "Pedidos: transições validadas" },
  EVOLUTION_PROMOTE_BANCADA: { key: "EVOLUTION_PROMOTE_BANCADA", kind: "bool", label: "Evoluir: filho promovível na Bancada" },
  ATTACHMENTS_STRICT: { key: "ATTACHMENTS_STRICT", kind: "bool", label: "Anexos do card: modo estrito (api e runner)" },
  TASK_INHERIT_TRANSITIVE: { key: "TASK_INHERIT_TRANSITIVE", kind: "bool", label: "Herança transitiva de tasks (runner)" },
  ATTACHMENT_CONVERSION: { key: "ATTACHMENT_CONVERSION", kind: "bool", label: "Anexos do card: conversão automática pdf/doc/docx para .md (exige ATTACHMENTS_STRICT)" },
  EVOLVE_RECONCILER: { key: "EVOLVE_RECONCILER", kind: "tri", label: "Reconciliador do /evolve (0=off, 1=shadow, 2=on)" },
  // Fase 2 (2.5): portas de entrada dos cards na Bancada. Ligar para o tenant dispara o backfill de card_state (services/cardsBackfill.ts).
  // S-06: configOnly — ligar por env valeria para todo tenant SEM backfill (só o PUT/DELETE o dispara) e deixaria tickets `card_state NULL`.
  CARDS_BANCADA: { key: "CARDS_BANCADA", kind: "bool", label: "Bancada: cards (máquina de estados, rascunho de card)", configOnly: true },
} as const satisfies Record<string, FlagDef>;

export type FlagName = keyof typeof FLAG_DEFS;
export const FLAG_NAMES = Object.keys(FLAG_DEFS) as FlagName[];

/** `true` se `key` é uma das flags de rollout desta lista (usado pela guarda `adminOnly` das rotas de config). */
export function isRolloutFlagKey(key: string): key is FlagName {
  return Object.prototype.hasOwnProperty.call(FLAG_DEFS, key);
}

export type FlagSource = "tenant" | "global" | "env" | "default";
export interface ResolvedFlag { value: number; source: FlagSource }

/** Interpreta o ambiente como DEFAULT da plataforma. `null` = ausente/inválido. */
export function parseEnvFlag(raw: string | undefined | null, kind: FlagKind): number | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return null;
  if (["on", "1", "true"].includes(v)) return kind === "tri" ? 2 : 1;
  if (["off", "0", "false"].includes(v)) return 0;
  if (kind === "tri" && v === "shadow") return 1;
  return null;
}

/**
 * D-8 (AR): interpreta o valor GRAVADO na tabela. Aceita o inteiro canônico ("0"/"1"/"2") e também os sinônimos do ambiente
 * ("on"/"true"/"off"/"false"/"shadow"), de forma CONSISTENTE com `parseEnvFlag` — antes `'on'` era ignorado em silêncio e a
 * flag ficava morta. `null` = valor inválido para esta flag. Puro (sem log).
 */
export function parseFlagConfigValue(raw: unknown, kind: FlagKind): number | null {
  const txt = String(raw ?? "").trim();
  if (txt === "") return null;
  const max = kind === "tri" ? 2 : 1;
  const n = Number(txt);
  if (Number.isInteger(n)) return n >= 0 && n <= max ? n : null;
  return parseEnvFlag(txt, kind);
}

/** Forma canônica ("0"/"1"/"2") para GRAVAR; `null` = recusar com erro claro. */
export function normalizeFlagValueForWrite(raw: unknown, kind: FlagKind): string | null {
  const n = parseFlagConfigValue(raw, kind);
  return n === null ? null : String(n);
}

function parseConfigValue(raw: unknown, kind: FlagKind, key: string, level: string): number | null {
  const n = parseFlagConfigValue(raw, kind);
  if (n === null) {
    const max = kind === "tri" ? 2 : 1;
    console.warn(`[FeatureFlags] ${key} (${level})=${JSON.stringify(raw)} IGNORADO: esperado inteiro em [0, ${max}] ou on/off/true/false${kind === "tri" ? "/shadow" : ""}`);
  }
  return n;
}

/**
 * Resolve uma flag para um tenant (ou só o nível global quando `tenantId` é null). Nunca lança.
 * `envRaw`: valor do ambiente (default de plataforma); por padrão lê `process.env[key]`.
 */
export async function resolveFlag(
  db: RuntimeConfigDb,
  name: FlagName,
  tenantId: string | null,
  envRaw: string | undefined = process.env[name],
): Promise<ResolvedFlag> {
  const def: FlagDef = FLAG_DEFS[name];
  try {
    const r = await db.query(
      `SELECT tenant_id, value FROM genesis_runtime_config
        WHERE key = $1 AND (tenant_id IS NULL OR tenant_id = $2)
        ORDER BY tenant_id NULLS LAST`,
      [def.key, tenantId],
    );
    // ORDER BY ... NULLS LAST: a linha do tenant (se existir) vem antes da global.
    const tenantRow = r.rows.find((x) => x.tenant_id !== null && x.tenant_id !== undefined);
    const globalRow = r.rows.find((x) => x.tenant_id === null || x.tenant_id === undefined);
    if (tenantRow) {
      const n = parseConfigValue(tenantRow.value, def.kind, def.key, "tenant");
      if (n !== null) return { value: n, source: "tenant" };
    }
    if (globalRow) {
      const n = parseConfigValue(globalRow.value, def.kind, def.key, "global");
      if (n !== null) return { value: n, source: "global" };
    }
  } catch (e) {
    console.warn(`[FeatureFlags] ${def.key} não lida (${e instanceof Error ? e.message : String(e)}) — fail-safe off`);
    return { value: 0, source: "default" };
  }
  if ((def as FlagDef).configOnly) {
    if (parseEnvFlag(envRaw, def.kind)) console.warn(`[FeatureFlags] ${def.key}=${JSON.stringify(envRaw)} no ambiente é IGNORADO: esta flag só vale por configuração (PUT /api/admin/runtime-config/${def.key}), que dispara o backfill`);
    return { value: 0, source: "default" };
  }
  const env = parseEnvFlag(envRaw, def.kind);
  if (env !== null) return { value: env, source: "env" };
  return { value: 0, source: "default" };
}

/** Atalho booleano (`tri` conta como ligada em shadow ou on). */
export async function flagEnabled(db: RuntimeConfigDb, name: FlagName, tenantId: string | null, envRaw?: string): Promise<boolean> {
  return (await resolveFlag(db, name, tenantId, envRaw ?? process.env[name])).value >= 1;
}

/** Resolve o tenant de um projeto (null se não houver/erro). */
export async function tenantOfProject(db: RuntimeConfigDb, projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  try {
    const r = await db.query("SELECT tenant_id FROM projects WHERE id = $1", [projectId]);
    const t = r.rows[0]?.tenant_id;
    return t ? String(t) : null;
  } catch {
    return null; // id inválido etc.: a rota devolve o erro de sempre
  }
}

/** Valores EFETIVOS de um projeto (tenant do projeto) — o contrato que a api entrega ao runner. */
export interface EffectiveProjectFlags {
  attachmentsStrict: boolean;
  taskInheritTransitive: boolean;
  sources: { attachmentsStrict: FlagSource; taskInheritTransitive: FlagSource };
}

export async function effectiveProjectFlags(db: RuntimeConfigDb, tenantId: string | null): Promise<EffectiveProjectFlags> {
  const [a, t] = await Promise.all([
    resolveFlag(db, "ATTACHMENTS_STRICT", tenantId),
    resolveFlag(db, "TASK_INHERIT_TRANSITIVE", tenantId),
  ]);
  return {
    attachmentsStrict: a.value >= 1,
    taskInheritTransitive: t.value >= 1,
    sources: { attachmentsStrict: a.source, taskInheritTransitive: t.source },
  };
}

export type ReconcilerMode = "off" | "shadow" | "on";
const RECONCILER_MODES: ReconcilerMode[] = ["off", "shadow", "on"];

/**
 * Modo EFETIVO do reconciliador do /evolve (job de PLATAFORMA, não por tenant): linha GLOBAL de `genesis_runtime_config`
 * (0=off, 1=shadow, 2=on) > env `EVOLVE_RECONCILER` (default de plataforma) > off. Nunca lança.
 */
export async function resolveReconcilerMode(db: RuntimeConfigDb, env: NodeJS.ProcessEnv = process.env): Promise<ReconcilerMode> {
  const r = await resolveFlag(db, "EVOLVE_RECONCILER", null, env.EVOLVE_RECONCILER);
  return RECONCILER_MODES[r.value] ?? "off";
}
