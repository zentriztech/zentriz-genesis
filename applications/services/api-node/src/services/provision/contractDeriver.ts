/**
 * contractDeriver.ts — G1-T8 (Fase B).
 *
 * Deriva o CONTRATO (OpenAPI) do código gerado — NUNCA escrito à mão. A fonte de
 * verdade das rotas muda por framework (contractSource, definido no runtimeDetector):
 *
 * - fastify_scan  : scan ESTÁTICO das rotas (app.route/app.get/... + prefixos de
 *                   register) no código-fonte. NÃO exige @fastify/swagger — senão o
 *                   próprio MVP travaria (a maioria dos backends Genesis é Fastify
 *                   sem swagger garantido).
 * - express_scan  : scan estático de app.METHOD/router.METHOD.
 * - fastapi_openapi / nest_swagger : introspection VIVA pós-deploy (a app expõe
 *                   /openapi.json ou /api-json). No build-time só marcamos que a
 *                   derivação é "deferred" para a URL; a coleta real acontece no
 *                   smoke pós-provisão (G1-T29).
 *
 * Retorna sempre um objeto OpenAPI 3.1 mínimo válido (info+paths). CONTRACT_DERIVATION_FAILED
 * só é sinalizado para serviços 'api' cujo contractSource está definido mas nenhuma
 * rota foi encontrada — nunca para web/worker (ver serviceRole).
 */

import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import type { DetectedService, ContractSource } from "./runtimeDetector.js";

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  "x-genesis"?: { derivedFrom: string; deferred?: boolean; routeCount: number };
}

export interface ContractResult {
  ok: boolean;
  openapi: OpenApiDoc | null;
  deferred: boolean;        // true = coleta real pós-deploy (introspection viva)
  routeCount: number;
  code?: "CONTRACT_DERIVATION_FAILED";
  reason?: string;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".git", "coverage", "__pycache__"]);
const MAX_FILE_BYTES = 500_000;

async function collectSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name));
      } else if (CODE_EXTS.has(path.extname(e.name))) {
        const full = path.join(dir, e.name);
        try { if ((await stat(full)).size <= MAX_FILE_BYTES) out.push(full); } catch { /* skip */ }
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Scan estático de rotas para Fastify/Express. Casa padrões:
 *   app.get('/x'), fastify.post('/y'), router.put("/z"), app.route({ method, url })
 * É best-effort (não executa o código) — suficiente p/ um contrato base verificável.
 */
async function scanRoutes(root: string): Promise<Array<{ method: string; route: string }>> {
  const files = await collectSourceFiles(root);
  const found = new Map<string, { method: string; route: string }>();
  // app.get('/path'  |  router.post("/path"  |  .delete(`/path`
  const methodCall = new RegExp(
    `\\.(?:${HTTP_METHODS.join("|")})\\s*\\(\\s*[\`'"]([^\`'"]+)[\`'"]`,
    "gi",
  );
  // app.route({ ... method: 'GET' ... url: '/path' ... })
  const routeObj = /\.route\s*\(\s*\{[\s\S]*?\}/gi;
  for (const f of files) {
    let txt: string;
    try { txt = await readFile(f, "utf-8"); } catch { continue; }
    let m: RegExpExecArray | null;
    methodCall.lastIndex = 0;
    while ((m = methodCall.exec(txt)) !== null) {
      const full = m[0];
      const method = (full.match(new RegExp(`\\.(${HTTP_METHODS.join("|")})`, "i")) ?? [])[1]?.toLowerCase();
      const route = m[1];
      if (method && route.startsWith("/")) found.set(`${method} ${route}`, { method, route });
    }
    routeObj.lastIndex = 0;
    while ((m = routeObj.exec(txt)) !== null) {
      const block = m[0];
      const url = (block.match(/url\s*:\s*[`'"]([^`'"]+)[`'"]/) ?? [])[1];
      const method = (block.match(/method\s*:\s*[`'"]([^`'"]+)[`'"]/) ?? [])[1]?.toLowerCase();
      if (url && method && url.startsWith("/")) found.set(`${method} ${url}`, { method, route: url });
    }
  }
  return [...found.values()];
}

function emptyDoc(title: string, derivedFrom: string, deferred: boolean, routeCount: number): OpenApiDoc {
  return {
    openapi: "3.1.0",
    info: { title, version: "1.0.0" },
    paths: {},
    "x-genesis": { derivedFrom, deferred, routeCount },
  };
}

/**
 * Deriva o contrato de UM serviço a partir do seu contractSource.
 * @param title  nome do serviço/produto (info.title do OpenAPI)
 */
export async function deriveContract(svc: DetectedService, title = "genesis-service"): Promise<ContractResult> {
  const src: ContractSource = svc.contractSource;

  // Introspection viva (FastAPI/Nest): coleta real é pós-deploy (G1-T29). Base deferred.
  if (src.kind === "fastapi_openapi" || src.kind === "nest_swagger") {
    const doc = emptyDoc(title, src.kind, true, 0);
    return { ok: true, openapi: doc, deferred: true, routeCount: 0 };
  }

  // Scan estático (Fastify/Express).
  if (src.kind === "fastify_scan" || src.kind === "express_scan") {
    const routes = await scanRoutes(svc.dir);
    const doc = emptyDoc(title, src.kind, false, routes.length);
    for (const { method, route } of routes) {
      if (!doc.paths[route]) doc.paths[route] = {};
      doc.paths[route][method] = {
        summary: `${method.toUpperCase()} ${route}`,
        responses: { "200": { description: "OK" } },
      };
    }
    // health padrão sempre presente no contrato (garantido pelo required_routes do tipo).
    if (!doc.paths[svc.healthPath]) {
      doc.paths[svc.healthPath] = { get: { summary: "health", responses: { "200": { description: "OK" } } } };
    }
    if (routes.length === 0) {
      // 'api' sem NENHUMA rota detectada = falha de derivação (não deve virar contrato vazio silencioso).
      return {
        ok: false, openapi: doc, deferred: false, routeCount: 0,
        code: "CONTRACT_DERIVATION_FAILED",
        reason: `Nenhuma rota encontrada no scan ${src.kind} em ${svc.dir}`,
      };
    }
    return { ok: true, openapi: doc, deferred: false, routeCount: routes.length };
  }

  // contractSource 'none' (worker/unknown) — sem contrato, mas não é falha.
  return { ok: true, openapi: null, deferred: false, routeCount: 0 };
}
