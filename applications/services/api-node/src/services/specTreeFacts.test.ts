/**
 * 🔴 GAP-160 — testes da ÁRVORE DA SPEC como fato do prompt.
 *
 * O que estes testes protegem é o que faz o fato ser fato:
 *
 *   1. **todos** os arquivos são nomeados (o defeito medido era nomear 2 de 13);
 *   2. a AUSÊNCIA de corpo é declarada — trocar "não sabe que o irmão existe" por "acha que já leu o
 *      irmão" seria pior que o defeito original;
 *   3. arquivo ilegível continua na lista (some da lista ⇒ o agente conclui que não existe);
 *   4. nada de FORMA é prescrito (Lei: a estrutura é decisão do agente; o código transporta o fato).
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  firstHeading, loadSpecTree, specTreeFactBlock, deadRemissions, deadRemissionFactBlock,
  DEAD_REMISSION_MAX, TREE_OUTLINE_FILE_BUDGET, TREE_OUTLINE_TOTAL_BUDGET,
  type SpecTreeEntry,
} from "./specTreeFacts.js";
import type { SpecFileRef } from "./specGapScope.js";

const E = (over: Partial<SpecTreeEntry> = {}): SpecTreeEntry => ({
  path: "a.md", bytes: 1_000, title: "A", isPrimary: false, isManifest: false, outline: null, ...over,
});

describe("firstHeading", () => {
  it("acha o H1 depois do frontmatter YAML", () => {
    expect(firstHeading("---\narchetype: backend_api\ntitle: x\n---\n\n# Modelo de Dados\n\ntexto")).toBe("Modelo de Dados");
  });
  it("sem H1 devolve null (não inventa título a partir de outra coisa)", () => {
    expect(firstHeading("## só subtítulo\ntexto")).toBeNull();
    expect(firstHeading("")).toBeNull();
  });
  it("ignora `#hashtag` sem espaço — não é heading Markdown", () => {
    expect(firstHeading("#naoEhTitulo\n# Este é\n")).toBe("Este é");
  });
});

describe("specTreeFactBlock", () => {
  const arvore = [
    E({ path: "nvx.md", title: "NVX LastMile", isPrimary: true, bytes: 96_000 }),
    E({ path: "README.md", title: "Manifesto", isManifest: true, bytes: 85_400 }),
    E({ path: "autenticacao-sessao.md", title: "Autenticação", bytes: 116_000 }),
    E({ path: "privacidade-lgpd.md", title: "LGPD", bytes: 90_500 }),
  ];

  it("nomeia TODOS os arquivos da spec — era 2 de 13 no prompt medido em prod", () => {
    const b = specTreeFactBlock(arvore, "autenticacao-sessao.md");
    for (const e of arvore) expect(b, `${e.path} tem de ser nomeável`).toContain(e.path);
  });

  it("marca o alvo, o manifesto e o primário — papéis diferentes, fatos diferentes", () => {
    const b = specTreeFactBlock(arvore, "autenticacao-sessao.md");
    const linha = (p: string) => b.split("\n").find((l) => l.includes(p)) ?? "";
    expect(linha("autenticacao-sessao.md")).toContain("ESTE é o arquivo que você edita agora");
    expect(linha("README.md")).toContain("manifesto");
    expect(linha("nvx.md")).toContain("primário");
    // O alvo não pode aparecer como ausente: ele vai INTEIRO no prompt, por construção.
    expect(linha("autenticacao-sessao.md")).not.toContain("corpo presente");
  });

  it("declara QUAIS corpos não estão no prompt (a ausência é metade do fato)", () => {
    const b = specTreeFactBlock(arvore, "autenticacao-sessao.md", ["nvx.md"]);
    expect(b).toContain("o TEXTO de 2 destes arquivos NÃO está neste prompt");
    expect(b).toContain("README.md");
    expect(b).toContain("privacidade-lgpd.md");
    expect(b.split("\n").find((l) => l.includes("nvx.md"))).toContain("corpo presente neste prompt");
  });

  it("sem nenhum irmão entregue, a ausência cobre a spec toda menos o alvo", () => {
    const b = specTreeFactBlock(arvore, "autenticacao-sessao.md");
    expect(b).toContain("o TEXTO de 3 destes arquivos NÃO está neste prompt");
  });

  it("proíbe a conclusão que o silêncio induzia — 'não está especificado' por ausência de corpo", () => {
    const b = specTreeFactBlock(arvore, "autenticacao-sessao.md");
    expect(b).toContain("não está especificado");
    expect(b).toContain("registre a dependência");
  });

  it("arquivo sem tamanho medido continua na lista, declarado como não medido", () => {
    const b = specTreeFactBlock([...arvore, E({ path: "quebrado.md", bytes: null, title: null })], "README.md");
    expect(b).toContain("quebrado.md");
    expect(b).toContain("tamanho não medido");
  });

  it("spec de arquivo único não tem árvore a informar", () => {
    expect(specTreeFactBlock([E()], "a.md")).toBe("");
    expect(specTreeFactBlock([], "a.md")).toBe("");
  });

  it("não prescreve FORMA (a estrutura da spec é decisão do agente — Lei 100% LLM)", () => {
    const b = specTreeFactBlock(arvore, "autenticacao-sessao.md").toLowerCase();
    for (const proibido of ["use uma tabela", "crie uma seção", "renomeie", "mova o arquivo"]) {
      expect(b).not.toContain(proibido);
    }
  });

  it("o tamanho é declarado em BYTES (é o que `stat` mede; chamar de chars seria mentir)", () => {
    expect(specTreeFactBlock(arvore, "README.md")).toContain("96k bytes");
  });
});

// 🔴 GAP-161 — o sumário de cabeçalhos dos irmãos AUSENTES. O que estes testes protegem:
//   1. só entra sumário de quem NÃO teve corpo entregue (mandar o do alvo é pagar duas vezes);
//   2. o que não cabe é DECLARADO (sumário ausente ≠ arquivo sem estrutura);
//   3. o corte de um sumário é marcado (senão o agente supõe que o arquivo acaba ali);
//   4. o bloco diz que o cabeçalho é ENDEREÇO, não conteúdo lido — a mentira mais fácil aqui.
describe("specTreeFactBlock — GAP-161: sumário de seções dos ausentes", () => {
  const outline = (n: number, tag = "S") =>
    Array.from({ length: n }, (_, i) => `## ${tag}${i + 1}. seção número ${i + 1}`).join("\n");
  const arvore = [
    E({ path: "alvo.md", title: "Alvo", outline: outline(3, "A") }),
    E({ path: "irmao-presente.md", title: "Presente", outline: outline(3, "P") }),
    E({ path: "irmao-ausente.md", title: "Ausente", outline: outline(4, "X") }),
    E({ path: "connect.yaml", title: null, outline: null, bytes: 9_778 }),
  ];

  it("manda o sumário do AUSENTE e não o do alvo nem o do irmão cujo corpo veio", () => {
    const b = specTreeFactBlock(arvore, "alvo.md", ["irmao-presente.md"]);
    expect(b).toContain("SUMÁRIO DE SEÇÕES");
    expect(b).toContain("X1. seção número 1");
    expect(b).not.toContain("A1. seção número 1");
    expect(b).not.toContain("P1. seção número 1");
  });

  it("declara quantos sumários vieram de quantos ausentes (a fração é o fato)", () => {
    const b = specTreeFactBlock(arvore, "alvo.md", ["irmao-presente.md"]);
    // ausentes = irmao-ausente.md + connect.yaml; só o `.md` tem sumário.
    expect(b).toContain("cujo texto NÃO veio (1 de 2)");
  });

  it("arquivo sem sumário (não-Markdown) não inventa seção nenhuma", () => {
    const b = specTreeFactBlock([E({ path: "a.md", outline: outline(2) }), E({ path: "connect.yaml", outline: null })], "a.md");
    expect(b).not.toContain("SUMÁRIO DE SEÇÕES");
  });

  it("sumário grande vem CORTADO com a marca — sem ela o agente supõe que o arquivo acaba ali", () => {
    const gigante = E({ path: "gigante.md", outline: outline(400, "G") });
    const b = specTreeFactBlock([E({ path: "alvo.md" }), gigante], "alvo.md");
    expect(b).toContain("sumário truncado por orçamento");
    expect(b.length).toBeLessThan(TREE_OUTLINE_FILE_BUDGET + 3_000);
  });

  it("o que não cabe no orçamento TOTAL é declarado por nome, como falta de orçamento", () => {
    // Cada sumário ~3,4k depois do teto por arquivo; 12 deles estouram os 24k do orçamento total.
    const muitos = Array.from({ length: 12 }, (_, i) => E({ path: `f${i}.md`, outline: outline(400, `T${i}`) }));
    const b = specTreeFactBlock([E({ path: "alvo.md" }), ...muitos], "alvo.md");
    expect(b).toMatch(/\[\d+ sumário\(s\) não couberam no orçamento desta chamada:/);
    expect(b).toContain("a ausência é de orçamento, não de conteúdo");
  });

  it("diz que o cabeçalho é ENDEREÇO — nunca que o conteúdo da seção foi lido", () => {
    const b = specTreeFactBlock(arvore, "alvo.md");
    expect(b).toContain("o cabeçalho é o endereço");
    expect(b).toContain("o que ele diz, você não viu");
    expect(b.toLowerCase()).not.toContain("você já leu");
  });

  it("respeita o orçamento total declarado (o teto é o contrato, não uma intenção)", () => {
    const muitos = Array.from({ length: 40 }, (_, i) => E({ path: `f${i}.md`, outline: outline(120, `T${i}`) }));
    const b = specTreeFactBlock([E({ path: "alvo.md" }), ...muitos], "alvo.md");
    expect(b.length).toBeLessThan(TREE_OUTLINE_TOTAL_BUDGET + 8_000);
  });
});

describe("loadSpecTree (disco real)", () => {
  const ref = (dir: string, name: string, isPrimary = false): SpecFileRef => ({
    path: name, filename: name, relDir: "", filePath: join(dir, name), isPrimary,
  });

  it("mede tamanho e título lendo só a CABEÇA do arquivo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-tree-"));
    await writeFile(join(dir, "a.md"), `---\narchetype: backend_api\n---\n\n# Título de A\n\n${"x".repeat(50_000)}`);
    await writeFile(join(dir, "b.md"), "# B\ntexto");
    const t = await loadSpecTree([ref(dir, "a.md", true), ref(dir, "b.md")]);
    expect(t[0]).toMatchObject({ path: "a.md", title: "Título de A", isPrimary: true });
    expect(t[0].bytes).toBeGreaterThan(50_000);
    expect(t[1]).toMatchObject({ path: "b.md", title: "B", bytes: "# B\ntexto".length });
  });

  it("arquivo INEXISTENTE entra na árvore sem tamanho e sem título (não pode desaparecer)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-tree-"));
    await writeFile(join(dir, "existe.md"), "# Existe\n");
    const t = await loadSpecTree([ref(dir, "existe.md"), ref(dir, "sumiu.md")]);
    expect(t).toHaveLength(2);
    expect(t[1]).toMatchObject({ path: "sumiu.md", bytes: null, title: null });
  });

  it("reconhece o manifesto pelo nome, venha ele com caminho ou sem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-tree-"));
    await writeFile(join(dir, "README.md"), "# Manifesto\n");
    await writeFile(join(dir, "outro.md"), "# Outro\n");
    const t = await loadSpecTree([ref(dir, "README.md"), ref(dir, "outro.md")]);
    expect(t[0].isManifest).toBe(true);
    expect(t[1].isManifest).toBe(false);
  });

  it("diretório sem permissão de leitura não derruba a medição dos demais", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-tree-"));
    await writeFile(join(dir, "ok.md"), "# OK\n");
    const trancado = join(dir, "trancado.md");
    await writeFile(trancado, "# Trancado\n");
    await chmod(trancado, 0o000);
    const t = await loadSpecTree([ref(dir, "ok.md"), ref(dir, "trancado.md")]);
    await chmod(trancado, 0o600);
    expect(t[0].title).toBe("OK");
    expect(t).toHaveLength(2);
    expect(t[1].path).toBe("trancado.md");
  });
});

/**
 * 🔴 GAP-163 — remissão morta. O que estes testes travam:
 *   1. só acusa o que a régua REALMENTE não localizou (acusar por não ter lido mandaria reescrever o que
 *      está certo);
 *   2. a régua é a de CORPO — a de cabeçalho daria 7 falso-positivos em 13 na spec medida;
 *   3. citação sem nome de arquivo é do PRÓPRIO arquivo, não é remissão;
 *   4. o bloco declara que é medição, não veredicto (Lei 100% LLM: quem decide é o agente).
 */
describe("deadRemissions / deadRemissionFactBlock (GAP-163)", () => {
  const ref = (dir: string, name: string): SpecFileRef => ({
    path: name, filename: name, relDir: "", filePath: join(dir, name), isPrimary: false,
  });

  const cenario = async (alvoTexto: string, destinoTexto: string) => {
    const dir = await mkdtemp(join(tmpdir(), "spec-dead-"));
    await writeFile(join(dir, "alvo.md"), alvoTexto);
    await writeFile(join(dir, "destino.md"), destinoTexto);
    return { dir, files: [ref(dir, "alvo.md"), ref(dir, "destino.md")] };
  };

  it("acusa o endereço que não existe no destino e cala sobre o que existe", async () => {
    const { files } = await cenario(
      "# Alvo\nVer `destino.md` §7.4 e também `destino.md` §2.1.",
      "# Destino\n## 2.1 Existe\ncorpo\n## 3 Outra\ncorpo",
    );
    expect(await deadRemissions(files, "alvo.md")).toEqual([{ ref: "§7.4", toPath: "destino.md" }]);
  });

  it("usa a régua de CORPO: endereço fora do cabeçalho, mas presente no texto, NÃO é morto", async () => {
    // Medido em prod: a régua de cabeçalho acusaria 13 e 7 seriam falso positivo (este é o padrão deles).
    const { files } = await cenario(
      "# Alvo\nConforme `destino.md` §2.3.",
      "# Destino\n## Regras de anonimização\nA regra §2.3 diz que o dado sai do log.",
    );
    expect(await deadRemissions(files, "alvo.md")).toEqual([]);
  });

  it("citação sem nome de arquivo é do próprio arquivo — não é remissão", async () => {
    const { files } = await cenario("# Alvo\nA §9.9 deste arquivo manda outra coisa.", "# Destino\n## 1 Só\nx");
    expect(await deadRemissions(files, "alvo.md")).toEqual([]);
  });

  it("destino ILEGÍVEL não gera acusação (não afirmar o que não se leu)", async () => {
    const { dir, files } = await cenario("# Alvo\nVer `destino.md` §7.4.", "# Destino\n## 1 Só\nx");
    const destino = join(dir, "destino.md");
    await chmod(destino, 0o000);
    const r = await deadRemissions(files, "alvo.md");
    await chmod(destino, 0o600);
    expect(r).toEqual([]);
  });

  it("o mesmo endereço citado 3× é UMA remissão morta", async () => {
    const { files } = await cenario(
      "# Alvo\nVer `destino.md` §7.4. Como dito em `destino.md` §7.4. E de novo `destino.md` §7.4.",
      "# Destino\n## 1 Só\nx",
    );
    expect(await deadRemissions(files, "alvo.md")).toHaveLength(1);
  });

  it("spec de arquivo único não tem remissão a medir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-dead-"));
    await writeFile(join(dir, "alvo.md"), "# Alvo\nVer `alvo.md` §1.");
    expect(await deadRemissions([ref(dir, "alvo.md")], "alvo.md")).toEqual([]);
  });

  it("o bloco lista, diz que é MEDIÇÃO e não prescreve forma", () => {
    const b = deadRemissionFactBlock([{ ref: "§7.4", toPath: "contratos-erros.md" }], "modelo-dados.md");
    expect(b).toContain("§7.4");
    expect(b).toContain("contratos-erros.md");
    expect(b).toContain("MEDIÇÃO, não veredicto");
    for (const proibido of ["renumere", "remova a remissão e", "crie a seção"]) {
      expect(b.toLowerCase()).not.toContain(proibido);
    }
  });

  it("acima do teto, o que não foi listado é DECLARADO", () => {
    const muitas = Array.from({ length: DEAD_REMISSION_MAX + 4 }, (_, i) => ({ ref: `§${i}.1`, toPath: "d.md" }));
    const b = deadRemissionFactBlock(muitas, "alvo.md");
    expect(b).toContain(`(${muitas.length}, medidas agora no disco)`);
    expect(b).toContain("…(4 remissão(ões) além do teto desta lista");
  });

  it("nenhuma remissão morta ⇒ bloco vazio (silêncio aqui é 'medi e não achei')", () => {
    expect(deadRemissionFactBlock([], "alvo.md")).toBe("");
  });
});
