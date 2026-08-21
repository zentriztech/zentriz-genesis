import { describe, it, expect } from "vitest";
import {
  rgbaToHex,
  summarizeFigmaFile,
  renderUiuxSpecMarkdown,
  type FigmaFileExtract,
} from "./uiuxExtract.js";

// Documento Figma sintético: 1 página, 1 frame (Login), com um texto e um botão (componente).
const FIXTURE: FigmaFileExtract = {
  fileKey: "ABC123",
  fileName: "Design System",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:0",
        name: "Página Principal",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Login",
            type: "FRAME",
            layoutMode: "VERTICAL",
            absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
            children: [
              {
                id: "1:2",
                name: "Título",
                type: "TEXT",
                characters: "Bem-vindo de volta",
                absoluteBoundingBox: { x: 24, y: 80, width: 200, height: 32 },
                style: { fontFamily: "Inter", fontSize: 24, fontWeight: 700 },
                fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.1, b: 0.1 } }],
              },
              {
                id: "1:3",
                name: "BotãoPrimário",
                type: "COMPONENT",
                absoluteBoundingBox: { x: 24, y: 700, width: 327, height: 48 },
                fills: [{ type: "SOLID", visible: true, color: { r: 0.39, g: 0.4, b: 0.95 } }],
                children: [],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("rgbaToHex", () => {
  it("converte canais 0..1 para hex maiúsculo", () => {
    expect(rgbaToHex({ r: 1, g: 1, b: 1 })).toBe("#FFFFFF");
    expect(rgbaToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
    expect(rgbaToHex({ r: 0.39, g: 0.4, b: 0.95 })).toBe("#6366F2");
  });
  it("retorna undefined p/ cor ausente/inválida", () => {
    expect(rgbaToHex(undefined)).toBeUndefined();
    expect(rgbaToHex(null)).toBeUndefined();
    expect(rgbaToHex({ r: 1 } as never)).toBeUndefined();
  });
});

describe("summarizeFigmaFile", () => {
  const summary = summarizeFigmaFile(FIXTURE);

  it("detecta a página e o frame de topo (macro)", () => {
    expect(summary.pages).toHaveLength(1);
    expect(summary.pages[0].name).toBe("Página Principal");
    expect(summary.pages[0].frames).toHaveLength(1);
    const frame = summary.pages[0].frames[0];
    expect(frame.name).toBe("Login");
    expect(frame.width).toBe(375);
    expect(frame.height).toBe(812);
    expect(frame.layout).toContain("auto");
  });

  it("extrai elementos micro com texto, tipografia e cor", () => {
    const text = summary.micro.find((m) => m.type === "TEXT");
    expect(text?.text).toBe("Bem-vindo de volta");
    expect(text?.font).toBe("Inter 24px w700");
    expect(text?.color).toBe("#1A1A1A");
  });

  it("conta componentes e tokens", () => {
    expect(summary.componentCounts["BotãoPrimário"]).toBe(1);
    expect(summary.colorCounts["#6366F2"]).toBe(1);
    expect(summary.typographyCounts["Inter 24px w700"]).toBe(1);
  });
});

describe("renderUiuxSpecMarkdown", () => {
  const md = renderUiuxSpecMarkdown("figma", "Minha Conta Figma", [summarizeFigmaFile(FIXTURE)]);

  it("produz seções macro, micro, inventário e tokens", () => {
    expect(md).toContain("# Especificação UI/UX — Minha Conta Figma");
    expect(md).toContain("## 1. Visão Macro");
    expect(md).toContain("## 2. Visão Micro");
    expect(md).toContain("## 3. Inventário de componentes");
    expect(md).toContain("## 4. Design tokens detectados");
    expect(md).toContain("Login");
    expect(md).toContain("Bem-vindo de volta");
    expect(md).toContain("#6366F2");
  });
});
