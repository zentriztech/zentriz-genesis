import { buildApp } from "./app.js";
import { initDb } from "./db/init.js";
import { seedIfEmpty } from "./db/seed.js";

const app = await buildApp();

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await initDb();
  await seedIfEmpty();
  await app.listen({ port, host });
  console.log(`API listening on ${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
