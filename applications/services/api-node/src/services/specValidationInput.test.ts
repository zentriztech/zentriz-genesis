/**
 * GAP-10 — o validador não pode ser levado a reportar como AUSENTE o que existe.
 *
 * Medido em prod (NVX LastMile, run `18111140`): spec de 12 arquivos / 747.170 chars entrava com
 * `slice(0, 200_000)` e voltou com 4 blockers fantasmas do tipo "9 dos 12 arquivos obrigatórios estão
 * ausentes". Cada teste aqui trava uma condição sem a qual o fantasma volta.
 */
import { describe, it, expect } from "vitest";
import { buildValidationInput, VALIDATION_INPUT_CAP } from "./specValidationInput.js";

const filler = (tag: string, n: number) => `${`${tag} `.repeat(n)}\n`;

function file(path: string, chars: number): { path: string; content: string } {
  const secs = [`# ${path}`, filler("intro", 40), "## 1. Regras", filler("regra", 40), "## 2. Contratos"];
  const head = secs.join("\n");
  const pad = "x".repeat(Math.max(0, chars - head.length));
  return { path, content: `${head}\n${pad}` };
}

describe("buildValidationInput", () => {
  it("spec que cabe: todos integrais, sem regras de recorte no prompt", () => {
    const inp = buildValidationInput([file("a.md", 1_000), file("b.md", 2_000)]);
    expect(inp.outlineOnly).toEqual([]);
    expect(inp.full).toEqual(["a.md", "b.md"]);
    expect(inp.text).toContain("INVENTÁRIO DA SPEC");
    expect(inp.text).not.toContain("REGRAS DESTA VALIDAÇÃO");
    expect(inp.text).toContain("===== a.md =====");
  });

  it("spec grande: o INVENTÁRIO lista TODOS os arquivos, inclusive os que não couberam integrais", () => {
    const files = [file("grande-1.md", 90_000), file("grande-2.md", 90_000), file("grande-3.md", 90_000)];
    const inp = buildValidationInput(files, 120_000);
    expect(inp.outlineOnly.length).toBeGreaterThan(0);
    for (const f of files) expect(inp.text).toContain(`\`${f.path}\``);
    expect(inp.totalChars).toBeGreaterThan(260_000);
  });

  it("o arquivo que não cabe é declarado EXISTENTE e proibido de ser reportado como ausente", () => {
    const inp = buildValidationInput([file("cabe.md", 500), file("nao-cabe.md", 90_000)], 20_000);
    expect(inp.outlineOnly).toContain("nao-cabe.md");
    expect(inp.text).toMatch(/SÓ SUMÁRIO \(arquivo EXISTE, 90\d{3} chars\)/);
    expect(inp.text).toContain("é PROIBIDO reportá-los como ausentes");
    expect(inp.text).toContain("truncados ou não entregues");
  });

  it("do arquivo cortado vai o SUMÁRIO de cabeçalhos (evidência de que a seção existe)", () => {
    const inp = buildValidationInput([file("nao-cabe.md", 90_000)], 20_000);
    expect(inp.text).toContain("## 1. Regras");
    expect(inp.text).toContain("## 2. Contratos");
    expect(inp.text).not.toContain("regra regra regra");
  });

  it("prioriza os MENORES para caber integrais — maximiza quantos arquivos são vistos por inteiro", () => {
    const inp = buildValidationInput(
      [file("gigante.md", 150_000), file("p1.md", 900), file("p2.md", 900), file("p3.md", 900)],
      20_000,
    );
    expect(inp.full.sort()).toEqual(["p1.md", "p2.md", "p3.md"]);
    expect(inp.outlineOnly).toEqual(["gigante.md"]);
  });

  it("o corpo sai na ordem de LEITURA original, não na ordem de tamanho", () => {
    const inp = buildValidationInput([file("z-ultimo.md", 800), file("a-primeiro.md", 900)], 20_000);
    expect(inp.text.indexOf("===== z-ultimo.md")).toBeLessThan(inp.text.indexOf("===== a-primeiro.md"));
  });

  it("respeita o teto (o defeito era justamente mandar mais do que a janela aceita)", () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`f${i}.md`, 60_000));
    const inp = buildValidationInput(files);
    expect(inp.text.length).toBeLessThanOrEqual(VALIDATION_INPUT_CAP + 40);
    expect(inp.totalChars).toBeGreaterThan(700_000);
    expect(inp.text).toContain("INVENTÁRIO DA SPEC — 12 arquivo(s)");
    expect(inp.cap).toBe(VALIDATION_INPUT_CAP); // vai para `stage_b_coverage`: registro interpretável
  });
});

/**
 * 🔴 GAP-18 (rotação de cobertura) — medido em prod 2026-09-06 no NVX LastMile: 12 arquivos /
 * 950.965 chars, e o estágio adversarial julgava **os mesmos 2 arquivos** por inteiro em TODA rodada.
 * Não era aleatório: a promoção "menores primeiro" é determinística, então os grandes (entre eles
 * `modelo-dados.md`, 172.323 chars) nunca eram lidos por um juiz. O laço "convergia" 21 → 14 sobre
 * 2/12 da spec.
 */
describe("buildValidationInput — rotação de cobertura (GAP-18)", () => {
  it("quem AINDA NÃO foi julgado entra na frente, mesmo sendo maior que os já julgados", () => {
    // Mesmo orçamento, mesmos tamanhos: a ÚNICA variável é a marca de julgamento. É isso que prova a
    // rotação — e nada aqui depende de acertar a aritmética exata do teto.
    const grande = file("nunca-visto.md", 9_000);
    const p1 = file("ja-visto-1.md", 900);
    const p2 = file("ja-visto-2.md", 900);

    const semMarca = buildValidationInput([p1, p2, grande], 10_800);
    // Ordem só por tamanho (comportamento legado): os dois pequenos comem o orçamento e o grande
    // fica em sumário — para sempre, porque a escolha é determinística.
    expect(semMarca.full.sort()).toEqual(["ja-visto-1.md", "ja-visto-2.md"]);
    expect(semMarca.outlineOnly).toEqual(["nunca-visto.md"]);

    const comMarca = buildValidationInput(
      [{ ...p1, judged: true }, { ...p2, judged: true }, { ...grande, judged: false }],
      10_800,
    );
    // Com a fila por julgamento o grande NÃO julgado passa à frente e é lido por um juiz.
    expect(comMarca.full).toContain("nunca-visto.md");
    expect(comMarca.outlineOnly.length).toBeGreaterThan(0);
  });

  it("orçamento só para UM: o não julgado vence o já julgado (a cobertura AVANÇA a cada rodada)", () => {
    const files = [
      { ...file("ja-visto.md", 5_000), judged: true },
      { ...file("nunca-visto.md", 5_000), judged: false },
    ];
    const inp = buildValidationInput(files, 6_000);
    expect(inp.full).toEqual(["nunca-visto.md"]);
    expect(inp.outlineOnly).toEqual(["ja-visto.md"]);
  });

  it("sem marca de julgamento (legado/1ª validação) a ordem segue sendo só por tamanho", () => {
    const inp = buildValidationInput([file("g.md", 9_000), file("p.md", 900)], 3_000);
    expect(inp.full).toEqual(["p.md"]);
  });

  it("🔴 arquivo que não cabe NEM SOZINHO é declarado `oversized` — rotação nenhuma o cobre", () => {
    // Sem este fato o laço autônomo revalidaria para sempre esperando uma cobertura impossível.
    const inp = buildValidationInput([file("monstro.md", 300_000), file("p.md", 900)], 50_000);
    expect(inp.oversized).toEqual(["monstro.md"]);
    expect(inp.full).toEqual(["p.md"]);
    expect(inp.outlineOnly).toEqual(["monstro.md"]);
  });

  it("spec que cabe inteira não tem `oversized` nem pendência de cobertura", () => {
    const inp = buildValidationInput([file("a.md", 1_000), file("b.md", 2_000)]);
    expect(inp.oversized).toEqual([]);
    expect(inp.outlineOnly).toEqual([]);
  });

  it("o teto default é maior que os 200k originais (a unidade era chars, a janela é em tokens)", () => {
    // 200.000 chars ≈ 57k tokens de uma janela de ~200k: o validador descartava ~70% da capacidade.
    expect(VALIDATION_INPUT_CAP).toBeGreaterThanOrEqual(400_000);
  });
});

/**
 * GAP-42 — a validação que MEDE um passe do laço autônomo julgava tudo MENOS os arquivos que o passe
 * acabou de escrever, porque "menor primeiro" preteria eternamente os maiores — e os maiores são
 * justamente os que o laço corrige primeiro (mais blockers). Medido em prod na run `5d377da0`.
 */
describe("buildValidationInput — FIFO da medição pendente (GAP-42)", () => {
  // Réplica do caso de prod, em escala: o passe reescreveu o GIGANTE primeiro e depois os pequenos.
  // Todos ficam "não julgados"; a única variável é QUANDO cada um foi escrito.
  const gigante = { ...file("modelo-dados.md", 9_000), judged: false, pendingSince: "2026-09-07T06:04:05Z" };
  const medio = { ...file("privacidade.md", 3_000), judged: false, pendingSince: "2026-09-07T06:02:25Z" };
  const peq1 = { ...file("README.md", 1_200), judged: false, pendingSince: "2026-09-07T06:09:25Z" };
  const peq2 = { ...file("visao.md", 1_200), judged: false, pendingSince: "2026-09-07T06:10:45Z" };

  it("🔴 o gigante escrito ANTES entra na frente dos pequenos escritos DEPOIS", () => {
    // Mesmo orçamento, mesmos tamanhos: a ÚNICA variável são as datas de escrita.
    const cap = 14_000;
    // Sem as datas (comportamento legado) os pequenos comem o orçamento e o gigante fica de fora —
    // é exatamente o que prod fez três validações seguidas, sempre pulando os dois maiores.
    const semData = (f: (typeof gigante)) => ({ path: f.path, content: f.content, judged: f.judged });
    const legado = buildValidationInput([gigante, medio, peq1, peq2].map(semData), cap);
    expect(legado.full).toEqual(["privacidade.md", "README.md", "visao.md"]);
    expect(legado.outlineOnly).toEqual(["modelo-dados.md"]);

    const fifo = buildValidationInput([gigante, medio, peq1, peq2], cap);
    // Escrito às 06:02 e 06:04 ⇒ medidos primeiro. Quem foi escrito às 06:09/06:10 espera a próxima
    // validação — e é o PREÇO declarado do GAP-42: cabem MENOS arquivos (2 em vez de 3), mas os que
    // entram são os que têm trabalho novo dentro esperando medição.
    expect(fifo.full).toEqual(["modelo-dados.md", "privacidade.md"]);
    expect(fifo.outlineOnly).toEqual(["README.md", "visao.md"]);
  });

  it("depois de julgado o arquivo vai para o FIM da fila — a rotação continua (sem inanição)", () => {
    // Mesma spec, agora com os dois primeiros já julgados no conteúdo atual: a vez é dos pequenos.
    const inp = buildValidationInput(
      [{ ...gigante, judged: true }, { ...medio, judged: true }, peq1, peq2],
      6_000,
    );
    expect(inp.full).toEqual(["README.md", "visao.md"]);
    expect(inp.outlineOnly).toEqual(["modelo-dados.md", "privacidade.md"]);
  });

  it("quem tem data de escrita vence quem NÃO tem (não datado é 'não sei', não é 'antigo')", () => {
    const inp = buildValidationInput(
      [{ ...file("sem-data.md", 1_000), judged: false }, { ...file("datado.md", 1_000), judged: false, pendingSince: "2026-09-07T06:00:00Z" }],
      2_600,
    );
    expect(inp.full).toEqual(["datado.md"]);
  });

  it("sem nenhuma data o texto é BYTE-IDÊNTICO ao legado (nada muda para quem não tem histórico)", () => {
    const base = [file("g.md", 9_000), file("p.md", 900)].map((f) => ({ ...f, judged: false }));
    const a = buildValidationInput(base, 3_000);
    const b = buildValidationInput(base.map((f) => ({ ...f, pendingSince: null })), 3_000);
    expect(b.text).toBe(a.text);
    expect(b.full).toEqual(a.full);
  });

  it("`pendingSince` NÃO fura a fila do julgamento: já julgado continua atrás do não julgado", () => {
    // O arquivo já julgado tem a escrita mais antiga de todas — e ainda assim perde, porque a 1ª fila
    // é "ninguém julgou este conteúdo". Inverter isso congelaria a cobertura.
    const inp = buildValidationInput(
      [
        { ...file("ja-visto.md", 5_000), judged: true, pendingSince: "2026-09-01T00:00:00Z" },
        { ...file("nunca-visto.md", 5_000), judged: false, pendingSince: "2026-09-07T00:00:00Z" },
      ],
      6_000,
    );
    expect(inp.full).toEqual(["nunca-visto.md"]);
  });
});
