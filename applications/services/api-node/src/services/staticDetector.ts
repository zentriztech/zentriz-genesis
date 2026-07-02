/**
 * staticDetector.ts — FT-17
 *
 * Detecta se um projeto é elegível para deploy estático em S3.
 * Aplica 2 camadas:
 *   1. HARD-REJECT antes do build (via deps do package.json + estrutural).
 *      Backend real (Prisma, Express, FastAPI...) → reject imediato.
 *   2. Tipo do projeto (nextjs | vite | cra | html) para patch por tipo.
 *
 * Regra empírica final: se após patch + build o output for out/dist/build com
 * arquivos, é estático. Se falhar ou gerar server.js, rejeita (validado no builder).
 */
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { exec } from "node:child_process";

const execAsync = promisify(exec);

// Deps que exigem backend real — se qualquer uma estiver, reject.
const BACKEND_DEPS = new Set([
  // Databases / ORMs
  "pg", "pg-promise", "mysql2", "mysql", "mongodb", "mongoose",
  "prisma", "@prisma/client", "drizzle-orm", "sequelize", "typeorm",
  "redis", "ioredis", "@upstash/redis",
  // Servers
  "express", "fastify", "koa", "hapi", "hono", "@nestjs/core", "@nestjs/common",
  // Auth server-side (indica lógica de servidor)
  "passport", "jsonwebtoken", "bcrypt", "bcryptjs",
]);

// Deps que indicam mobile — não é web, reject.
const MOBILE_DEPS = new Set(["react-native", "expo", "@expo/cli", "@react-native-community/cli"]);

// Arquivos de linguagens não-JS que indicam backend.
const BACKEND_LANG_FILES = [
  "requirements.txt", "main.py", "pyproject.toml", "manage.py",
  "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "composer.json",
];

export type ProjectType = "nextjs" | "vite" | "cra" | "html" | "unknown";

export interface DetectionResult {
  eligible: boolean;
  type: ProjectType;
  reasons: string[];   // motivos de reject (se !eligible) ou warnings
  warnings: string[];  // ex: middleware.ts detectado (será renomeado no build)
  code?: string;       // ex: "BUILD_INCOMPATIBLE_BACKEND_DEPS"
  details?: Record<string, unknown>;
}

export async function detectStaticProject(appsDir: string): Promise<DetectionResult> {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const details: Record<string, unknown> = {};

  // Camada 1a: arquivos de linguagens não-JS
  for (const f of BACKEND_LANG_FILES) {
    try {
      await access(join(appsDir, f), fsConstants.F_OK);
      reasons.push(`Detectado ${f} — projeto usa runtime não-JS`);
      details.non_js_lang_file = f;
      return {
        eligible: false, type: "unknown", reasons, warnings, details,
        code: "BUILD_INCOMPATIBLE_NON_JS_LANG",
      };
    } catch { /* arquivo não existe → ok */ }
  }

  // Camada 1b: package.json → deps
  let pkgJson: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(join(appsDir, "package.json"), "utf-8");
    pkgJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Sem package.json — pode ser HTML puro
    try {
      await access(join(appsDir, "index.html"), fsConstants.F_OK);
      return { eligible: true, type: "html", reasons, warnings, details: { hint: "html-only" } };
    } catch {
      return {
        eligible: false, type: "unknown",
        reasons: ["Sem package.json e sem index.html — não é projeto web"],
        warnings, details, code: "BUILD_UNKNOWN_PROJECT_TYPE",
      };
    }
  }

  const deps: Record<string, string> = {
    ...(pkgJson.dependencies as Record<string, string> ?? {}),
    ...(pkgJson.devDependencies as Record<string, string> ?? {}),
  };
  const depNames = Object.keys(deps);

  // Mobile → reject
  const mobileFound = depNames.filter((d) => MOBILE_DEPS.has(d));
  if (mobileFound.length > 0) {
    reasons.push(`Dependências mobile detectadas: ${mobileFound.join(", ")}`);
    details.mobile_deps = mobileFound;
    return {
      eligible: false, type: "unknown", reasons, warnings, details,
      code: "BUILD_INCOMPATIBLE_MOBILE",
    };
  }

  // Backend deps → reject
  const backendFound = depNames.filter((d) => BACKEND_DEPS.has(d));
  if (backendFound.length > 0) {
    reasons.push(`Dependências de backend detectadas: ${backendFound.join(", ")}`);
    details.backend_deps = backendFound;
    return {
      eligible: false, type: "unknown", reasons, warnings, details,
      code: "BUILD_INCOMPATIBLE_BACKEND_DEPS",
    };
  }

  // Camada 2: detecta tipo
  const hasNext =
    "next" in deps ||
    (await fileExists(join(appsDir, "next.config.js"))) ||
    (await fileExists(join(appsDir, "next.config.mjs"))) ||
    (await fileExists(join(appsDir, "next.config.ts")));

  const hasVite =
    (await fileExists(join(appsDir, "vite.config.js"))) ||
    (await fileExists(join(appsDir, "vite.config.ts"))) ||
    (await fileExists(join(appsDir, "vite.config.mjs")));

  const hasCRA = "react-scripts" in deps;

  let type: ProjectType = "unknown";
  if (hasNext) type = "nextjs";
  else if (hasVite) type = "vite";
  else if (hasCRA) type = "cra";
  else {
    return {
      eligible: false, type, reasons: ["Não é Next.js, Vite nem CRA — tipo desconhecido"],
      warnings, details, code: "BUILD_UNKNOWN_PROJECT_TYPE",
    };
  }

  // Camada 2b: estrutural (só para Next.js)
  if (type === "nextjs") {
    // API routes → reject (não pode em output:export)
    const apiRoutes = await findApiRoutes(appsDir);
    if (apiRoutes.length > 0) {
      reasons.push(`API routes detectadas (incompatível com static export): ${apiRoutes.slice(0, 3).join(", ")}${apiRoutes.length > 3 ? "..." : ""}`);
      details.api_routes = apiRoutes;
      return {
        eligible: false, type, reasons, warnings, details,
        code: "BUILD_INCOMPATIBLE_API_ROUTES",
      };
    }

    // Server Actions → reject
    try {
      const { stdout } = await execAsync(
        `grep -rEl "^['\\"]use server['\\"]" ${appsDir}/src ${appsDir}/app ${appsDir}/pages 2>/dev/null || true`,
        { maxBuffer: 512 * 1024 },
      );
      const useServerFiles = stdout.trim().split("\n").filter(Boolean);
      if (useServerFiles.length > 0) {
        reasons.push(`Server Actions detectadas em: ${useServerFiles.slice(0, 3).join(", ")}`);
        details.use_server_files = useServerFiles;
        return {
          eligible: false, type, reasons, warnings, details,
          code: "BUILD_INCOMPATIBLE_SERVER_ACTIONS",
        };
      }
    } catch { /* grep falhou (dirs inexistentes) — segue */ }

    // Middleware.ts → warning (será renomeado antes do build no builder)
    const midPaths = [
      join(appsDir, "middleware.ts"),
      join(appsDir, "middleware.js"),
      join(appsDir, "src", "middleware.ts"),
      join(appsDir, "src", "middleware.js"),
    ];
    for (const mp of midPaths) {
      if (await fileExists(mp)) {
        warnings.push(`middleware detectado (${mp}) — será temporariamente desabilitado durante build estático`);
        details.middleware_path = mp;
        break;
      }
    }

    // Rotas dinâmicas sem generateStaticParams → warning (build pode falhar)
    const dynamicRoutes = await findDynamicRoutesWithoutParams(appsDir);
    if (dynamicRoutes.length > 0) {
      warnings.push(
        `${dynamicRoutes.length} rota(s) dinâmica(s) sem generateStaticParams — build pode falhar. Adicione generateStaticParams com IDs conhecidos.`,
      );
      details.dynamic_routes_missing_params = dynamicRoutes;
    }
  }

  return { eligible: true, type, reasons, warnings, details };
}

// ─── helpers ──────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findApiRoutes(appsDir: string): Promise<string[]> {
  const roots = [
    join(appsDir, "app", "api"),
    join(appsDir, "src", "app", "api"),
    join(appsDir, "pages", "api"),
    join(appsDir, "src", "pages", "api"),
  ];
  const found: string[] = [];
  for (const root of roots) {
    if (!(await fileExists(root))) continue;
    try {
      const { stdout } = await execAsync(
        `find "${root}" -type f \\( -name 'route.ts' -o -name 'route.js' -o -name 'route.tsx' -o -name '*.ts' -o -name '*.js' \\) 2>/dev/null || true`,
        { maxBuffer: 512 * 1024 },
      );
      found.push(...stdout.trim().split("\n").filter(Boolean));
    } catch { /* segue */ }
  }
  return found;
}

async function findDynamicRoutesWithoutParams(appsDir: string): Promise<string[]> {
  // Procura pastas [param] em app/ e verifica se page.tsx tem generateStaticParams
  const missing: string[] = [];
  const roots = [join(appsDir, "app"), join(appsDir, "src", "app")];
  for (const root of roots) {
    if (!(await fileExists(root))) continue;
    try {
      // Encontra diretórios com nome [algo]
      const { stdout } = await execAsync(
        `find "${root}" -type d -name '\\[*\\]' 2>/dev/null || true`,
        { maxBuffer: 512 * 1024 },
      );
      const dynDirs = stdout.trim().split("\n").filter(Boolean);
      for (const dir of dynDirs) {
        for (const ext of ["page.tsx", "page.ts", "page.jsx", "page.js"]) {
          const pagePath = join(dir, ext);
          if (!(await fileExists(pagePath))) continue;
          const content = await readFile(pagePath, "utf-8");
          if (!/generateStaticParams/.test(content)) {
            missing.push(dir.replace(appsDir + "/", ""));
          }
        }
      }
    } catch { /* segue */ }
  }
  return missing;
}
