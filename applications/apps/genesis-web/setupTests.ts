import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Com `globals: true` o cleanup automático do RTL já existe, mas ser explícito evita surpresa
// se alguém desligar `globals`.
afterEach(() => {
  cleanup();
});
