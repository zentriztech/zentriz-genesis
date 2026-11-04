/**
 * Fase 2 / 2.6 (f) — exigências do TIPO do card sobre o gate de RFC. O núcleo é puro: recebe RFCs já parseados.
 * O gate base (RFC presente + Gherkin + files_allowed) é invariante e é provado no teste de Postgres (routes/cards.pg.integration.test.ts).
 */
import { describe, it, expect } from "vitest";
import { checkCardKindRequirements, parseRfcMarkdown } from "./evolutionGate.js";

const rfc = (o: { compat?: string; nonGoals?: boolean; repro?: boolean; scenario?: string } = {}) => `# RFC-0001 — Algo

## Sumário
Texto do sumário.
${o.nonGoals ? "\n## Non-goals\nNão muda o saldo.\n" : ""}
## Requisitos
- REQ-01 — O sistema DEVE fazer a coisa.

## Critérios de aceite
### ${o.scenario ?? "Cenário: caminho feliz"}
- **Dado** um usuário
- **Quando** age
- **Então** vê o resultado
${o.repro ? "\n### Cenário: reprodução do defeito (FAIL_TO_PASS)\n- **Dado** o defeito\n- **Quando** repete\n- **Então** falha hoje\n" : ""}
## Compatibilidade
- Tipo (SemVer): ${o.compat ?? "PATCH"}
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
  - "apps/api/src/**"
\`\`\`
`;
const p = (o?: Parameters<typeof rfc>[0]) => parseRfcMarkdown("docs/rfc/RFC-0001-algo.md", rfc(o));

describe("exigências por tipo (só acrescentam; o gate base não é dispensado aqui)", () => {
  it("Evolução: nenhuma exigência extra (rito atual)", () => {
    expect(checkCardKindRequirements("evolution", [p({ compat: "MAJOR" })])).toBeNull();
    expect(checkCardKindRequirements("evolution", [p()])).toBeNull();
  });

  it("Correção: exige cenário de reprodução (FAIL_TO_PASS) — sem ele CARD_KIND_REQUIREMENT", () => {
    const r = checkCardKindRequirements("fix", [p({ compat: "PATCH" })]);
    expect(r).toMatchObject({ ok: false, code: "CARD_KIND_REQUIREMENT", details: { missing: ["repro_scenario"] } });
    expect(r!.message).toMatch(/reprodução/i);
    expect(checkCardKindRequirements("fix", [p({ compat: "PATCH", repro: true })])).toBeNull();
  });

  it("Correção: compat > patch ⇒ CARD_KIND_MISMATCH (mesmo com a reprodução)", () => {
    for (const compat of ["MINOR", "MAJOR"]) {
      const r = checkCardKindRequirements("fix", [p({ compat, repro: true })]);
      expect(r).toMatchObject({ ok: false, code: "CARD_KIND_MISMATCH" });
    }
    // sem compat declarada não é > patch
    const none = parseRfcMarkdown("docs/rfc/RFC-0001-algo.md", rfc({ repro: true }).replace(/## Compatibilidade[\s\S]*?## Impacto/, "## Impacto"));
    expect(none.compat).toBeNull();
    expect(checkCardKindRequirements("fix", [none])).toBeNull();
  });

  it("Correção: um RFC com compat minor entre vários derruba (a compatibilidade mais alta manda)", () => {
    const r = checkCardKindRequirements("fix", [p({ compat: "PATCH", repro: true }), p({ compat: "MINOR", repro: true })]);
    expect(r?.code).toBe("CARD_KIND_MISMATCH");
  });

  it("Recurso novo: Non-goals obrigatório (Não-objetivos conta)", () => {
    const r = checkCardKindRequirements("feature", [p({ compat: "MINOR" })]);
    expect(r).toMatchObject({ ok: false, code: "CARD_KIND_REQUIREMENT", details: { missing: ["non_goals"] } });
    expect(r!.message).toMatch(/Non-goals/);
    expect(checkCardKindRequirements("feature", [p({ compat: "MINOR", nonGoals: true })])).toBeNull();
  });

  it("prosa solta com a palavra 'reprodução' fora dos critérios NÃO conta como cenário de reprodução", () => {
    const md = rfc({ compat: "PATCH" }).replace("Texto do sumário.", "Texto do sumário com reprodução do defeito descrita aqui.");
    expect(parseRfcMarkdown("docs/rfc/RFC-0001-algo.md", md).hasReproScenario).toBe(false);
  });
});
