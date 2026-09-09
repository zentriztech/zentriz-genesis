import { describe, it, expect } from "vitest";
import {
  anchorProbe,
  nearMissesFor,
  buildReanchorFacts,
  isReanchorable,
  type FailedAnchor,
} from "./specEditReanchor.js";

describe("anchorProbe", () => {
  it("é a PRIMEIRA linha não vazia da âncora (é ela que endereça o trecho)", () => {
    expect(anchorProbe("\n\n  ## FR-03 Autorização\ncorpo\n")).toBe("  ## FR-03 Autorização");
  });
  it("string vazia → vazio", () => {
    expect(anchorProbe("\n\n   \n")).toBe("");
  });
});

describe("nearMissesFor — sobe a escada e PARA no nível mais inocente", () => {
  it("nível 0: só diferença de espaço no fim da linha", () => {
    const base = "# API\n\n## FR-03 Autorização por papel\n\ncorpo\n";
    // o agente copiou a linha com espaços no fim
    const hits = nearMissesFor(base, "## FR-03 Autorização por papel   ");
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].verbatim).toBe("## FR-03 Autorização por papel"); // verbatim = bytes do ARQUIVO
    expect(hits[0].difference).toContain("espaço no fim");
  });

  it("nível 1 — o caso MEDIDO em prod: um marcador de lista `- ` a mais na âncora", () => {
    const linhaReal = "> - **MTOK-AGE-01 — Identificação observável do segredo (normativo).**";
    const base = `# doc\n\n${linhaReal}\n\ncorpo\n`;
    // o modelo pediu SEM o `- ` (acertou o conteúdo, errou os bytes)
    const hits = nearMissesFor(base, "> **MTOK-AGE-01 — Identificação observável do segredo (normativo).**");
    expect(hits).toHaveLength(1);
    expect(hits[0].verbatim).toBe(linhaReal); // devolve a linha do arquivo COM o `- `
    expect(hits[0].difference).toContain("marcador de lista");
  });

  it("nível 3: acentuação/caixa quando nada mais explica", () => {
    const base = "# doc\n\nIdentificação Observável do Segredo\n";
    const hits = nearMissesFor(base, "identificacao observavel do segredo");
    expect(hits).toHaveLength(1);
    expect(hits[0].verbatim).toBe("Identificação Observável do Segredo");
    expect(hits[0].difference).toContain("acentuação");
  });

  it("âncora curta demais (<12 chars) NÃO é procurada — seria ruído", () => {
    const base = "# API\n\n## FR\n\n## FR\n";
    expect(nearMissesFor(base, "## FR")).toEqual([]);
  });

  it("nenhuma linha se aproxima → []", () => {
    const base = "# API\n\nEndpoints públicos definidos.\n";
    expect(nearMissesFor(base, "trecho que jamais existiu neste arquivo")).toEqual([]);
  });

  it("respeita o teto `max` de linhas devolvidas", () => {
    const base = "# doc\n\nlinha repetida no arquivo\nlinha repetida no arquivo\nlinha repetida no arquivo\n";
    const hits = nearMissesFor(base, "linha repetida no arquivo   ", { max: 2 });
    expect(hits).toHaveLength(2);
  });
});

describe("buildReanchorFacts — só produz fato quando há trecho verbatim (disciplina anti-queima de token)", () => {
  const base = "# doc\n\n## FR-03 Autorização por papel\n\ncorpo do requisito\n";

  it("localiza a âncora → bloco de fato com a linha VERBATIM e a diferença, pronto para o FIM do prompt", () => {
    const failures: FailedAnchor[] = [
      { index: 0, search: "## FR-03 Autorização por papel   ", message: "Edição 1: o trecho a substituir não existe…" },
    ];
    const facts = buildReanchorFacts(base, failures);
    expect(facts).not.toBeNull();
    expect(facts!.located).toBe(1);
    expect(facts!.unlocated).toBe(0);
    expect(facts!.text).toContain("A TENTATIVA ANTERIOR NÃO PÔDE SER APLICADA");
    expect(facts!.text).toContain("## FR-03 Autorização por papel"); // a linha real, verbatim
    expect(facts!.text).toContain("espaço no fim"); // a diferença declarada
    expect(facts!.text).toContain("SOMENTE os blocos"); // reforça: não reemita o arquivo
  });

  it("NENHUMA âncora localizada → `null` (sem fato novo, não há retentativa a pagar)", () => {
    const failures: FailedAnchor[] = [
      { index: 0, search: "trecho totalmente imaginário e ausente", message: "…" },
    ];
    expect(buildReanchorFacts(base, failures)).toBeNull();
  });

  it("mistura localizada + não localizada → produz fato e CONTA as duas", () => {
    const failures: FailedAnchor[] = [
      { index: 0, search: "## FR-03 Autorização por papel   ", message: "…" },
      { index: 1, search: "âncora que não está em lugar nenhum aqui", message: "…" },
    ];
    const facts = buildReanchorFacts(base, failures);
    expect(facts).not.toBeNull();
    expect(facts!.located).toBe(1);
    expect(facts!.unlocated).toBe(1);
    expect(facts!.text).toContain("nenhuma linha do arquivo se aproxima");
  });

  it("`digested` → avisa que a âncora pode estar FORA do recorte e manda declarar o GAP, não inventar", () => {
    const failures: FailedAnchor[] = [
      { index: 0, search: "## FR-03 Autorização por papel   ", message: "…" },
    ];
    const facts = buildReanchorFacts(base, failures, { digested: true });
    expect(facts!.text).toContain("chegou RECORTADO");
    expect(facts!.text).toContain("NÃO invente âncora");
  });

  it("mais de 6 âncoras recusadas → DECLARA o que ficou de fora (GAP-128, nunca corta em silêncio)", () => {
    const failures: FailedAnchor[] = Array.from({ length: 9 }, (_, i) => ({
      index: i,
      // todas localizáveis para garantir located>0 e o bloco existir
      search: "## FR-03 Autorização por papel   ",
      message: "…",
    }));
    const facts = buildReanchorFacts(base, failures);
    expect(facts).not.toBeNull();
    expect(facts!.truncated).toHaveLength(1);
    expect(facts!.truncated[0]).toContain("além das 6 primeiras");
  });
});

describe("isReanchorable — só falhas de ÂNCORA valem retentativa", () => {
  it("SEARCH_NOT_FOUND / SEARCH_AMBIGUOUS / EMPTY_SEARCH → true (o agente pode corrigir relendo)", () => {
    expect(isReanchorable("SEARCH_NOT_FOUND")).toBe(true);
    expect(isReanchorable("SEARCH_AMBIGUOUS")).toBe(true);
    expect(isReanchorable("EMPTY_SEARCH")).toBe(true);
  });
  it("SHRUNK / MARKER_IN_REPLACE / NO_BLOCKS → false (falam do RESULTADO ou já têm instrução própria)", () => {
    expect(isReanchorable("SHRUNK")).toBe(false);
    expect(isReanchorable("MARKER_IN_REPLACE")).toBe(false);
    expect(isReanchorable("NO_BLOCKS")).toBe(false);
  });
});
