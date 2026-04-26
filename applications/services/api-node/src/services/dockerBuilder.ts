/**
 * dockerBuilder.ts — Packages a generated project's apps/ directory as a Docker image.
 *
 * Detection order:
 *   1. If apps/Dockerfile exists — use it as-is
 *   2. Detect stack from apps/package.json and inject appropriate Dockerfile
 *   3. Build with docker buildx + push to Fly registry
 *
 * Requires: docker CLI available in PATH (api-node container needs Docker socket mounted)
 */

import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, access } from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

const PROJECT_FILES_ROOT = (process.env.PROJECT_FILES_ROOT ?? "/shared/uploads").trim();

// ── Dockerfile templates ───────────────────────────────────────────────────────

const DOCKERFILE_NESTJS = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json pnpm-lock.yaml* yarn.lock* ./
RUN npm install --frozen-lockfile 2>/dev/null || npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
CMD ["node", "dist/main"]
`;

const DOCKERFILE_EXPRESS = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build 2>/dev/null || true

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
RUN npm prune --production 2>/dev/null || true
EXPOSE 3000
CMD ["npm", "start"]
`;

const DOCKERFILE_NEXTJS_STATIC = `FROM nginx:alpine
COPY out/ /usr/share/nginx/html/
EXPOSE 80
`;

const DOCKERFILE_NEXTJS_SSR = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
`;

// ── Stack detection ────────────────────────────────────────────────────────────

type StackType = "nestjs" | "express" | "nextjs-static" | "nextjs-ssr" | "unknown";

async function detectStack(appsDir: string): Promise<StackType> {
  try {
    const pkgRaw = await readFile(path.join(appsDir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["@nestjs/core"]) return "nestjs";
    if (deps["next"]) {
      // Check next.config for output: 'export'
      try {
        const cfg = await readFile(path.join(appsDir, "next.config.mjs"), "utf-8");
        if (cfg.includes("output") && cfg.includes("export")) return "nextjs-static";
      } catch { /* */ }
      try {
        const cfg = await readFile(path.join(appsDir, "next.config.js"), "utf-8");
        if (cfg.includes("output") && cfg.includes("export")) return "nextjs-static";
      } catch { /* */ }
      return "nextjs-ssr";
    }
    if (deps["express"] || deps["fastify"]) return "express";
  } catch { /* */ }
  return "unknown";
}

function getDockerfileContent(stack: StackType): string {
  switch (stack) {
    case "nestjs":         return DOCKERFILE_NESTJS;
    case "express":        return DOCKERFILE_EXPRESS;
    case "nextjs-static":  return DOCKERFILE_NEXTJS_STATIC;
    case "nextjs-ssr":     return DOCKERFILE_NEXTJS_SSR;
    default:               return DOCKERFILE_EXPRESS;
  }
}

export function getContainerPort(stack: StackType): number {
  return stack === "nextjs-static" ? 80 : 3000;
}

// ── Main build function ────────────────────────────────────────────────────────

export interface BuildResult {
  imageTag: string;
  stack: StackType;
  port: number;
}

export async function buildAndPushImage(
  projectId: string,
  flyAppName: string,
): Promise<BuildResult> {
  const appsDir = path.join(PROJECT_FILES_ROOT, projectId, "apps");

  // Ensure apps/ exists
  try { await access(appsDir); } catch {
    throw new Error(`apps/ directory not found for project ${projectId}`);
  }

  const stack = await detectStack(appsDir);
  const imageTag = `registry.fly.io/${flyAppName}:latest`;
  const dockerfilePath = path.join(appsDir, "Dockerfile");

  // Inject Dockerfile if not present
  let dockerfileExists = false;
  try { await access(dockerfilePath); dockerfileExists = true; } catch { /* */ }

  if (!dockerfileExists) {
    await writeFile(dockerfilePath, getDockerfileContent(stack), "utf-8");
  }

  // Build
  const { stderr: buildStderr } = await execAsync(
    `docker buildx build --platform linux/amd64 --tag "${imageTag}" "${appsDir}"`,
    { timeout: 300_000 }, // 5 min max build
  );
  if (buildStderr && buildStderr.includes("ERROR")) {
    throw new Error(`Docker build failed: ${buildStderr.slice(0, 500)}`);
  }

  // Push to Fly registry (requires flyctl auth + fly registry login)
  await execAsync(`docker push "${imageTag}"`, { timeout: 120_000 });

  return { imageTag, stack, port: getContainerPort(stack) };
}
