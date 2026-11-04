import { defineConfig } from "@playwright/test";

// E2E REAL dos cards (Y-15): portal buildado (`next start`) + api-node REAL do worktree (Postgres efêmero na 55441, LLM stub).
// Pré-requisitos: `npm run build` e o Postgres 55441 já migrado (ver applications/services/api-node/scripts/e2e-real/serve.ts).
// Chromium: CHROMIUM_PATH=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
const PORT = Number(process.env.E2E_PORT ?? 3112);
const executablePath = process.env.CHROMIUM_PATH || undefined;
const DB = process.env.E2E_DATABASE_URL ?? "postgres://postgres:test@localhost:55441/postgres";

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true, launchOptions: { executablePath, args: ["--no-sandbox"] } },
  webServer: [
    {
      command: "npx tsx scripts/e2e-real/serve.ts",
      cwd: "../../services/api-node",
      url: "http://127.0.0.1:3461/health",
      reuseExistingServer: false,
      timeout: 90_000,
      env: { DATABASE_URL: DB, NODE_ENV: "test" },
    },
    {
      command: `npx next start -H 127.0.0.1 -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
});
