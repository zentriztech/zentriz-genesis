import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import { voucherRoutes } from "./routes/vouchers.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { specRoutes } from "./routes/specs.js";
import { tenantRoutes } from "./routes/tenants.js";
import { userRoutes } from "./routes/users.js";
import { signupRoutes } from "./routes/signup.js";
import { dialogueRoutes } from "./routes/dialogue.js";
import { pipelineRoutes } from "./routes/pipeline.js";

export async function buildApp(opts?: { logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts?.logger ?? true });

  app.addHook("onRequest", (request, _reply, done) => {
    const requestId = (request.headers["x-request-id"] as string) ?? crypto.randomUUID();
    (request as unknown as { requestId: string }).requestId = requestId;
    done();
  });

  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  });
  // Garante que preflight OPTIONS retorne 204 (evita 404 no portal cross-origin)
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
  await app.register(fastifyMultipart, {
    limits: { files: 10, fileSize: 10 * 1024 * 1024 },
  });

  app.get("/health", async (_request, reply) => {
    return reply.send({ status: "ok", timestamp: new Date().toISOString() });
  });
  app.get("/api/health", async (_request, reply) => {
    return reply.send({ status: "ok", timestamp: new Date().toISOString() });
  });

  await app.register(voucherRoutes);
  await app.register(authRoutes);
  await app.register(signupRoutes);
  await app.register(projectRoutes);
  await app.register(specRoutes);
  await app.register(tenantRoutes);
  await app.register(userRoutes);
  await app.register(dialogueRoutes);
  await app.register(pipelineRoutes);

  return app;
}
