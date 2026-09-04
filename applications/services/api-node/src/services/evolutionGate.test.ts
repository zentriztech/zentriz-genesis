import { describe, it, expect, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { parseRfcMarkdown, evaluateEvolutionGate, collectEvolutionRfcs } from "./evolutionGate.js";

const GOOD = `# RFC-0001 — Exportar extrato em PDF

## Sumário
Permitir exportar o extrato mensal em PDF a partir da tela de relatórios.

## Escopo
**Não-objetivos:** não muda o cálculo do saldo.

## Requisitos
- REQ-01 — O sistema DEVE gerar PDF do extrato do mês selecionado.

## Critérios de aceite
### Cenário: exportar mês corrente
- **Dado** um usuário autenticado com lançamentos no mês
- **Quando** clica em "Exportar PDF"
- **Então** recebe um arquivo PDF com todos os lançamentos do mês

## Compatibilidade
- Tipo (SemVer): MINOR
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
  - "apps/api/src/reports/**"
  - "apps/web/src/pages/reports/**"
  - "tests/**"
\`\`\`
`;

const BAD = `# RFC-0002 — Algo vago

## Sumário
Fazer melhor.

## Critérios de aceite
Deve funcionar bem.
`;

describe("evolutionGate (Evoluir E3)", () => {
  it("parse: RFC completo → Gherkin, files_allowed, compat MINOR, sem problemas", () => {
    const r = parseRfcMarkdown("docs/rfc/RFC-0001-exportar-pdf.md", GOOD);
    expect(r.number).toBe(1);
    expect(r.title).toMatch(/Exportar extrato/);
    expect(r.hasGherkin).toBe(true);
    expect(r.filesAllowed).toEqual(["apps/api/src/reports/**", "apps/web/src/pages/reports/**", "tests/**"]);
    expect(r.compat).toBe("minor");
    expect(r.breaking).toBe(false);
    expect(r.hasNonGoals).toBe(true);
    expect(r.mustCount).toBeGreaterThan(0);
    expect(r.problems).toEqual([]);
  });

  it("parse: RFC vago → problemas (sem Gherkin, sem Impacto); bullets com crase também contam como globs", () => {
    const r = parseRfcMarkdown("docs/rfc/RFC-0002-vago.md", BAD);
    expect(r.hasGherkin).toBe(false);
    expect(r.filesAllowed).toEqual([]);
    expect(r.problems.length).toBe(2);
    const bullets = parseRfcMarkdown("docs/rfc/RFC-0003-x.md", GOOD.replace(/```yaml[\s\S]*?```/, "- `apps/api/src/x.ts`\n- `apps/api/src/y/**`\n- texto sem caminho"));
    expect(bullets.filesAllowed).toEqual(["apps/api/src/x.ts", "apps/api/src/y/**"]);
    // globs perigosos são descartados
    expect(parseRfcMarkdown("docs/rfc/RFC-0004-x.md", GOOD.replace('"apps/api/src/reports/**"', '"../../etc/**"')).filesAllowed).not.toContain("../../etc/**");
  });

  it("parse (adversarial): escopo irrestrito é problema; prosa com dado/quando/então NÃO é Gherkin; lista inline é lida", () => {
    // A — `**`/`apps/**` esvaziam o gate do E4
    const wide = parseRfcMarkdown("docs/rfc/RFC-0005-x.md", GOOD.replace('"apps/api/src/reports/**"', '"**"').replace('"apps/web/src/pages/reports/**"', '"apps/**"'));
    expect(wide.filesAllowed).toEqual(["tests/**"]);
    expect(wide.problems.some((p) => p.startsWith("escopo irrestrito"))).toBe(true);
    // B — sem seção de aceite, palavras em prosa → não conta (e sem fallback para o documento)
    const prose = parseRfcMarkdown("docs/rfc/RFC-0006-x.md", "# RFC\n\n## Sumário\nDado que o cliente pediu, quando possível, então faremos.\n\n## Impacto\n- `apps/api/src/a.ts`\n");
    expect(prose.hasGherkin).toBe(false);
    expect(prose.problems.some((p) => /Critérios de aceite/.test(p))).toBe(true);
    // B' — na seção certa, mas em prosa corrida (não em início de linha) → também não conta
    const proseInSec = parseRfcMarkdown("docs/rfc/RFC-0007-x.md", GOOD.replace(/### Cenário[\s\S]*?do mês\n/, "Funciona dado o contexto, quando chamado, então ok.\n"));
    expect(proseInSec.hasGherkin).toBe(false);
    // B'' — bullets numerados e sem negrito também valem
    const numbered = parseRfcMarkdown("docs/rfc/RFC-0008-x.md", GOOD.replace(/- \*\*Dado\*\*/, "1. Dado").replace(/- \*\*Quando\*\*/, "2. Quando").replace(/- \*\*Então\*\*/, "3. Então"));
    expect(numbered.hasGherkin).toBe(true);
    // C — lista inline
    const inline = parseRfcMarkdown("docs/rfc/RFC-0009-x.md", GOOD.replace(/files_allowed:[\s\S]*?```/, 'files_allowed: [apps/a.ts, "apps/b/**"]\n```'));
    expect(inline.filesAllowed).toEqual(["apps/a.ts", "apps/b/**"]);
    expect(inline.problems).toEqual([]);
  });

  it("gate: projeto não-evolução → passthrough sem tocar o banco", async () => {
    const q = vi.fn();
    const r = await evaluateEvolutionGate({ query: q } as never, "p", { foo: 1 });
    expect(r).toEqual({ ok: true, applied: false });
    expect(q).not.toHaveBeenCalled();
  });

  it("gate: evolução sem RFC → EVOLUTION_RFC_REQUIRED; RFC inválido → EVOLUTION_RFC_INVALID", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-"));
    const bad = path.join(dir, "RFC-0002-vago.md");
    await fs.writeFile(bad, BAD);
    const none = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await evaluateEvolutionGate(none as never, "p", { evolution: true })).toMatchObject({ ok: false, code: "EVOLUTION_RFC_REQUIRED" });
    const withBad = { query: vi.fn(async (sql: string) => /project_spec_files/.test(sql) ? { rows: [{ filename: "RFC-0002-vago.md", file_path: bad, rel_dir: "docs/rfc" }] } : { rows: [] }) };
    const r = await evaluateEvolutionGate(withBad as never, "p", { evolution: true });
    expect(r).toMatchObject({ ok: false, code: "EVOLUTION_RFC_INVALID" });
    expect(String((r as { message: string }).message)).toMatch(/Gherkin/);
  });

  it("gate: RFC válido → grava evolution_rfcs/scope/compat/request sintetizado (preserva o texto livre original)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-"));
    const good = path.join(dir, "RFC-0001-exportar-pdf.md");
    await fs.writeFile(good, GOOD);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/project_spec_files/.test(sql)) return { rows: [
        { filename: "RFC-0001-exportar-pdf.md", file_path: good, rel_dir: "docs/rfc" },
        { filename: "01-spec.md", file_path: "/x/01-spec.md", rel_dir: "" },          // ignorado (não é RFC)
        { filename: "RFC-0009-fora.md", file_path: "/x/nope.md", rel_dir: "docs" },     // rel_dir errado → ignorado
      ] };
      return { rows: [] };
    }) };
    const r = await evaluateEvolutionGate(db as never, "p", { evolution: true, evolution_request: "quero pdf" });
    expect(r).toMatchObject({ ok: true, applied: true, rfcs: 1, compat: "minor" });
    const upd = calls.find((c) => /UPDATE projects SET extra/.test(c.sql))!;
    const patch = JSON.parse(upd.params[1] as string);
    expect(patch.evolution_rfcs).toEqual(["docs/rfc/RFC-0001-exportar-pdf.md"]);
    expect(patch.evolution_scope).toEqual(["apps/api/src/reports/**", "apps/web/src/pages/reports/**", "tests/**"]);
    expect(patch.evolution_compat).toBe("minor");
    expect(patch.evolution_request).toMatch(/RFC-0001-exportar-pdf\.md — RFC-0001 — Exportar extrato/);
    expect(patch.evolution_request_original).toBe("quero pdf");
    expect((await collectEvolutionRfcs(db as never, "p")).length).toBe(1);
  });
});
