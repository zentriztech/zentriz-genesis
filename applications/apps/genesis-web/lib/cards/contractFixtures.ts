// Leitor das fixtures REAIS do backend (`__contract__/*.json`, geradas por `npm run contract:gen` no api-node). SÓ para testes
// (Vitest e Playwright): usa `node:fs` e nunca entra no bundle do app.
import fs from "node:fs";
import path from "node:path";

export const CONTRACT_DIR = path.join(process.cwd().endsWith("genesis-web") ? process.cwd() : path.join(process.cwd(), "applications/apps/genesis-web"), "lib/cards/__contract__");

export interface Fixture<T = unknown> { request: string; status: number; headers?: Record<string, string>; body: T }

export function fixtureNames(): string[] {
  return fs.readdirSync(CONTRACT_DIR).filter((f) => f.endsWith(".json") && f !== "index.json" && f !== "error-codes.json").map((f) => f.replace(/\.json$/, "")).sort();
}

/** Fixture completa (status + cabeçalhos + corpo), copiada: o teste pode alterar à vontade. */
export function fixture<T = unknown>(name: string): Fixture<T> {
  const file = path.join(CONTRACT_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Fixture ausente: ${name}. Rode \`npm run contract:gen\` no api-node.`);
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Fixture<T>;
}

/** Só o corpo da fixture. */
export const body = <T = unknown>(name: string): T => fixture<T>(name).body;
