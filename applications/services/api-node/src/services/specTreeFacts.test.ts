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
import { firstHeading, loadSpecTree, specTreeFactBlock, type SpecTreeEntry } from "./specTreeFacts.js";
import type { SpecFileRef } from "./specGapScope.js";

const E = (over: Partial<SpecTreeEntry> = {}): SpecTreeEntry => ({
  path: "a.md", bytes: 1_000, title: "A", isPrimary: false, isManifest: false, ...over,
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
