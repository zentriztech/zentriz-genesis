/**
 * A5.5 — o bloco de irmãos CITADOS pelos GAPs.
 *
 * O que estes testes protegem é o defeito medido em prod: sem o irmão à vista, o CTO-editor escolhia
 * um lado da contradição e a divergência MIGRAVA para o outro arquivo (20 → 24 GAPs). Então cada
 * teste amarra uma propriedade que, se quebrar, faz o laço voltar a andar de lado ou a estourar custo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSiblingContext, disputedTerms, siblingPathsIn, siblingBodiesIn, SIBLING_FILE_BUDGET,
  type SiblingRef,
} from "./specSiblingContext.js";
import type { ValidationFinding } from "./specValidation.js";

let root = "";
const files: SiblingRef[] = [];

function ref(p: string, isPrimary = false): SiblingRef {
  return { path: p, filename: path.basename(p), filePath: path.join(root, p), isPrimary };
}

async function put(p: string, content: string): Promise<void> {
  const full = path.join(root, p);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

function gap(title: string, rationale: string): ValidationFinding {
  return { severity: "blocker", title, rationale } as unknown as ValidationFinding;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sibling-ctx-"));
  files.push(ref("nvx-lastmile-backend.md", true), ref("api-entregas-entregadores.md"), ref("definicao-de-pronto.md"), ref("tecnico/modelo-dados.md"));
  await put("nvx-lastmile-backend.md", "# Índice\n\nEste é o índice da spec.");
  await put("api-entregas-entregadores.md", "# API\n\nErro de validação devolve 422.");
  await put("definicao-de-pronto.md", "# DoD\n\nErro de validação devolve 400.");
  await put("tecnico/modelo-dados.md", "# Modelo\n\nCampo `status` é enum.");
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("buildSiblingContext — seleção por citação", () => {
  it("inclui o irmão que o GAP cita pelo nome e NUNCA o arquivo alvo", async () => {
    const ctx = await buildSiblingContext(
      files,
      "definicao-de-pronto.md",
      [gap("Status HTTP divergente", "Este arquivo diz 400 mas api-entregas-entregadores.md diz 422.")],
    );
    expect(ctx.used).toContain("api-entregas-entregadores.md");
    expect(ctx.used).not.toContain("definicao-de-pronto.md");
    expect(ctx.block).toContain("Erro de validação devolve 422.");
    expect(ctx.block).not.toContain("Erro de validação devolve 400.");
  });

  it("casa citação por caminho relativo (`tecnico/modelo-dados.md`) e por nome puro", async () => {
    const byPath = await buildSiblingContext(files, "definicao-de-pronto.md", [gap("x", "ver tecnico/modelo-dados.md")]);
    expect(byPath.used[0]).toBe("tecnico/modelo-dados.md");
    const byName = await buildSiblingContext(files, "definicao-de-pronto.md", [gap("x", "ver modelo-dados.md")]);
    expect(byName.used[0]).toBe("tecnico/modelo-dados.md");
  });

  it("ordena pelo mais citado — é o arquivo que o GAP realmente discute", async () => {
    const ctx = await buildSiblingContext(files, "definicao-de-pronto.md", [
      gap("a", "tecnico/modelo-dados.md e api-entregas-entregadores.md"),
      gap("b", "api-entregas-entregadores.md de novo"),
    ]);
    expect(ctx.used[0]).toBe("api-entregas-entregadores.md");
  });

  it("o índice primário entra por último (situa, não normatiza) mesmo sem ser citado", async () => {
    const ctx = await buildSiblingContext(files, "definicao-de-pronto.md", [gap("x", "ver api-entregas-entregadores.md")]);
    expect(ctx.used).toEqual(["api-entregas-entregadores.md", "nvx-lastmile-backend.md"]);
  });

  it("sem citação nenhuma, sobra só o índice — não despeja a spec inteira no prompt", async () => {
    const ctx = await buildSiblingContext(files, "definicao-de-pronto.md", [gap("x", "falta critério de aceite")]);
    expect(ctx.used).toEqual(["nvx-lastmile-backend.md"]);
  });

  it("editando o próprio índice, sem citação, não há irmão a mostrar", async () => {
    const ctx = await buildSiblingContext(files, "nvx-lastmile-backend.md", [gap("x", "falta critério")]);
    expect(ctx.used).toEqual([]);
    expect(ctx.block).toBe("");
  });

  it("arquivo citado que não existe no disco não derruba a rodada", async () => {
    const ghost: SiblingRef[] = [...files, ref("sumiu.md")];
    const ctx = await buildSiblingContext(ghost, "definicao-de-pronto.md", [gap("x", "ver sumiu.md")]);
    expect(ctx.used).not.toContain("sumiu.md");
    expect(ctx.block).toContain("IRMÃO SÓ LEITURA");
  });
});

describe("buildSiblingContext — orçamento", () => {
  it("irmão gigante SEM termo em disputa cai no head-truncate, COM aviso", async () => {
    await put("gigante.md", `# G\n${"y".repeat(SIBLING_FILE_BUDGET + 5_000)}`);
    const ctx = await buildSiblingContext([...files, ref("gigante.md")], "definicao-de-pronto.md", [gap("x", "ver gigante.md")]);
    expect(ctx.used).toContain("gigante.md");
    expect(ctx.block).toContain("truncado aqui");
    expect(ctx.block).toContain("NÃO significa que ele não exista");
  });

  it("o que não cabe no orçamento total é OMITIDO e declarado no bloco", async () => {
    const ctx = await buildSiblingContext(
      files,
      "definicao-de-pronto.md",
      [gap("x", "api-entregas-entregadores.md e tecnico/modelo-dados.md")],
      { totalBudget: 40 },
    );
    expect(ctx.used.length).toBe(1);
    expect(ctx.omitted.length).toBeGreaterThan(0);
    expect(ctx.block).toContain("não couberam nesta rodada");
  });
});

/**
 * A5.6 — o recorte dirigido. Medido no run `75b3cf5d` (o que provou o A5.5): com irmãos de ~20k, o
 * head-truncate só deixava 2 entrarem e gastava o orçamento no COMEÇO do arquivo, que raramente é
 * onde mora a regra contestada. Estes testes amarram as duas propriedades que fazem o recorte valer:
 * mostrar a seção que discute o termo em disputa e NUNCA deixar o modelo achar que o irmão silencia.
 */
describe("disputedTerms", () => {
  it("extrai identificadores em backticks, códigos em CAIXA_ALTA e números de status", () => {
    const t = disputedTerms([gap("Status HTTP divergente: 422 vs 400", "O campo `status_entrega` e o erro VALIDATION_ERROR conflitam.")]);
    expect(t).toContain("status_entrega");
    expect(t).toContain("validation_error");
    expect(t).toContain("422");
    expect(t).toContain("400");
  });
  it("não confunde palavra comum com termo (nada de 'de', 'e', 'HTTP' solto virar filtro inútil)", () => {
    const t = disputedTerms([gap("falta critério", "sem detalhe")]);
    expect(t).toEqual([]);
  });
});

describe("buildSiblingContext — A5.6 resumo dirigido", () => {
  /** Enchimento IDENTIFICÁVEL por seção — é como se distingue o que entrou do que ficou de fora. */
  const filler = (tag: string, n: number) => `${`${tag} `.repeat(n)}\n`;

  beforeAll(async () => {
    await put("contratos-erros.md", [
      "# Contratos de erro",
      filler("abertura", 900),
      "## Códigos de estado",
      "Toda falha de validação devolve 422 UNPROCESSABLE_ENTITY com corpo `{code, message}`.",
      filler("codigos", 100),
      "## Paginação",
      filler("paginacao", 900),
      "## Idempotência",
      filler("idempotencia", 900),
    ].join("\n"));
  });

  it("a seção que discute o termo em disputa entra, mesmo estando no MEIO de um arquivo grande", async () => {
    const ctx = await buildSiblingContext(
      [...files, ref("contratos-erros.md")],
      "definicao-de-pronto.md",
      [gap("Status HTTP divergente: 400 vs 422", "contratos-erros.md especifica outro código para `VALIDATION_ERROR`.")],
    );
    expect(ctx.used).toContain("contratos-erros.md");
    expect(ctx.block).toContain("RESUMO DIRIGIDO");
    expect(ctx.block).toContain("422 UNPROCESSABLE_ENTITY");
    // O sumário lista o que existe — inclusive o que NÃO foi transcrito.
    expect(ctx.block).toContain("## Paginação");
    // …e as seções irrelevantes não gastam orçamento com o CORPO delas.
    expect(ctx.block).not.toContain("paginacao paginacao");
    expect(ctx.block).not.toContain("idempotencia idempotencia");
    expect(ctx.block).not.toContain("abertura abertura");
  });

  it("avisa que uma regra pode viver em seção não transcrita (senão o editor duplica a regra aqui)", async () => {
    const ctx = await buildSiblingContext(
      [...files, ref("contratos-erros.md")],
      "definicao-de-pronto.md",
      [gap("422 vs 400", "ver contratos-erros.md")],
    );
    expect(ctx.block).toContain("não conclua que o irmão silencia");
    expect(ctx.block).toContain("SUMÁRIO DE SEÇÕES");
  });

  it("o resumo é MUITO menor que o head-truncate — é o que faz caber mais de um irmão citado", async () => {
    const alvo = [gap("422 vs 400", "ver contratos-erros.md e modelo-dados.md")];
    const ctx = await buildSiblingContext([...files, ref("contratos-erros.md")], "definicao-de-pronto.md", alvo);
    expect(ctx.block.length).toBeLessThan(SIBLING_FILE_BUDGET);
    expect(ctx.omitted).toEqual([]);
    expect(ctx.used).toContain("contratos-erros.md");
    expect(ctx.used).toContain("tecnico/modelo-dados.md");
  });

  it("irmão pequeno continua indo INTEIRO (recortar arquivo curto só cria risco de omitir a regra)", async () => {
    const ctx = await buildSiblingContext(files, "definicao-de-pronto.md", [gap("422 vs 400", "ver api-entregas-entregadores.md")]);
    expect(ctx.block).toContain("Erro de validação devolve 422.");
    expect(ctx.block).not.toContain("RESUMO DIRIGIDO");
  });
});

/**
 * 🔴 GAP-75 — a seção do irmão que o GAP cita POR NÚMERO não chegava ao prompt.
 *
 * Medido em prod (validação `9edcb54e`, NVX LastMile): **14 dos 20 GAPs são cross-file** e, das 11
 * seções de irmão citadas com `§`, **só 5 chegavam** — as ausentes tinham 127, 1.069, 2.061, 2.854 e
 * 3.214 chars, com o bloco em 49k de 60k. Ou seja: ORDEM, não orçamento, exatamente o defeito que o
 * GAP-72/73 corrigiu no lado do ALVO e que continuava intacto no lado do IRMÃO. Uma seção decisiva de
 * 127 chars perdia para a seção genérica que menciona tudo — e sem ela o agente só pode delegar a regra
 * ("a forma é do arquivo X"), que é a errata do GAP-71 com outro nome e não fecha GAP nenhum.
 *
 * Cada teste abaixo trava uma parte da reserva. O fixture é desenhado para REPROVAR o algoritmo
 * anterior: a seção citada não contém NENHUM termo em disputa, logo a relevância a pontuava com zero e
 * ela nunca era escolhida — verificado desligando a reserva.
 */
describe("buildSiblingContext — seção do irmão citada pelos GAPs (GAP-75)", () => {
  const filler = (tag: string, n: number) => `${`${tag} `.repeat(n)}\n`;
  const linhas = (tag: string, n: number) =>
    Array.from({ length: n }, (_, k) => `${tag} linha ${k}: ${"detalhe ".repeat(6)}`).join("\n");

  beforeAll(async () => {
    await put("retencao-irmao.md", [
      "# Retenção e expurgo",
      "## Convenções gerais",
      // Superset dos termos em disputa: é a seção que a relevância premia (a patologia de prod).
      `Aqui aparecem todos: \`retention_job\` e \`refresh_tokens\`. ${filler("generico", 900)}`,
      // A seção CITADA. Minúscula e sem NENHUM termo em disputa — pela relevância vale zero.
      "### 4. Variáveis de Ambiente",
      "A coluna 'default' desta tabela é a fonte declarada do prazo.",
      "## 99. Apêndice",
      filler("cauda", 400),
    ].join("\n"));
    // Quatro seções citadas que, somadas, não cabem no teto por irmão: a última entra em JANELA.
    await put("citadas-grandes.md", [
      "# Muitas citadas",
      "### 31. Primeira",
      linhas("um", 60),
      "O `retention_job` roda de madrugada nesta etapa.",
      "### 32. Segunda",
      linhas("dois", 62),
      "O `retention_job` também é citado aqui.",
      "### 33. Terceira",
      linhas("tres", 64),
      "O `retention_job` aparece na terceira.",
      "### 34. Quarta",
      linhas("quatro", 66),
      "O `retention_job` fecha o ciclo na quarta.",
    ].join("\n"));
  });

  it("a seção citada do irmão entra mesmo sem conter nenhum termo em disputa", async () => {
    const ctx = await buildSiblingContext([...files, ref("retencao-irmao.md")], "definicao-de-pronto.md", [
      gap("Default de retenção divergente", "O prazo default vem de `retencao-irmao.md` §4, mas o `retention_job` usa outro."),
    ]);
    expect(ctx.used).toContain("retencao-irmao.md");
    expect(ctx.block).toContain("RESUMO DIRIGIDO");
    // No algoritmo anterior esta linha NUNCA aparecia: a seção tem zero acertos de relevância.
    expect(ctx.block).toContain("A coluna 'default' desta tabela é a fonte declarada do prazo.");
    expect(ctx.citedUsed).toEqual(["retencao-irmao.md §4"]);
    expect(ctx.citedDropped).toEqual([]);
    expect(ctx.citedWindowed).toEqual([]);
  });

  it("citação que nomeia o ARQUIVO ALVO não puxa a seção homônima do irmão", async () => {
    const ctx = await buildSiblingContext([...files, ref("retencao-irmao.md")], "definicao-de-pronto.md", [
      // O `§4` aqui é do próprio alvo (quem cuida dele é o GAP-73); o irmão entra por citação do nome.
      gap("Prazo", "O default de `definicao-de-pronto.md` §4 conflita com o `retention_job` de retencao-irmao.md."),
    ]);
    expect(ctx.used).toContain("retencao-irmao.md");
    expect(ctx.citedUsed).toEqual([]);
    expect(ctx.block).not.toContain("A coluna 'default' desta tabela é a fonte declarada do prazo.");
  });

  it("citada que não cabe inteira vem em JANELA verbatim, com o salto marcado", async () => {
    const ctx = await buildSiblingContext([...files, ref("citadas-grandes.md")], "definicao-de-pronto.md", [
      gap("Ciclo do job", "O `retention_job` é descrito em citadas-grandes.md §31, §32, §33 e §34 de formas diferentes."),
    ]);
    expect(ctx.citedUsed).toHaveLength(4);
    expect(ctx.citedWindowed).toEqual(["citadas-grandes.md §34"]);
    expect(ctx.citedDropped).toEqual([]);
    expect(ctx.block).toContain("[… trecho omitido da mesma seção …]");
    // O literal da seção janelada chega verbatim — é o que permite ao agente citá-lo sem inventar.
    expect(ctx.block).toContain("O `retention_job` fecha o ciclo na quarta.");
    // …e a janela não trouxe a seção inteira.
    expect(ctx.block).not.toContain("quatro linha 0:");
  });

  it("citada que o código não localiza é DECLARADA (nunca omitida em silêncio)", async () => {
    const ctx = await buildSiblingContext([...files, ref("retencao-irmao.md")], "definicao-de-pronto.md", [
      gap("Prazo", "O `retention_job` está em `retencao-irmao.md` §77.7, que ninguém escreveu."),
    ]);
    expect(ctx.citedDropped).toEqual(["retencao-irmao.md §77.7"]);
    expect(ctx.citedUsed).toEqual([]);
    expect(ctx.block).toContain("NÃO foi/foram");
    expect(ctx.block).toContain("não afirme o que ele diz");
  });

  it("irmão que nem entrou no orçamento total leva as citações dele para FORA, declaradas", async () => {
    const ctx = await buildSiblingContext(
      [...files, ref("retencao-irmao.md")],
      "definicao-de-pronto.md",
      [gap("Prazo", "api-entregas-entregadores.md e `retencao-irmao.md` §4 divergem sobre `retention_job`.")],
      { totalBudget: 200 },
    );
    expect(ctx.omitted).toContain("retencao-irmao.md");
    // Sem isto o log contaria como coberta uma citação que nunca chegou ao prompt.
    expect(ctx.citedDropped).toContain("retencao-irmao.md §4");
    expect(ctx.citedUsed).toEqual([]);
  });
});

// 🔴 GAP-160: a árvore da spec declara "o texto destes N arquivos NÃO está neste prompt". Essa
// afirmação é montada a partir do que `siblingPathsIn` extrai do bloco — então o extrator e o
// cabeçalho que `buildSiblingContext` escreve têm de ser a MESMA verdade. Se divergirem, o prompt
// passa a mentir sobre si mesmo: diria que um irmão presente está ausente (ou o contrário).
describe("siblingPathsIn — ida e volta com o bloco REAL", () => {
  it("extrai exatamente os paths cujos corpos entraram no bloco", async () => {
    const ctx = await buildSiblingContext(
      files, "definicao-de-pronto.md",
      [gap("Contradição de status", "`api-entregas-entregadores.md` diz 422 e aqui 400; ver tecnico/modelo-dados.md")],
    );
    expect(siblingPathsIn(ctx.block).sort()).toEqual([...ctx.used].sort());
  });

  it("bloco vazio não nomeia ninguém (ausência de irmão ≠ irmão presente)", () => {
    expect(siblingPathsIn("")).toEqual([]);
    expect(siblingPathsIn("texto qualquer sem cabeçalho de irmão")).toEqual([]);
  });

  it("o primário entra com o rótulo de índice e ainda assim é extraível", async () => {
    const ctx = await buildSiblingContext(files, "tecnico/modelo-dados.md", [gap("x", "y")]);
    expect(ctx.used).toContain("nvx-lastmile-backend.md");
    expect(ctx.block).toContain("(índice da spec)");
    expect(siblingPathsIn(ctx.block)).toContain("nvx-lastmile-backend.md");
  });
});

/**
 * 🔴 GAP-168 — "o irmão veio" ≠ "o TEXTO do irmão veio".
 *
 * Medido em prod (`prompt_census`, 87 chamadas de `api-gapfile`): `SIBLING_FILE_FULL_MAX` é 8.000 chars
 * e os 11 arquivos da spec do NVX têm 51k–106k ⇒ **nenhum irmão do laço vai integral**. Ainda assim a
 * árvore da spec (que lê `siblingPathsIn`) escrevia `corpo presente neste prompt` para todos eles, e o
 * bloco de irmãos, alguns milhares de chars depois, se declarava resumo: o prompt do escritor se
 * contradizia sobre o próprio conteúdo.
 *
 * Estes testes pinam as três coisas que fariam a distinção mentir: recorte passando por integral,
 * integral passando por recorte, e o cabeçalho divergindo do extrator (que é o par que o GAP-160 já
 * exigia ser a MESMA verdade).
 */
describe("siblingBodiesIn — GAP-168: integralidade do corpo entregue", () => {
  it("irmão pequeno vai INTEGRAL e o cabeçalho não fala de recorte", async () => {
    const ctx = await buildSiblingContext(
      files, "definicao-de-pronto.md",
      [gap("Status HTTP divergente", "aqui 400 e `api-entregas-entregadores.md` diz 422")],
    );
    const corpos = siblingBodiesIn(ctx.block);
    expect(corpos.every((b) => b.integral)).toBe(true);
    expect(ctx.partialBodies).toEqual([]);
    expect(ctx.block).not.toContain("RECORTE (o arquivo tem");
  });

  it("🔴 irmão grande vem RECORTADO e isso é declarado no CABEÇALHO, não só no corpo", async () => {
    // 90k chars é a ordem de grandeza REAL dos arquivos da spec medida em prod.
    await put("grande-irmao.md", `# Grande\n## 1 Erros\nErro de validação devolve 422.\n${"z".repeat(90_000)}`);
    const ctx = await buildSiblingContext(
      [...files, ref("grande-irmao.md")], "definicao-de-pronto.md",
      [gap("Status HTTP divergente", "aqui 400 e `grande-irmao.md` diz 422")],
    );
    expect(ctx.used).toContain("grande-irmao.md");
    expect(ctx.partialBodies).toContain("grande-irmao.md");
    const g = siblingBodiesIn(ctx.block).find((b) => b.path === "grande-irmao.md");
    expect(g).toEqual({ path: "grande-irmao.md", integral: false });
    // O tamanho REAL do arquivo vai no cabeçalho: é o que separa "recorte" de "arquivo pequeno".
    expect(ctx.block).toMatch(/RECORTE \(o arquivo tem \d{5,} chars; abaixo NÃO é o texto integral\)/);
  });

  it("`siblingPathsIn` continua devolvendo TODOS os corpos (integrais e recortados)", async () => {
    await put("grande-irmao.md", `# Grande\n## 1 Erros\n422 aqui.\n${"z".repeat(90_000)}`);
    const ctx = await buildSiblingContext(
      [...files, ref("grande-irmao.md")], "definicao-de-pronto.md",
      [gap("x", "ver `grande-irmao.md` e `api-entregas-entregadores.md`")],
    );
    // A ida-e-volta do GAP-160 não pode regredir: quem veio recortado ESTÁ no prompt e não pode ser
    // declarado ausente — só não pode ser declarado integral.
    expect(siblingPathsIn(ctx.block).sort()).toEqual([...ctx.used].sort());
    expect(ctx.partialBodies.every((p) => ctx.used.includes(p))).toBe(true);
  });

  it("cabeçalho de primário recortado leva os DOIS rótulos, e o path segue extraível", async () => {
    await put("indice-grande.md", `# Índice\n## 1 Visão\ntexto\n${"w".repeat(90_000)}`);
    const ctx = await buildSiblingContext(
      [ref("indice-grande.md", true), ref("definicao-de-pronto.md")], "definicao-de-pronto.md",
      [gap("x", "ver `indice-grande.md`")],
    );
    expect(ctx.block).toContain("(índice da spec) — RECORTE (o arquivo tem");
    expect(siblingBodiesIn(ctx.block)).toEqual([{ path: "indice-grande.md", integral: false }]);
  });
});
