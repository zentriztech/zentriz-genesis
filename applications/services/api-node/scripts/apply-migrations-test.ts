/**
 * Aplica TODAS as migrations do api-node num Postgres de teste usando o MESMO runner do produto
 * (initDb em src/db/init.ts: split ingênuo por ";" e remoção de linhas "--").
 * Uso: DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npx tsx scripts/apply-migrations-test.ts
 * Recusa rodar sem DATABASE_URL apontando para localhost:55432 (evita tocar dev/produção).
 */
const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1):(55432|55440|55441)\//.test(url)) {
  console.error("Recusado: DATABASE_URL deve apontar para o Postgres efêmero em localhost:55432, 55440 ou 55441");
  process.exit(2);
}
const { initDb } = await import("../src/db/init.js");
const { pool } = await import("../src/db/client.js");
try {
  await initDb();
} finally {
  await pool.end();
}
