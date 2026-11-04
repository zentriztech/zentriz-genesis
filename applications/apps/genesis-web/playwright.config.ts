import { defineConfig } from "@playwright/test";

// E2E headless do portal (plano EVOLUIR-PROJETO 0.6). Sobe `next start` sobre o build existente
// (rode `npm run build` antes) e NUNCA fala com API real: os testes interceptam `/api/**`.
//
// Chromium: por padrão usa o que `npx playwright install chromium` instalou (CI). Localmente, sem
// rede/instalação, aponte para um existente com CHROMIUM_PATH=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
const PORT = Number(process.env.E2E_PORT ?? 3111);
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    launchOptions: { executablePath, args: ["--no-sandbox"] },
  },
  webServer: {
    command: `npx next start -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { NEXT_INTERNAL_API_URL: "http://127.0.0.1:9", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
