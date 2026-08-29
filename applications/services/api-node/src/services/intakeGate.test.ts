import { describe, it, expect } from "vitest";
import { validateIntake, resolveIntakeMode, MIN_FREE_TEXT_CHARS } from "./intakeGate.js";

// Texto real com >= 500 letras (descrição de produto plausível).
const LONG_TEXT = (
  "Plataforma de gestão de frota para uma transportadora regional dos Açores. " +
  "O sistema deve permitir cadastrar veículos, motoristas e rotas, registrar abastecimentos " +
  "e manutenções, e emitir alertas de manutenção preventiva com base em quilometragem. " +
  "Gestores acompanham em tempo real a localização dos veículos e recebem relatórios diários " +
  "de consumo de combustível por rota. Motoristas usam um aplicativo para registrar entregas, " +
  "fotografar comprovantes e reportar ocorrências. O backend expõe uma API REST autenticada por " +
  "tokens e persiste os dados em Postgres, com auditoria completa de todas as operações sensíveis."
).repeat(1);

describe("resolveIntakeMode", () => {
  it("respeita intakeMode explícito", () => {
    expect(resolveIntakeMode({ intakeMode: "free_text" })).toBe("free_text");
    expect(resolveIntakeMode({ intakeMode: "attachments" })).toBe("attachments");
    expect(resolveIntakeMode({ intakeMode: "anexos" })).toBe("attachments");
    expect(resolveIntakeMode({ intakeMode: "texto_livre" })).toBe("free_text");
  });
  it("infere pelo freeDescription quando não há intakeMode", () => {
    expect(resolveIntakeMode({ freeDescription: "algo" })).toBe("free_text");
    expect(resolveIntakeMode({ freeDescription: "  " })).toBe("attachments");
    expect(resolveIntakeMode({})).toBe("attachments");
  });
});

describe("validateIntake — caminho feliz", () => {
  it("aceita modo texto livre com título, tipo e >=500 letras", () => {
    const r = validateIntake({
      title: "Gestão de Frota Açores",
      projectType: "backend_api",
      freeDescription: LONG_TEXT,
      attachmentCount: 1,
      intakeMode: "free_text",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe("free_text");
      expect(r.projectType).toBe("backend_api");
    }
  });

  it("aceita modo anexos com título, tipo e >=1 arquivo (sem freeDescription)", () => {
    const r = validateIntake({
      title: "ERP Financeiro",
      projectType: "fullstack_saas",
      freeDescription: null,
      attachmentCount: 2,
      intakeMode: "attachments",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mode).toBe("attachments");
  });
});

describe("validateIntake — título", () => {
  it("rejeita título vazio", () => {
    const r = validateIntake({ title: "", projectType: "backend_api", freeDescription: LONG_TEXT, attachmentCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.fields).toContain("title");
  });
  it("rejeita o default 'Spec sem título' (com e sem acento)", () => {
    for (const t of ["Spec sem título", "Spec sem titulo", "SEM TÍTULO", "  untitled  "]) {
      const r = validateIntake({ title: t, projectType: "backend_api", freeDescription: LONG_TEXT, attachmentCount: 1 });
      expect(r.ok, `título "${t}" deveria ser rejeitado`).toBe(false);
      if (!r.ok) expect(r.block.fields).toContain("title");
    }
  });
  it("rejeita título curto ou sem letras", () => {
    for (const t of ["ab", "----", "123", "??"]) {
      const r = validateIntake({ title: t, projectType: "backend_api", freeDescription: LONG_TEXT, attachmentCount: 1 });
      expect(r.ok, `título "${t}" deveria ser rejeitado`).toBe(false);
    }
  });
});

describe("validateIntake — tipo de projeto", () => {
  it("rejeita tipo ausente", () => {
    const r = validateIntake({ title: "Projeto Real X", projectType: null, freeDescription: LONG_TEXT, attachmentCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.fields).toContain("project_type");
  });
  it("rejeita tipo fantasma (não reconhecido pelo policies.json)", () => {
    const r = validateIntake({ title: "Projeto Real X", projectType: "tipo_totalmente_inventado_zzz", freeDescription: LONG_TEXT, attachmentCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.fields).toContain("project_type");
  });
  it("rejeita _default e tipos com prefixo _", () => {
    const r = validateIntake({ title: "Projeto Real X", projectType: "_default", freeDescription: LONG_TEXT, attachmentCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.fields).toContain("project_type");
  });
});

describe("validateIntake — conteúdo mínimo", () => {
  it("rejeita texto livre com menos de 500 letras (sem anexo)", () => {
    const r = validateIntake({ title: "Projeto Real X", projectType: "backend_api", freeDescription: "curto demais", attachmentCount: 0, intakeMode: "free_text" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.fields).toContain("free_text");
  });
  it("não deixa passar 500 caracteres de espaço/pontuação (conta LETRAS)", () => {
    const padding = " .-".repeat(300); // 900 chars, 0 letras
    const r = validateIntake({ title: "Projeto Real X", projectType: "backend_api", freeDescription: padding, attachmentCount: 0, intakeMode: "free_text" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.fields).toContain("free_text");
  });
  it("HIGH-2: não deixa pular o piso de 500 letras declarando modo anexos sem arquivo", () => {
    const r = validateIntake({ title: "Projeto Real X", projectType: "backend_api", freeDescription: "texto curto", attachmentCount: 0, intakeMode: "attachments" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.fields.length).toBeGreaterThan(0);
  });
  it("aceita texto curto SE houver anexo (regra é OR: >=500 letras OU >=1 anexo)", () => {
    const r = validateIntake({ title: "Projeto Real X", projectType: "backend_api", freeDescription: "curto", attachmentCount: 1, intakeMode: "free_text" });
    expect(r.ok).toBe(true);
  });
  it("rejeita modo anexos sem nenhum arquivo", () => {
    const r = validateIntake({ title: "Projeto Real X", projectType: "backend_api", freeDescription: null, attachmentCount: 0, intakeMode: "attachments" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.fields).toContain("attachments");
  });
  it("aceita exatamente MIN_FREE_TEXT_CHARS letras", () => {
    const exact = "a".repeat(MIN_FREE_TEXT_CHARS);
    const r = validateIntake({ title: "Projeto Real X", projectType: "backend_api", freeDescription: exact, attachmentCount: 1, intakeMode: "free_text" });
    expect(r.ok).toBe(true);
  });
});

describe("validateIntake — falhas combinadas", () => {
  it("acumula todos os campos que falharam", () => {
    const r = validateIntake({ title: "Spec sem título", projectType: null, freeDescription: "curto", attachmentCount: 0, intakeMode: "free_text" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.block.fields).toEqual(expect.arrayContaining(["title", "project_type", "free_text"]));
      expect(r.block.code).toBe("SPEC_INTAKE_INCOMPLETE");
    }
  });
});
