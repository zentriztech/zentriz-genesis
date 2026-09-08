import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import {
  AUDIT_SYSTEM, buildAuditDossier, buildAuditMessage, evidenceIsVerbatim, normalizeGravity,
  normalizeVerdict, parseAuditJson, tally, type FindingAudit,
} from "./crossFamilyAudit.js";
import type { ValidationFinding } from "./specValidation.js";

/**
 * REVISOR CROSS-FAMILY — o instrumento de EQUILÍBRIO (2026-09-07).
 *
 * Pedido do Jean, verbatim: *"não se trata apenas de deixar passar e destravar as specs, não podemos
 * ignorar falhas realmente graves de análises e escrita as specs, também não podemos entrar em um loop
 * infinito em busca da perfeição que nunca será alcançada porque a cada nova rodada é criado novos
 * gaps, precisamos de equilíbrio."*
 *
 * Os testes abaixo fixam as duas metades desse equilíbrio, porque cada uma tem um modo de falha
 * oposto e igualmente caro:
 *   • **deixar passar** — qualquer caminho que transforme ruído (JSON inválido, gravidade omitida,
 *     citação inventada) em absolvição é anistia silenciosa. Todos eles têm de cair em
 *     `indecidivel`/`grave`, jamais em `ausente`/`cosmetica`.
 *   • **loop infinito** — o `ausente` COM prova verbatim é o único mecanismo que mata o GAP eterno
 *     (classe GAP-84: blocker que se declara conforme, que nenhuma edição fecha).
 */

function f(over: Partial<ValidationFinding> & { title: string }): ValidationFinding {
  return {
    file: "nvx-lastmile-backend.md", line: null, severity: "blocker", rationale: "",
    source: "stage_b", category: "stack_inconsistent", anchor: "§1.1", ...over,
  };
}

// ── 1. parsing: 3 das 4 famílias cercam o JSON em ```json ─────────────────────

describe("parseAuditJson", () => {
  it("aceita JSON cru (o formato do Nova Pro)", () => {
    const p = parseAuditJson('{"verdict":"ausente","gravity":"","evidence":"integrationTier: tier1-sync-only","why":"conforme"}');
    expect(p?.verdict).toBe("ausente");
    expect(p?.evidence).toBe("integrationTier: tier1-sync-only");
  });

  it("aceita JSON cercado — medido em Mistral Large 3, DeepSeek v3.2 e Qwen3", () => {
    const p = parseAuditJson('```json\n{"verdict":"presente","gravity":"grave","evidence":"x","why":"y"}\n```');
    expect(p?.verdict).toBe("presente");
    expect(p?.gravity).toBe("grave");
  });

  it("aceita prosa em volta do objeto (o modelo explica antes de responder)", () => {
    const p = parseAuditJson('Analisei o trecho.\n{"verdict":"indecidivel","evidence":"","why":"texto fora do trecho"}\nEspero ter ajudado.');
    expect(p?.verdict).toBe("indecidivel");
  });

  it("devolve null para resposta sem JSON — o chamador conta como FALHA, não como absolvição", () => {
    expect(parseAuditJson("não consigo avaliar")).toBeNull();
    expect(parseAuditJson("")).toBeNull();
    expect(parseAuditJson('{"verdict":')).toBeNull();
  });

  it("devolve null quando o objeto existe mas não tem veredicto", () => {
    expect(parseAuditJson('{"gravity":"grave","why":"algo"}')).toBeNull();
  });
});

// ── 2. a propriedade de segurança: ruído NUNCA absolve ────────────────────────

describe("normalizeVerdict", () => {
  it("preserva o vocabulário fechado", () => {
    expect(normalizeVerdict("presente")).toBe("presente");
    expect(normalizeVerdict("ausente")).toBe("ausente");
    expect(normalizeVerdict("indecidivel")).toBe("indecidivel");
    expect(normalizeVerdict("indecidível")).toBe("indecidivel");
  });

  it("🔴 veredicto desconhecido cai em indecidivel, NUNCA em ausente", () => {
    // Absolver por ruído de parsing seria a anistia silenciosa que o Jean proibiu: o GAP sairia da
    // contagem sem ninguém ter afirmado que o defeito não existe.
    for (const lixo of ["não aplicável", "inconclusive", "absent", "", "ok", "conforme"]) {
      expect(normalizeVerdict(lixo)).toBe("indecidivel");
    }
  });
});

describe("normalizeGravity", () => {
  it("só existe gravidade quando o defeito foi CONFIRMADO", () => {
    expect(normalizeGravity("grave", "ausente")).toBe("");
    expect(normalizeGravity("grave", "indecidivel")).toBe("");
  });

  it("preserva a régua fechada, com e sem acento", () => {
    expect(normalizeGravity("grave", "presente")).toBe("grave");
    expect(normalizeGravity("moderada", "presente")).toBe("moderada");
    expect(normalizeGravity("cosmetica", "presente")).toBe("cosmetica");
    expect(normalizeGravity("cosmética", "presente")).toBe("cosmetica");
  });

  it("🔴 defeito confirmado sem gravidade legível é GRAVE — o silêncio do auditor não absolve", () => {
    // O lado seguro aqui é o oposto do de cima: o auditor AFIRMOU que o defeito existe. Cair em
    // "cosmetica" por omissão tiraria uma falha possivelmente séria do caminho que bloqueia promoção.
    expect(normalizeGravity(undefined, "presente")).toBe("grave");
    expect(normalizeGravity("", "presente")).toBe("grave");
    expect(normalizeGravity("média", "presente")).toBe("grave");
  });
});

// ── 3. a citação é a única prova do "ausente" ────────────────────────────────

describe("evidenceIsVerbatim", () => {
  const trecho = `---\narchetype: backend-service\nintegrationTier: tier1-sync-only\nspec_version: 1.2.1\n---\n\n# NVX LastMile — Backend`;

  it("aceita citação copiada do trecho, com espaços normalizados", () => {
    expect(evidenceIsVerbatim("integrationTier: tier1-sync-only", trecho)).toBe(true);
    expect(evidenceIsVerbatim("  integrationTier:   tier1-sync-only\n", trecho)).toBe(true);
  });

  it("🔴 recusa citação tirada do texto da ACUSAÇÃO — medido em Nova Pro e Qwen3", () => {
    // Os dois citaram o `rationale` do acusador em vez do trecho da spec. Sem esta checagem de
    // transporte, o "ausente" deles seria indistinguível de prova real.
    expect(evidenceIsVerbatim("O finding é reportado apenas para preservar continuidade de anchor", trecho)).toBe(false);
  });

  it("recusa citação curta demais (casa por acidente)", () => {
    expect(evidenceIsVerbatim("---", trecho)).toBe(false);
    expect(evidenceIsVerbatim("", trecho)).toBe(false);
  });
});

// ── 4. a mensagem: trecho ANTES da acusação (ordem que o gold set validou) ────

describe("buildAuditMessage", () => {
  it("põe o trecho antes da acusação e nomeia arquivo e âncora", () => {
    const msg = buildAuditMessage(f({ title: "Frontmatter divergente", rationale: "porque sim" }), "TEXTO DA SECAO");
    expect(msg.indexOf("<<<INICIO>>>")).toBeLessThan(msg.indexOf("ACUSAÇÃO"));
    expect(msg).toContain("TEXTO DA SECAO");
    expect(msg).toContain("§1.1");
    expect(msg).toContain("nvx-lastmile-backend.md");
    expect(msg).toContain("Frontmatter divergente");
    expect(msg).toContain("porque sim");
  });

  it("finding sem âncora ainda produz mensagem legível (não quebra o prompt)", () => {
    const msg = buildAuditMessage(f({ title: "t", anchor: null }), "S");
    expect(msg).toContain("(sem âncora)");
  });
});

// ── 4b. o dossiê: o auditor não pode ser mais cego que o escritor ────────────

describe("buildAuditDossier", () => {
  /**
   * 🔴 MEDIDO EM PROD (run `2eafbd95`, primeira auditoria cross-family ao vivo): mandando só a seção
   * ancorada, **8 de 10** vereditos foram `indecidivel`, sempre com o mesmo motivo escrito pelo
   * auditor — *"a acusação depende de conteúdo de outro arquivo / de outras seções não incluídas"*.
   *
   * Isso não é o auditor falhando: é o RECORTE. E um instrumento que diz "não sei" em 80% dos casos
   * não serve a nenhuma das duas pernas do equilíbrio — nem confirma a falha grave, nem mata o GAP
   * eterno. O dossiê dá ao auditor exatamente o que o CTO-editor já recebe.
   */
  const tmp = mkdtempSync(join(tmpdir(), "audit-dossier-"));
  const irmao = join(tmp, "definicao-de-pronto.md");
  const alvo = join(tmp, "api-entregas.md");
  writeFileSync(irmao, "# Definição de pronto\n\n## §9 Erros\n\nErro de validação responde `400`.\n");
  writeFileSync(alvo, "# API\n\n## §3.1 Erros\n\nErro de validação responde `422`.\n");

  const refs = [
    { path: "api-entregas.md", filename: "api-entregas.md", relDir: "", filePath: alvo, isPrimary: true },
    { path: "definicao-de-pronto.md", filename: "definicao-de-pronto.md", relDir: "", filePath: irmao, isPrimary: false },
  ];

  it("🔴 traz a OUTRA PONTA da contradição quando a acusação cita o irmão", async () => {
    const finding = f({
      file: "api-entregas.md", anchor: "§3.1", title: "Status HTTP divergente",
      rationale: "O arquivo definicao-de-pronto.md §9 define 400 para erro de validação, aqui é 422.",
    });
    const d = await buildAuditDossier(refs, "api-entregas.md", readFileSync(alvo, "utf8"), finding);
    expect(d.text).toContain("=== ARQUIVO ACUSADO: api-entregas.md ===");
    expect(d.text).toContain("422");
    // Sem esta linha o auditor responde `indecidivel` — foi literalmente o que 8 de 10 fizeram.
    expect(d.text).toContain("definicao-de-pronto.md");
    expect(d.text).toContain("400");
  });

  it("declara o que ficou de fora — cortar é aceitável, mentir sobre o corte não", async () => {
    const d = await buildAuditDossier(refs, "api-entregas.md", readFileSync(alvo, "utf8"), f({ title: "t" }));
    expect(d.text).toContain("=== FORA DESTE DOSSIÊ (declarado, não omitido) ===");
  });

  it("arquivo pequeno e sem citação: nada é cortado, e isso é dito", async () => {
    const d = await buildAuditDossier([refs[0]], "api-entregas.md", readFileSync(alvo, "utf8"), f({ title: "t" }));
    expect(d.cuts).toEqual([]);
    expect(d.text).toContain("nada: o dossiê traz tudo que a acusação nomeia");
  });
});

// ── 5. as regras do prompt que fizeram 4 famílias acertarem 12/12 ────────────

describe("AUDIT_SYSTEM", () => {
  it('proíbe "ausente" quando a prova está fora do trecho', () => {
    expect(AUDIT_SYSTEM).toContain('o veredicto é "indecidivel" — NUNCA "ausente"');
  });

  it("exige que a citação venha do TRECHO, não da acusação", () => {
    expect(AUDIT_SYSTEM).toContain("NUNCA do\n   texto da acusação");
  });

  it("cobre a confissão do acusador — o caso GAP-84 literal", () => {
    expect(AUDIT_SYSTEM).toContain('"para preservar continuidade"');
  });

  it("avisa que acusação confiante não é prova (sem esta linha o caso falso-confiante falhava)", () => {
    expect(AUDIT_SYSTEM).toContain("Uma acusação escrita com segurança não é prova de nada");
  });

  it("🔴 a régua de gravidade é consequência para quem CONSTRÓI, não gosto de redação", () => {
    // É isto que permite equilíbrio: sem a régua, "grave" viraria "eu me incomodei" e voltaríamos
    // ao loop infinito atrás de perfeição.
    expect(AUDIT_SYSTEM).toContain("CONSEQUÊNCIA PARA QUEM VAI CONSTRUIR");
    expect(AUDIT_SYSTEM).toContain("produz algo ERRADO, ou não consegue construir");
    expect(AUDIT_SYSTEM).toContain("Não muda NADA do que será construído");
  });

  it("não pede correção nem defeitos novos — esta perna só verifica a premissa", () => {
    expect(AUDIT_SYSTEM).toContain("NÃO propõe correção");
    expect(AUDIT_SYSTEM).toContain("NÃO acrescenta defeitos novos");
  });
});

// ── 6. o número que faltava: FP do próprio juiz ──────────────────────────────

describe("tally", () => {
  const a = (over: Partial<FindingAudit>): FindingAudit => ({
    fingerprint: "fp", file: "a.md", anchor: "§1", severityClaude: "blocker", categoryClaude: "c",
    title: "t", verdict: "presente", gravity: "grave", evidence: "e", evidenceVerbatim: true,
    why: "w", model: "amazon.nova-pro-v1:0", sectionChars: 100, fileShaAt: "sha", ...over,
  });

  it("conta veredictos e gravidades separadamente", () => {
    const t = tally([
      a({}),
      a({ verdict: "presente", gravity: "moderada" }),
      a({ verdict: "presente", gravity: "cosmetica" }),
      a({ verdict: "ausente", gravity: "", evidenceVerbatim: true }),
      a({ verdict: "ausente", gravity: "", evidenceVerbatim: false }),
      a({ verdict: "indecidivel", gravity: "" }),
    ]);
    expect(t).toMatchObject({
      total: 6, presente: 3, ausente: 2, indecidivel: 1,
      grave: 1, moderada: 1, cosmetica: 1, ausenteComProva: 1,
    });
  });

  it('🔴 "ausenteComProva" separa a absolvição PROVADA da meramente alegada', () => {
    // A estimativa honesta de falso-positivo do nosso juiz usa só a coluna com prova verbatim.
    const t = tally([a({ verdict: "ausente", gravity: "", evidenceVerbatim: false })]);
    expect(t.ausente).toBe(1);
    expect(t.ausenteComProva).toBe(0);
  });

  it("lista vazia não inventa número", () => {
    expect(tally([])).toMatchObject({ total: 0, presente: 0, ausente: 0, ausenteComProva: 0 });
  });
});
