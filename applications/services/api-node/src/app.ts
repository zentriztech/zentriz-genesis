import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import { voucherRoutes } from "./routes/vouchers.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { specRoutes } from "./routes/specs.js";
import { specChatRoutes } from "./routes/specChat.js";
import { catalogRoutes } from "./routes/catalog.js";
import { tenantRoutes } from "./routes/tenants.js";
import { userRoutes } from "./routes/users.js";
import { signupRoutes } from "./routes/signup.js";
import { dialogueRoutes } from "./routes/dialogue.js";
import { pipelineRoutes } from "./routes/pipeline.js";
import { notificationRoutes } from "./routes/notifications.js";
import { planRoutes } from "./routes/plans.js";
import { githubRoutes } from "./routes/github.js";
import { cloudRoutes } from "./routes/cloud.js";
import { llmRoutes } from "./routes/llm.js";
import { productRoutes } from "./routes/products.js";
import { internalLlmRoutes } from "./routes/internalLlm.js";
import { telegramRoutes } from "./routes/telegram.js";
import { runtimeConfigRoutes } from "./routes/runtimeConfig.js";
import { skillsRoutes } from "./routes/skills.js";
import { reportsRoutes } from "./routes/reports.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { deadpoolRoutes } from "./routes/deadpool.js";
import { deadpoolApprovalsRoutes } from "./routes/deadpoolApprovals.js";
import { learningRoutes } from "./routes/learning.js";
import { readFileSync } from "node:fs";

// Versão da aplicação — fonte única é o package.json (record de release). Resolvido relativo ao
// módulo, funciona tanto rodando de src/ (dev) quanto de dist/ (imagem: package.json em /app).
const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

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
    return reply.send({ status: "ok", version: APP_VERSION, timestamp: new Date().toISOString() });
  });
  app.get("/api/health", async (_request, reply) => {
    return reply.send({ status: "ok", version: APP_VERSION, timestamp: new Date().toISOString() });
  });

  await app.register(voucherRoutes);
  await app.register(authRoutes);
  await app.register(signupRoutes);
  await app.register(projectRoutes);
  await app.register(specRoutes);
  await app.register(specChatRoutes);
  await app.register(catalogRoutes);
  await app.register(tenantRoutes);
  await app.register(userRoutes);
  await app.register(dialogueRoutes);
  await app.register(pipelineRoutes);
  await app.register(notificationRoutes);
  await app.register(planRoutes);
  await app.register(githubRoutes);
  await app.register(cloudRoutes);
  await app.register(llmRoutes);
  await app.register(productRoutes);
  await app.register(internalLlmRoutes);
  await app.register(telegramRoutes);
  await app.register(runtimeConfigRoutes);
  await app.register(skillsRoutes);
  await app.register(reportsRoutes);
  await app.register(deploymentRoutes);
  await app.register(deadpoolRoutes);
  await app.register(deadpoolApprovalsRoutes);
  await app.register(learningRoutes);

  return app;
}
