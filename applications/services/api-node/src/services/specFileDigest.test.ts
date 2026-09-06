/**
 * A5.7 / GAP-7 — o arquivo ALVO grande entra RECORTADO em vez de sair da fila.
 *
 * O defeito medido em prod (run `75b3cf5d`, rodada 13): `modelo-dados.md` passou de 126.742 chars,
 * bateu no teto de 120.000 e **saiu da fila com os GAPs dele ativos** — e não nasceu grande, o próprio
 * CTO-editor o inflou rodada a rodada. Cada teste aqui trava uma propriedade sem a qual o recorte
 * seria pior que a recusa: mostrar a seção que o GAP aponta, mostrar VERBATIM (senão o `SEARCH` não
 * casa) e nunca deixar o modelo achar que o que não foi transcrito não existe.
 */
import { describe, it, expect } from "vitest";
import { buildFileDigest, TARGET_SECTION_BUDGET } from "./specFileDigest.js";
import type { ValidationFinding } from "./specValidation.js";

const CAP = 20_000;

function gap(title: string, rationale: string, anchor?: string): ValidationFinding {
  return { severity: "blocker", title, rationale, anchor } as unknown as ValidationFinding;
}

/** Enchimento identificável por seção — é como se distingue o que entrou do que ficou de fora. */
const filler = (tag: string, n: number) => `${`${tag} `.repeat(n)}\n`;

const BIG = [
  "# Modelo de dados",
  filler("abertura", 800),
  "## 1. Entidade Entrega",
  "O campo `status_entrega` é enum: PENDENTE, EM_ROTA, ENTREGUE.",
  filler("entrega", 200),
  "## 2. Paginação",
  filler("paginacao", 800),
  "## 3. Auditoria",
  filler("auditoria", 800),
].join("\n");

describe("buildFileDigest", () => {
  it("arquivo que CABE no teto não é tocado (recortar o que cabe só arrisca esconder o trecho a mudar)", () => {
    const d = buildFileDigest("m.md", "# M\n\nconteúdo curto.", [gap("x", "y")], CAP);
    expect(d.digested).toBe(false);
    expect(d.text).toBe("# M\n\nconteúdo curto.");
  });

  it("acima do teto: a seção apontada pelo GAP entra VERBATIM e as outras não gastam orçamento", () => {
    const d = buildFileDigest(
      "modelo-dados.md",
      BIG,
      [gap("Enum divergente", "O campo `status_entrega` contradiz o contrato de API.")],
      CAP,
    );
    expect(d.digested).toBe(true);
    expect(d.text).toContain("O campo `status_entrega` é enum: PENDENTE, EM_ROTA, ENTREGUE.");
    expect(d.text).not.toContain("paginacao paginacao");
    expect(d.text).not.toContain("auditoria auditoria");
    expect(d.text.length).toBeLessThan(CAP);
    expect(d.used).toBe(1);
    expect(d.total).toBeGreaterThan(1);
  });

  it("o sumário lista TODAS as seções — inclusive as não transcritas", () => {
    const d = buildFileDigest("modelo-dados.md", BIG, [gap("x", "`status_entrega`")], CAP);
    expect(d.text).toContain("SUMÁRIO DE SEÇÕES");
    expect(d.text).toContain("## 2. Paginação");
    expect(d.text).toContain("## 3. Auditoria");
  });

  it("as REGRAS do recorte vão no bloco (sem elas o modelo recria a seção que não viu)", () => {
    const d = buildFileDigest("modelo-dados.md", BIG, [gap("x", "`status_entrega`")], CAP);
    expect(d.text).toContain("NÃO recrie uma seção");
    expect(d.text).toContain("byte a byte igual ao arquivo");
    expect(d.text).toContain("diga isso na linha final");
  });

  it("a ÂNCORA do validador também seleciona a seção (é o endereço que ele achou do problema)", () => {
    const d = buildFileDigest("modelo-dados.md", BIG, [gap("Falta índice", "sem detalhe", "## 3. Auditoria")], CAP);
    expect(d.text).toContain("auditoria auditoria");
    expect(d.text).not.toContain("paginacao paginacao");
  });

  it("nenhum termo casou → mostra o INÍCIO com aviso de que o resto continua existindo", () => {
    const d = buildFileDigest("modelo-dados.md", BIG, [gap("Falta rigor", "melhore a redação")], CAP);
    expect(d.digested).toBe(true);
    expect(d.used).toBe(0);
    expect(d.text).toContain("SUMÁRIO DE SEÇÕES");
    expect(d.text).toContain("CONTINUA existindo no arquivo");
    expect(d.text).toContain("abertura abertura");
    expect(d.text.length).toBeLessThan(CAP);
  });

  it("seção quilométrica é truncada com marcador (uma seção não pode virar o recorte todo)", () => {
    const gigante = [
      "# G",
      "## 1. Enorme",
      `O campo \`status_entrega\` manda. ${"z".repeat(TARGET_SECTION_BUDGET + 5_000)}`,
      "## 2. Outra",
      filler("outra", 1_500),
    ].join("\n");
    // Teto folgado o bastante para a seção CLIPADA caber — o que se testa é o corte, não o orçamento.
    const d = buildFileDigest("g.md", gigante, [gap("x", "`status_entrega`")], 34_000);
    expect(gigante.length).toBeGreaterThan(34_000);
    expect(d.text).toContain("[… seção truncada …]");
  });
});
