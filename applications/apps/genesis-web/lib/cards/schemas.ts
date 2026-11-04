// Validador mínimo (sem dependência) + schemas dos payloads REAIS da API de cards.
//
// Dois usos, ambos para o portal não voltar a divergir do backend:
//  1. em tempo de TESTE, `contract.test.ts` valida cada fixture de `__contract__/*.json` (geradas pelas respostas reais do api-node);
//  2. em tempo de COMPILAÇÃO, o final deste arquivo exige que o tipo inferido de cada schema seja MUTUAMENTE atribuível ao tipo
//     escrito em `types.ts`: mudar um lado sem o outro quebra o `tsc --noEmit`.
// Objetos são ESTRITOS (campo novo do backend que o portal não conhece = erro), salvo `passthrough`.
import type {
  BaseSpec, CardActionResponse, CardAttachmentsResponse, CardDetail, CardJourney, CardListResponse, CardSummary, PromoteResponse,
  ReadyResponse, ResumeResponse, RevalidateResponse,
} from "./types";

export interface Sch<T> {
  readonly _t?: T;
  readonly opt?: true;
  check(v: unknown, path: string, errs: string[]): void;
}
export type Out<S> = S extends Sch<infer T> ? T : never;
type Shape = Record<string, Sch<unknown>>;
type OptKeys<S extends Shape> = { [K in keyof S]: S[K] extends { opt: true } ? K : never }[keyof S];
type ObjOut<S extends Shape> = { [K in Exclude<keyof S, OptKeys<S>>]: Out<S[K]> } & { [K in OptKeys<S>]?: Exclude<Out<S[K]>, undefined> };
type Flat<T> = { [K in keyof T]: T[K] };

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const prim = <T>(name: string, test: (v: unknown) => boolean): Sch<T> => ({
  check: (v, p, e) => { if (!test(v)) e.push(`${p}: esperado ${name}, veio ${kind(v)}`); },
});

export const s = {
  string: prim<string>("string", (v) => typeof v === "string"),
  number: prim<number>("number", (v) => typeof v === "number" && Number.isFinite(v)),
  boolean: prim<boolean>("boolean", (v) => typeof v === "boolean"),
  null: prim<null>("null", (v) => v === null),
  unknown: { check: () => undefined } as Sch<unknown>,
  /** ISO-8601 em string. */
  date: prim<string>("data ISO", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v))),
  literal: <T extends string | number | boolean>(...vals: T[]): Sch<T> => ({
    check: (v, p, e) => { if (!vals.includes(v as T)) e.push(`${p}: esperado ${vals.map((x) => JSON.stringify(x)).join(" | ")}, veio ${JSON.stringify(v)}`); },
  }),
  nullable: <T>(inner: Sch<T>): Sch<T | null> => ({ check: (v, p, e) => { if (v !== null) inner.check(v, p, e); } }),
  optional: <T>(inner: Sch<T>): Sch<T | undefined> & { opt: true } => ({ opt: true, check: (v, p, e) => { if (v !== undefined) inner.check(v, p, e); } }),
  array: <T>(inner: Sch<T>): Sch<T[]> => ({
    check: (v, p, e) => { if (!Array.isArray(v)) { e.push(`${p}: esperado array, veio ${kind(v)}`); return; } v.forEach((x, i) => inner.check(x, `${p}[${i}]`, e)); },
  }),
  record: <T>(inner: Sch<T>): Sch<Record<string, T>> => ({
    check: (v, p, e) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) { e.push(`${p}: esperado objeto, veio ${kind(v)}`); return; }
      for (const [k, x] of Object.entries(v)) inner.check(x, `${p}.${k}`, e);
    },
  }),
  /** Variantes do mesmo código (ex.: corpo por rota): vale se QUALQUER uma passar; senão reporta os erros da mais próxima. */
  oneOf: <A extends Sch<unknown>[]>(...alts: A): Sch<Out<A[number]>> => ({
    check: (v, p, e) => {
      let best: string[] | null = null;
      for (const a of alts) {
        const errs: string[] = [];
        a.check(v, p, errs);
        if (errs.length === 0) return;
        if (!best || errs.length < best.length) best = errs;
      }
      e.push(...(best ?? [`${p}: nenhuma variante aceita`]));
    },
  }),
  object: <S extends Shape>(shape: S, opts: { passthrough?: boolean } = {}): Sch<Flat<ObjOut<S>>> => ({
    check: (v, p, e) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) { e.push(`${p}: esperado objeto, veio ${kind(v)}`); return; }
      const o = v as Record<string, unknown>;
      for (const [k, sc] of Object.entries(shape)) {
        if (!(k in o) || o[k] === undefined) { if (!sc.opt) e.push(`${p}.${k}: campo ausente`); continue; }
        sc.check(o[k], `${p}.${k}`, e);
      }
      if (!opts.passthrough) for (const k of Object.keys(o)) if (!(k in shape)) e.push(`${p}.${k}: campo desconhecido do portal (o backend passou a enviar? atualize types.ts e schemas.ts)`);
    },
  }),
};

export function validate<T>(schema: Sch<T>, value: unknown, root = "$"): string[] {
  const errs: string[] = [];
  schema.check(value, root, errs);
  return errs;
}

// ── schemas ───────────────────────────────────────────────────────────────────────────────────
const STATES = ["draft", "refining", "ready", "promoted", "in_factory", "delivered", "blocked", "rejected"] as const;
const state = s.literal(...STATES);
const kindS = s.literal("evolution", "fix", "feature");
const stage = s.literal("draft", "refining", "ready", "promoted", "in_factory", "delivered");

export const cardSummarySchema = s.object(cardSummaryShape());

const attachmentSchema = s.object({
  id: s.string, filename: s.string, mimeType: s.string, sizeBytes: s.number, downloadUrl: s.string,
  kind: s.optional(s.nullable(s.string)), origin: s.optional(s.nullable(s.string)), contentSha256: s.optional(s.nullable(s.string)),
  derivedFromAttachmentId: s.optional(s.nullable(s.string)),
});

export const cardDetailSchema = s.object({
  ...cardSummaryShape(),
  body: s.string,
  attachments: s.array(attachmentSchema),
  events: s.array(s.object({ from: s.nullable(state), to: state, actor: s.string, reason: s.nullable(s.string), childProjectId: s.nullable(s.string), at: s.date })),
  base: s.nullable(s.object({ headProjectId: s.nullable(s.string), headVersion: s.nullable(s.number), validatedAt: s.nullable(s.date) })),
  actions: s.object({
    edit: s.boolean, refine: s.boolean, ready: s.boolean, promote: s.boolean, revalidate: s.boolean, reopen: s.boolean, reject: s.boolean, resume: s.boolean, delete: s.boolean,
  }),
});
/** O detalhe e o `create` repetem os campos do resumo. */
function cardSummaryShape() {
  return {
    id: s.string, code: s.string, number: s.number, productId: s.string, projectId: s.nullable(s.string), kind: kindS, title: s.string,
    state, status: s.string, origin: s.string, externalRef: s.nullable(s.string), blockedReason: s.nullable(s.string),
    draftProjectId: s.nullable(s.string), childProjectId: s.nullable(s.string), executionStatus: s.nullable(s.string), executionTitle: s.nullable(s.string),
    prUrl: s.nullable(s.string), attachmentsCount: s.number, createdAt: s.date, updatedAt: s.date, promotedAt: s.nullable(s.date), deliveredAt: s.nullable(s.date),
  };
}

/** `POST /api/products/:id/cards` (201): resumo + `body`. */
export const cardCreatedSchema = s.object({ ...cardSummaryShape(), body: s.string });
export const cardListSchema = s.object({ items: s.array(cardSummarySchema), total: s.number, limit: s.number, offset: s.number });
export const capabilitiesSchema = s.object({ cardsBancada: s.boolean });

export const journeySchema = s.object({
  cardId: s.string, code: s.string, state: s.nullable(state), kind: kindS,
  phase: s.literal("editing", "ready", "running", "blocked", "delivered", "rejected"),
  steps: s.array(s.object({ key: stage, label: s.string, state: s.literal("done", "current", "todo", "blocked") })),
  current: s.nullable(stage), next: s.nullable(stage),
  blockers: s.array(s.object({ code: s.string, message: s.string, userMessage: s.nullable(s.string), details: s.optional(s.unknown) })),
  action: s.nullable(s.object({ key: s.string, label: s.string, method: s.nullable(s.literal("GET", "POST", "PUT")), path: s.nullable(s.string), enabled: s.boolean })),
  headline: s.string, detail: s.nullable(s.string), severity: s.literal("success", "info", "warning", "error"),
  blocked: s.nullable(s.object({ reason: s.nullable(s.string), kind: s.literal("budget", "child", "materialization", "other"), resumable: s.boolean })),
  spec: s.object({ locked: s.boolean, canReopen: s.boolean }),
  base: s.nullable(s.object({
    headProjectId: s.nullable(s.string), headVersion: s.nullable(s.number), currentHeadProjectId: s.nullable(s.string), currentHeadVersion: s.nullable(s.number), stale: s.boolean,
  })),
  execution: s.nullable(s.object({ childProjectId: s.string, status: s.string, title: s.nullable(s.string), prUrl: s.nullable(s.string) })),
});

export const baseSpecSchema = s.object({
  readOnly: s.literal(true), headProjectId: s.string, headVersion: s.number, title: s.string, specHash: s.nullable(s.string),
  baseHeadProjectId: s.nullable(s.string), stale: s.boolean,
  files: s.array(s.object({
    path: s.string, relDir: s.string, filename: s.string, isPrimary: s.boolean, sizeBytes: s.number, contentSha256: s.string,
    content: s.nullable(s.string), truncated: s.boolean,
  })),
});

export const attachmentsListSchema = s.object({
  items: s.array(s.object({
    id: s.string, filename: s.string, mimeType: s.string, sizeBytes: s.number, kind: s.nullable(s.string), origin: s.nullable(s.string),
    derivedFromAttachmentId: s.nullable(s.string), contentSha256: s.nullable(s.string), downloadUrl: s.string, createdAt: s.date,
    conversion: s.object({
      state: s.literal("not_applicable", "disabled", "queued", "pending", "running", "done", "empty", "failed"),
      attempts: s.number, errorCode: s.nullable(s.string), errorMessage: s.nullable(s.string), warnings: s.array(s.unknown),
      derivedAttachmentId: s.nullable(s.string), updatedAt: s.nullable(s.date),
    }),
  })),
  strict: s.boolean, conversionEnabled: s.boolean, summary: s.record(s.number),
});

export const actionResponseSchema = s.object({ ok: s.boolean, replayed: s.boolean, card: cardSummarySchema, message: s.optional(s.string) });
export const readyResponseSchema = s.object({
  ok: s.boolean, replayed: s.boolean, card: cardSummarySchema,
  gate: s.optional(s.object({ rfcs: s.number, scope: s.array(s.string), compat: s.string, kind: s.string })),
});
export const resumeResponseSchema = s.object({
  ok: s.boolean, replayed: s.optional(s.boolean), card: cardSummarySchema, childRestartRequired: s.optional(s.boolean), next: s.optional(s.string), message: s.optional(s.string),
});
export const revalidateSchema = s.object({
  ok: s.boolean, result: s.literal("ok", "stale", "conflict"),
  reasons: s.array(s.object({ code: s.string, severity: s.literal("conflict", "warning", "info"), message: s.string, details: s.optional(s.record(s.unknown)) })),
  rebased: s.boolean, reopened: s.boolean, card: cardSummarySchema,
  base: s.object({ headProjectId: s.string, headVersion: s.number, previousHeadProjectId: s.nullable(s.string) }),
  checks: s.object({ globs: s.array(s.unknown), repo: s.unknown, specDiff: s.unknown }),
  next: s.nullable(s.string), message: s.string,
});
export const promoteSchema = s.object({
  ok: s.boolean, childProjectId: s.string, versionNumber: s.number, cardId: s.string, cardState: state, cardStatus: s.string, draftProjectId: s.nullable(s.string),
  parentProjectId: s.optional(s.nullable(s.string)), title: s.optional(s.string), status: s.optional(s.string), message: s.optional(s.string),
  replayed: s.optional(s.boolean), resumed: s.optional(s.boolean),
  // só no 201 (vem do /evolve): informativos, o portal não depende deles.
  lineageRootId: s.optional(s.nullable(s.string)), workMode: s.optional(s.string), evolutionSource: s.optional(s.nullable(s.string)),
  evolutionSourceError: s.optional(s.nullable(s.string)), inheritedFiles: s.optional(s.nullable(s.number)),
});

// ── Erros: UM schema ESTRITO por código (Y-11) ───────────────────────────────────────────────────
// O corpo de erro deixou de ser `passthrough`: cada código declara TODOS os campos que o backend manda e que o portal lê
// (`details`, `writable`, `missing`, `freeUsd`, `services`, `errors`, `guardCode`, `expectedHead`…). Renomear ou tirar um campo no
// backend quebra a suíte; um campo novo também (atualize o schema e, se o portal passar a ler, `errorDetail`).
// `userMessage` é opcional só onde a rota não passa por `cardErrors.ts` (flag desligada, /evolve legado, rotas de spec).
const errBase = { message: s.string, userMessage: s.optional(s.string) };
const E = <S extends Shape>(code: string, extra?: S) => s.object({ code: s.literal(code), ...errBase, ...((extra ?? {}) as S) });
const rfcProblem = s.object({ path: s.string, problems: s.array(s.string) });

export const ERROR_SCHEMAS: Record<string, Sch<unknown>> = {
  BAD_REQUEST: E("BAD_REQUEST"),
  NOT_FOUND: E("NOT_FOUND"),
  BAD_PATH: E("BAD_PATH"),
  EXISTS: E("EXISTS"),
  NOT_EVOLUTION: E("NOT_EVOLUTION"),
  CONFLICT: E("CONFLICT", { currentSha: s.nullable(s.string) }),
  ATTACHMENTS_UNAVAILABLE: E("ATTACHMENTS_UNAVAILABLE"),
  ATTACHMENT_INVALID: E("ATTACHMENT_INVALID", { errors: s.array(s.object({ code: s.string, filename: s.string, message: s.string })) }),
  BUDGET_MISSING: E("BUDGET_MISSING", { projectId: s.string }),
  BUDGET_PAUSED: E("BUDGET_PAUSED"),
  BUDGET_FREE_BELOW_MIN: E("BUDGET_FREE_BELOW_MIN", { freeUsd: s.number, minFreeUsd: s.number }),
  CARD_BUDGET_BLOCKED: E("CARD_BUDGET_BLOCKED", { guardCode: s.string, cardState: s.string }),
  CARD_NOT_DELETABLE: E("CARD_NOT_DELETABLE", { state: s.string }),
  CARD_NOT_EDITABLE: E("CARD_NOT_EDITABLE", { state: s.string }),
  CARD_NOT_READY: E("CARD_NOT_READY", { state: s.string }),
  CARD_INVALID_TRANSITION: E("CARD_INVALID_TRANSITION", { from: s.string, to: s.string, allowed: s.optional(s.array(s.string)) }),
  CARD_SPEC_LOCKED: E("CARD_SPEC_LOCKED", { state: s.string, canReopen: s.boolean, cardId: s.string, reopen: s.optional(s.string) }),
  CARD_BASE_STALE: E("CARD_BASE_STALE", { expectedHead: s.string, currentHead: s.string, state: s.string, revalidate: s.string }),
  CARD_PATH_OUT_OF_SCOPE: E("CARD_PATH_OUT_OF_SCOPE", { path: s.string, writable: s.array(s.string) }),
  MATERIALIZATION_IN_PROGRESS: E("MATERIALIZATION_IN_PROGRESS", { childProjectId: s.string }),
  CARD_KIND_MISMATCH: E("CARD_KIND_MISMATCH", { details: s.object({ kind: s.string, compat: s.string, breaking: s.boolean, rfcs: s.array(s.string) }) }),
  CARD_KIND_REQUIREMENT: E("CARD_KIND_REQUIREMENT", { details: s.object({ kind: s.string, missing: s.array(s.string), rfcs: s.array(s.string) }) }),
  EVOLUTION_RFC_INVALID: E("EVOLUTION_RFC_INVALID", { details: s.array(rfcProblem) }),
  EVOLUTION_RFC_REQUIRED: E("EVOLUTION_RFC_REQUIRED", { details: s.object({ template_endpoint: s.string, rfc_dir: s.string }) }),
  USE_CARD_PROMOTE: E("USE_CARD_PROMOTE", { cardId: s.string }),
  // Códigos da correção L1/AC — schemas ESTRITOS gravados a partir das respostas reais (AB-04). Cada um tem fixture em `__contract__/`.
  USE_CARDS: E("USE_CARDS"),
  INVALID_ID: E("INVALID_ID"),
  USE_CARD_DELETE: E("USE_CARD_DELETE", { cardId: s.string, hint: s.string }),
  CARD_ACTION_NOT_ALLOWED: E("CARD_ACTION_NOT_ALLOWED"),
  CARD_SPEC_CHANGED: E("CARD_SPEC_CHANGED"),
  CARD_ATTACHMENT_CONVERSION_PENDING: E("CARD_ATTACHMENT_CONVERSION_PENDING", {
    pending: s.array(s.object({ id: s.string, filename: s.string, state: s.string })),
  }),
  // Duas formas, conforme a rota: escrita (`path`, um arquivo) e validar/promover (`paths`, o conjunto; `state` só na promoção).
  CARD_PATH_COLLIDES_WITH_BASE: s.oneOf(
    s.object({ code: s.literal("CARD_PATH_COLLIDES_WITH_BASE"), ...errBase, path: s.string }),
    s.object({ code: s.literal("CARD_PATH_COLLIDES_WITH_BASE"), ...errBase, paths: s.array(s.string), state: s.optional(s.string) }),
  ),
};

/** Corpo de erro genérico (só para tipar o que o cliente recebe): o contrato estrito é `errorSchemaFor(code)`. */
export const errorBodySchema = s.object({ code: s.string, message: s.string, userMessage: s.optional(s.string) }, { passthrough: true });
/** Schema estrito do corpo de erro pelo `code`; `null` = código sem schema (o teste de contrato falha e pede o cadastro). */
export function errorSchemaFor(code: unknown): Sch<unknown> | null {
  return typeof code === "string" ? ERROR_SCHEMAS[code] ?? null : null;
}

// ── Rotas de spec do rascunho (aba Especificação), chat e planner de RFC (Y-03) ─────────────────
export const specTreeSchema = s.object({
  projectId: s.string, status: s.string, editable: s.boolean, truncated: s.boolean, totalFiles: s.number,
  files: s.array(s.object({ path: s.string, ext: s.string, isPrimary: s.boolean, contentSha256: s.nullable(s.string), createdAt: s.nullable(s.date) })),
});
export const specFilesLegacySchema = s.array(s.object({
  id: s.string, filename: s.string, filePath: s.string, mimeType: s.string, relDir: s.nullable(s.string), isPrimary: s.boolean, contentSha256: s.nullable(s.string), createdAt: s.date,
}));
export const specFileGetSchema = s.object({ path: s.string, content: s.string, contentSha256: s.string, isPrimary: s.boolean, editable: s.boolean });
export const specFilePutSchema = s.object({ ok: s.boolean, path: s.string, contentSha256: s.string });
export const specFilePostSchema = s.object({ ok: s.boolean, path: s.string, contentSha256: s.string });
export const chatStartSchema = s.object({ jobId: s.string, status: s.literal("pending"), filePath: s.nullable(s.string), baseSha: s.nullable(s.string), deadlineAt: s.date });
export const chatJobSchema = s.object({
  jobId: s.string, status: s.literal("done", "error", "pending", "running"),
  specMarkdown: s.optional(s.nullable(s.string)), reply: s.optional(s.nullable(s.string)), error: s.optional(s.nullable(s.string)),
  filePath: s.optional(s.nullable(s.string)), baseSha: s.optional(s.nullable(s.string)), baseSpecSha: s.optional(s.nullable(s.string)), truncated: s.optional(s.boolean),
  elapsed: s.optional(s.number), deadlineAt: s.optional(s.nullable(s.date)),
});
export const planStartSchema = s.object({ jobId: s.string, status: s.literal("pending") });
export const planJobSchema = s.object({
  jobId: s.string, status: s.literal("pending", "running", "done", "error", "interrupted"),
  result: s.nullable(s.object({
    written: s.array(s.object({ path: s.string, action: s.literal("created", "updated", "skipped") })),
    rfcProblems: s.array(rfcProblem), warnings: s.array(s.string), compat: s.string, summary: s.string, questions: s.array(s.string),
  })),
  error: s.nullable(s.string), createdAt: s.date, finishedAt: s.nullable(s.date),
});
export const rfcFromTemplateSchema = s.object({ ok: s.boolean, path: s.string, number: s.number });

export type SpecTree = Out<typeof specTreeSchema>;
export type SpecFileGet = Out<typeof specFileGetSchema>;
export type SpecFileWrite = Out<typeof specFilePutSchema>;
export type ChatStart = Out<typeof chatStartSchema>;
export type ChatJob = Out<typeof chatJobSchema>;
export type PlanStart = Out<typeof planStartSchema>;
export type PlanJob = Out<typeof planJobSchema>;
export type RfcFromTemplate = Out<typeof rfcFromTemplateSchema>;

/** Schema de uma fixture de `__contract__/spec/` (pelo nome do arquivo e status). */
export function schemaForSpecFixture(name: string, status: number, body?: unknown): Sch<unknown> | null {
  if (name === "index") return null;
  if (status >= 400) return errorSchemaFor((body as { code?: unknown } | null)?.code) ?? errorBodySchemaMissing;
  if (name.startsWith("spec-tree.")) return specTreeSchema;
  if (name.startsWith("spec-files.")) return specFilesLegacySchema;
  if (name.startsWith("spec-file.get")) return specFileGetSchema;
  if (name.startsWith("spec-file.put")) return specFilePutSchema;
  if (name.startsWith("spec-file.post")) return specFilePostSchema;
  if (name === "spec-chat.post-202") return chatStartSchema;
  if (name.startsWith("spec-chat.get")) return chatJobSchema;
  if (name === "evolution-plan.post-202") return planStartSchema;
  if (name.startsWith("evolution-plan.get")) return planJobSchema;
  if (name.startsWith("rfc-from-template.")) return rfcFromTemplateSchema;
  throw new Error(`Fixture de spec sem schema: ${name}. Registre-a em schemaForSpecFixture().`);
}
const errorBodySchemaMissing: Sch<unknown> = { check: (_v, p, e) => { e.push(`${p}: código de erro sem schema estrito — cadastre em ERROR_SCHEMAS (schemas.ts)`); } };

// ── Amarração tipo × schema (compilação) ───────────────────────────────────────────────────────
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const mutual = <A, B>(ok: Mutual<A, B>): void => void ok;
mutual<Out<typeof cardSummarySchema>, CardSummary>(true);
mutual<Out<typeof cardListSchema>, CardListResponse>(true);
mutual<Out<typeof journeySchema>, CardJourney>(true);
mutual<Out<typeof baseSpecSchema>, BaseSpec>(true);
mutual<Out<typeof attachmentsListSchema>, CardAttachmentsResponse>(true);
mutual<Out<typeof actionResponseSchema>, CardActionResponse>(true);
mutual<Out<typeof readyResponseSchema>, ReadyResponse>(true);
mutual<Out<typeof resumeResponseSchema>, ResumeResponse>(true);
mutual<Out<typeof revalidateSchema>, RevalidateResponse>(true);
mutual<Out<typeof cardDetailSchema>, CardDetail>(true);
// `promote` tem campos informativos do /evolve a mais que o tipo de uso do portal: basta o tipo caber no payload.
const _promote: PromoteResponse = {} as Out<typeof promoteSchema>;
void _promote;

/** Qual schema vale para cada fixture (pelo nome do arquivo). `null` = sem corpo. */
export function schemaForFixture(name: string, status: number, body?: { code?: unknown } | null): Sch<unknown> | null {
  if (name === "error-codes" || name === "index") return null;
  if (status === 204) return null;
  if (status >= 400) return errorSchemaFor(body?.code) ?? errorBodySchemaMissing;
  if (name.startsWith("capabilities.")) return capabilitiesSchema;
  if (name.startsWith("detail.")) return cardDetailSchema;
  if (name.startsWith("journey.")) return journeySchema;
  if (name === "create.201") return cardCreatedSchema;
  if (name === "patch.200") return cardSummarySchema;
  if (name.startsWith("list.")) return cardListSchema;
  if (name.startsWith("attachments.")) return attachmentsListSchema;
  if (name.startsWith("base-spec.")) return baseSpecSchema;
  if (name.startsWith("revalidate.")) return revalidateSchema;
  if (name.startsWith("promote.")) return promoteSchema;
  if (name.startsWith("ready.")) return readyResponseSchema;
  if (name.startsWith("resume.")) return resumeResponseSchema;
  if (/^(refine|reject|reopen)\./.test(name)) return actionResponseSchema;
  throw new Error(`Fixture sem schema: ${name}. Registre-a em schemaForFixture().`);
}
