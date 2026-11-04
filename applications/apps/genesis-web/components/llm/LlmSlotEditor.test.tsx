/**
 * Teste de componente do LlmSlotEditor (plano EVOLUIR-PROJETO 0.6): o modo `roles_mode` decide qual
 * UI aparece. `off`/`shadow` ⇒ editor legado (Modelo principal + Fallback); `on` ⇒ três papéis.
 * A API é totalmente simulada — nenhuma chamada de rede.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  // O catálogo dinâmico falha ⇒ o componente cai no catálogo local ("nunca lança").
  apiPost: vi.fn().mockRejectedValue(new Error("api simulada indisponível")),
  apiPut: vi.fn().mockResolvedValue({}),
  withQuery: (p: string) => p,
}));

import { LlmSlotEditor, type LlmSlot } from "./LlmSlotEditor";

const slot = {
  configured: true,
  priority: 1,
  priority_label: "Principal",
  provider: "bedrock",
  model_id: "us.anthropic.claude-sonnet-5-5",
  model_id_fallback: "us.anthropic.claude-opus-5-5",
  has_credentials: true,
  credentials_masked: {},
} as unknown as LlmSlot;

function renderEditor(rolesMode?: "off" | "shadow" | "on") {
  return render(
    <LlmSlotEditor open slot={slot} priority={1} endpoint="/api/tenant/llm-config"
      rolesMode={rolesMode} onClose={() => {}} onSaved={() => {}} />,
  );
}

describe("LlmSlotEditor — roles_mode", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each([["off" as const], ["shadow" as const], [undefined]])("%s: editor legado, sem os três papéis", (mode) => {
    renderEditor(mode);
    expect(screen.getByText("Editar — Contingência 1", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Fallback (rework / QA)", { selector: "label" })).toBeInTheDocument();
    expect(screen.queryByText("Papéis do modelo neste slot")).not.toBeInTheDocument();
  });

  it("on: mostra os três papéis e esconde o fallback legado", () => {
    renderEditor("on");
    expect(screen.getByText("Papéis do modelo neste slot")).toBeInTheDocument();
    for (const r of ["Orchestrator", "Advisor", "Staff"]) {
      expect(screen.getAllByText(r, { exact: false }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("Fallback (rework / QA)", { selector: "label" })).not.toBeInTheDocument();
  });
});
