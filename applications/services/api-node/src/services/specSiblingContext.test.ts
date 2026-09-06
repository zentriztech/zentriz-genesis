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
import { buildSiblingContext, disputedTerms, SIBLING_FILE_BUDGET, type SiblingRef } from "./specSiblingContext.js";
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
