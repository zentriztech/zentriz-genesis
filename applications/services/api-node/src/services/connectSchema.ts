/**
 * connectSchema.ts — validação MÍNIMA (sem dependência) do ProductManifest / SpecConnectDeclaration
 * contra os schemas Connect VENDORIZADOS em src/config/connect/v<versão>/ (snapshot congelado do
 * zentriz-connect; o container da API não vê o repositório irmão).
 *
 * R4 PR5: modo WARNING por uma release — `parseManifest` (hand-rolled) continua sendo o gate; este
 * módulo só produz avisos (o splitter já emite `archetype/stack/deployTarget` que até a 1.3.0 eram
 * ilegais no schema — validar estrito quebraria propostas antigas em product_proposals.payload).
 * Suporta: type (string ou lista), enum, pattern, required, additionalProperties:false, properties,
 * items/minItems, $ref local (#/$defs/x). Espelho do validador Python em connect_contracts.py.
 * `ajv` existe só como dependência transitiva 6.x (draft-07) — não serve para 2020-12.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const VENDORED_CONNECT_VERSION = "1.3.0";

type Schema = Record<string, unknown> & { [k: string]: unknown };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dev: src/services → src/config ; prod (dist): dist/services → dist/config (Dockerfile copia src/config → dist/config)
const CONFIG_DIR = path.resolve(__dirname, "..", "config", "connect", `v${VENDORED_CONNECT_VERSION}`);

const _cache = new Map<string, Schema | null>();

export function loadVendoredSchema(name: "product-manifest" | "spec-connect-declaration"): Schema | null {
  if (_cache.has(name)) return _cache.get(name)!;
  let schema: Schema | null = null;
  try {
    schema = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${name}.schema.json`), "utf-8")) as Schema;
  } catch (e) {
    // Aviso ÚNICO (o cache evita repetição): sem isto "schema ausente" seria indistinguível de "válido".
    console.warn(`[connect-schema] schema vendorizado indisponível (${name}@${VENDORED_CONNECT_VERSION}) em ${CONFIG_DIR}: ${e instanceof Error ? e.message : e} — validação do manifesto DESLIGADA.`);
    schema = null;
  }
  _cache.set(name, schema);
  return schema;
}

function typeOk(value: unknown, t: string): boolean {
  switch (t) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "null": return value === null;
    default: return true;
  }
}

function resolveRef(ref: unknown, root: Schema): Schema | null {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!node || typeof node !== "object" || !(part in (node as Record<string, unknown>))) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return node && typeof node === "object" ? (node as Schema) : null;
}

export function validateAgainst(payload: unknown, schema: Schema, prefix = "$", root?: Schema): string[] {
  const r = root ?? schema;
  if (schema.$ref !== undefined) {
    const target = resolveRef(schema.$ref, r);
    if (!target) return [];
    const { $ref: _drop, ...rest } = schema;
    schema = { ...rest, ...target };
  }
  const errors: string[] = [];
  let t = schema.type as string | string[] | undefined;
  if (Array.isArray(t)) {
    if (payload === null && t.includes("null")) return errors;
    const match = t.find((x) => x !== "null" && typeOk(payload, x));
    if (!match) { errors.push(`${prefix}: esperado ${t.join("|")}`); return errors; }
    t = match;
  } else if (t && !typeOk(payload, t)) {
    errors.push(`${prefix}: esperado ${t}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(payload)) {
    errors.push(`${prefix}: valor ${JSON.stringify(payload)} fora do enum`);
  }
  if (typeof schema.pattern === "string" && typeof payload === "string") {
    try { if (!new RegExp(schema.pattern).test(payload)) errors.push(`${prefix}: não casa com o padrão ${schema.pattern}`); } catch { /* padrão inválido: ignorar */ }
  }
  if (t === "object" && payload && typeof payload === "object") {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    const obj = payload as Record<string, unknown>;
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!(k in props)) errors.push(`${prefix}.${k}: propriedade não permitida`);
    }
    for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in obj)) errors.push(`${prefix}.${k}: campo obrigatório ausente`);
    for (const [k, v] of Object.entries(obj)) if (k in props) errors.push(...validateAgainst(v, props[k], `${prefix}.${k}`, r));
  }
  if (t === "array" && Array.isArray(payload)) {
    if (typeof schema.minItems === "number" && payload.length < schema.minItems) errors.push(`${prefix}: mínimo ${schema.minItems} item(ns)`);
    if (schema.items && typeof schema.items === "object") payload.forEach((it, i) => errors.push(...validateAgainst(it, schema.items as Schema, `${prefix}[${i}]`, r)));
  }
  return errors;
}

/** Avisos (não erros) do manifesto contra o schema vendorizado. [] quando válido OU schema indisponível. */
export function productManifestWarnings(manifest: unknown): string[] {
  const schema = loadVendoredSchema("product-manifest");
  if (!schema) return [];
  return validateAgainst(manifest, schema).map((e) => `[connect-schema product-manifest@${VENDORED_CONNECT_VERSION}] ${e}`);
}
