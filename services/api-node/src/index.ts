import Fastify from "fastify";
import { voucherRoutes } from "./routes/vouchers.js";

const app = Fastify({ logger: true });

app.addHook("onRequest", (request, _reply, done) => {
  const requestId = (request.headers["x-request-id"] as string) ?? crypto.randomUUID();
  (request as unknown as { requestId: string }).requestId = requestId;
  done();
});

app.get("/health", async (_request, reply) => {
  return reply.send({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/health", async (_request, reply) => {
  return reply.send({ status: "ok", timestamp: new Date().toISOString() });
});

await app.register(voucherRoutes);

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
  console.log(`API listening on ${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
