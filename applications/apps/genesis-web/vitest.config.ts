import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Infra mínima de teste do portal (plano EVOLUIR-PROJETO 0.6): Vitest + React Testing Library + jsdom.
// O alias `@/` espelha o `paths` do tsconfig.json. Testes E2E (Playwright) vivem em `e2e/` e NÃO
// são coletados aqui (rodam por `npm run test:e2e`).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./setupTests.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
  },
});
