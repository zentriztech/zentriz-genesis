/**
 * 🔴 GAP-74 — a régua da JANELA de seção.
 *
 * Medido em prod (`modelo-dados.md`, runs `32992636` e `a33a0d29`): `§7.4` tem 16.399 chars, nunca cabe
 * no orçamento de 90.000 já gasto pelas outras seções endereçadas, e é citada por 2 dos 4 GAPs cuja
 * seção ficou byte-a-byte INTOCADA em duas rodadas seguidas. Recusar a seção inteira era o pior dos
 * mundos: o agente sabia que faltava texto e não tinha o texto — então escrevia em outro lugar.
 *
 * A propriedade que cada teste trava é a mesma de todo este módulo: o que aparece é VERBATIM (senão o
 * `SEARCH` do CTO-editor não casa no arquivo) e o que falta é MARCADO (senão o modelo lê a ausência
 * como inexistência e recria a seção).
 */
import { describe, it, expect } from "vitest";
import {
  sectionWindow, splitSections, sectionSubtree, citedSectionRefs, WINDOW_GAP_MARK,
} from "./markdownSections.js";

/** Muitas linhas curtas — é a forma real de uma seção grande de spec, e janela precisa de linhas. */
const manyLines = (tag: string, n: number): string =>
  Array.from({ length: n }, (_, k) => `${tag} linha ${k}: ${"detalhe ".repeat(6)}`).join("\n");

const SECAO = [
  "### 7.4 Retenção e expurgo",
  manyLines("antes", 40),
  "O DELETE de `refresh_tokens` roda no expurgo trimestral.",
  manyLines("depois", 40),
].join("\n");

describe("sectionWindow (GAP-74)", () => {
  it("traz o cabeçalho e a linha do termo VERBATIM, sem o resto da seção", () => {
    const w = sectionWindow(SECAO, ["refresh_tokens"], 2_000);
    expect(w).not.toBeNull();
    expect(w).toContain("### 7.4 Retenção e expurgo");
    expect(w).toContain("O DELETE de `refresh_tokens` roda no expurgo trimestral.");
    // Se a seção inteira viesse, a janela não teria resolvido nada — o defeito era ela não caber.
    expect(w).not.toContain("antes linha 0:");
    expect(w).not.toContain("depois linha 39:");
    expect((w as string).length).toBeLessThan(2_000);
  });

  it("mantém contexto em volta e MARCA cada salto (ausência marcada não é ausência silenciosa)", () => {
    const w = sectionWindow(SECAO, ["refresh_tokens"], 2_000) as string;
    expect(w).toContain("antes linha 39:");
    expect(w).toContain("depois linha 0:");
    expect(w).toContain(WINDOW_GAP_MARK);
    // Cada linha que não é marcador tem de existir tal e qual no original.
    for (const line of w.split("\n")) {
      if (line === WINDOW_GAP_MARK) continue;
      expect(SECAO).toContain(line);
    }
  });

  it("nenhum termo casa → null (recorte que não mostra o trecho em disputa não vale a pena)", () => {
    expect(sectionWindow(SECAO, ["courier_id"], 2_000)).toBeNull();
  });

  it("termo curto demais é ignorado (substring de 1-2 chars casaria qualquer linha)", () => {
    expect(sectionWindow(SECAO, ["de"], 2_000)).toBeNull();
  });

  it("orçamento que só dá para o cabeçalho → null em vez de janela sem texto editável", () => {
    expect(sectionWindow(SECAO, ["refresh_tokens"], 40)).toBeNull();
  });

  it("linha longa no meio é PULADA, não interrompe a janela (a linha do GAP pode vir depois)", () => {
    const comTabela = [
      "### 7.4 Retenção",
      `| tabela | ${"muito longa ".repeat(200)}| refresh_tokens |`,
      "linha curta de contexto",
      "A regra de `refresh_tokens` é esta.",
    ].join("\n");
    const w = sectionWindow(comTabela, ["refresh_tokens"], 600) as string;
    expect(w).not.toBeNull();
    expect(w).toContain("A regra de `refresh_tokens` é esta.");
    expect(w).not.toContain("muito longa muito longa");
    expect(w).toContain(WINDOW_GAP_MARK);
  });

  it("seção sem cabeçalho (preâmbulo) também janela", () => {
    const preambulo = [manyLines("topo", 30), "menção a `refresh_tokens` aqui.", manyLines("fim", 30)].join("\n");
    const w = sectionWindow(preambulo, ["refresh_tokens"], 1_000) as string;
    expect(w).toContain("menção a `refresh_tokens` aqui.");
    expect(w.startsWith(WINDOW_GAP_MARK)).toBe(true);
  });
});

/**
 * 🔴 GAP-78 — o `#` de comentário DENTRO de cerca de código não é cabeçalho.
 *
 * Medido em prod (NVX LastMile): 25 cabeçalhos falsos em 2 dos 12 arquivos. O pior é
 * `definicao-de-pronto.md`, onde o comentário bash `# 3) paridade do catálogo…` (linha 21, dentro de uma
 * cerca ```bash aberta na 13 e fechada na 22) virava `<h1>` e a seção fantasma engolia **96,6% do
 * arquivo** (94.132 de 97.416 chars, 29 subseções). Consequência em cadeia: toda âncora do arquivo caía
 * na mesma seção gigante, o recorte por seção deixava de recortar e o medidor de intocado comparava o
 * arquivo quase todo — sempre "mudou", nunca acusável, nunca fechável.
 */
describe("splitSections — cerca de código (GAP-78)", () => {
  const COM_CERCA = [
    "# Definição de pronto",
    "Preâmbulo real.",
    "```bash",
    "# 3) paridade do catálogo",
    "npm run check",
    "```",
    "## 4. Critérios",
    "Corpo dos critérios.",
  ].join("\n");

  it("comentário dentro da cerca NÃO abre seção", () => {
    const secs = splitSections(COM_CERCA);
    expect(secs.map((s) => s.heading)).toEqual(["# Definição de pronto", "## 4. Critérios"]);
  });

  it("a cerca vai VERBATIM no corpo da seção que a contém", () => {
    const secs = splitSections(COM_CERCA);
    expect(secs[0].body).toContain("# 3) paridade do catálogo");
    expect(secs[0].body).toContain("```bash");
  });

  it("comentário de `.env` (~) também não abre seção", () => {
    // `infraestrutura-deploy.md`: 22 cabeçalhos falsos vindos de `# Servidor` / `# Banco de dados`.
    const secs = splitSections(["## 8. Variáveis", "~~~", "# Servidor", "PORT=3000", "~~~"].join("\n"));
    expect(secs).toHaveLength(1);
    expect(secs[0].heading).toBe("## 8. Variáveis");
  });

  it("cerca ABERTA e nunca fechada é descartada — fail-safe: volta ao comportamento antigo", () => {
    // Preferimos o defeito conhecido (cabeçalho falso) a engolir o resto do arquivo numa cerca eterna.
    const secs = splitSections(["## 8. Variáveis", "```bash", "# Servidor", "## 9. Depois"].join("\n"));
    expect(secs.map((s) => s.heading)).toEqual(["## 8. Variáveis", "# Servidor", "## 9. Depois"]);
  });

  it("`level` é o número de `#` — e 0 no preâmbulo", () => {
    const secs = splitSections(["texto solto", "# Um", "## Dois", "#### Quatro"].join("\n"));
    expect(secs.map((s) => s.level)).toEqual([0, 1, 2, 4]);
  });
});

/**
 * 🔴 GAP-79 — a âncora endereça a SUBÁRVORE do cabeçalho, não o preâmbulo dele.
 *
 * Medido em prod: `visao-escopo.md §1.3` é a âncora eterna nº 1 (15 dos 62 eventos "seção intocada" em
 * 8 runs). O corpo próprio dela tem **415 chars**; a subárvore (`#### Serviço api`, `#### 1.3.0`,
 * `#### 1.3.1`, `#### Serviço worker`) tem **21.839** — 1,9%. O GAP falava da tabela
 * `ServiceManifest.interfaces[]`, que mora no FILHO: o CTO corrigia a tabela certa e era acusado de não
 * ter tocado a seção, rodada após rodada — e, com a guarda nº 3 do GAP-77, o defeito não podia fechar
 * nem ser julgado.
 */
describe("sectionSubtree (GAP-79)", () => {
  const ARVORE = [
    "# Visão e escopo",
    "topo",
    "### 1.3 Serviços",
    "preâmbulo curto da 1.3",
    "#### Serviço api",
    "a tabela de interfaces mora aqui",
    "#### Serviço worker",
    "e aqui",
    "### 1.4 Fora de escopo",
    "outra coisa",
  ].join("\n");

  it("a subárvore leva os descendentes e PARA no primeiro irmão de mesmo nível", () => {
    const secs = splitSections(ARVORE);
    const i = secs.findIndex((s) => s.heading.startsWith("### 1.3"));
    const sub = sectionSubtree(secs, i);
    expect(sub.children).toBe(2);
    expect(sub.body).toContain("a tabela de interfaces mora aqui");
    expect(sub.body).toContain("#### Serviço worker");
    expect(sub.body).not.toContain("### 1.4 Fora de escopo");
  });

  it("a subárvore é VERBATIM — é o que o `SEARCH` do CTO-editor precisa casar", () => {
    const secs = splitSections(ARVORE);
    const i = secs.findIndex((s) => s.heading.startsWith("### 1.3"));
    expect(ARVORE).toContain(sectionSubtree(secs, i).body);
  });

  it("seção folha: subárvore é o próprio corpo, sem filhos", () => {
    const secs = splitSections(ARVORE);
    const i = secs.findIndex((s) => s.heading.startsWith("### 1.4"));
    const sub = sectionSubtree(secs, i);
    expect(sub.children).toBe(0);
    expect(sub.body).toBe(secs[i].body);
  });

  it("o preâmbulo (nível 0) NÃO adota o arquivo inteiro", () => {
    const secs = splitSections(["texto solto", "# Um", "## Dois"].join("\n"));
    const sub = sectionSubtree(secs, 0);
    expect(sub.children).toBe(0);
    expect(sub.body).toBe(secs[0].body);
  });

  it("caminha por NÍVEL, não por numeração — em prod a numeração vem fora de ordem", () => {
    // `modelo-dados.md`: `### 2.3.1`/`2.3.2` aparecem ANTES de `### 2.3`; `8.6` antes de `8.5`.
    const secs = splitSections(["## 2. Tabelas", "x", "### 2.3.1 Detalhe", "y", "### 2.3 Geral", "z"].join("\n"));
    const sub = sectionSubtree(secs, 0);
    expect(sub.children).toBe(2);
    expect(sub.to).toBe(3);
  });

  it("índice fora da faixa devolve vazio em vez de estourar", () => {
    expect(sectionSubtree(splitSections("# Um\ncorpo"), 9).body).toBe("");
  });
});

/**
 * 🔴 GAP-162 — o nome do arquivo citado não pode voltar pela METADE.
 *
 * A janela de 48 chars mede DISTÂNCIA (o nome está perto da citação?). Ela nunca deveria recortar o
 * NOME, mas recortava: `observabilidade-operacao.md ... §7.2` voltava como `operacao.md`. Um nome
 * truncado não casa com arquivo nenhum, então a ponta do ALVO (GAP-73) o descarta como "de outro
 * arquivo" e a ponta do IRMÃO (GAP-75) não o reconhece como irmão — a citação cai calada exatamente no
 * vão que esta função existe para fechar. Medido: 13 de 932 remissões da spec do NVX (0 de 27 nos
 * rationales de hoje — latente, não ativo).
 */
describe("citedSectionRefs (GAP-162)", () => {
  it("devolve o nome INTEIRO quando o começo dele ficou antes da janela", () => {
    const nome = "observabilidade-operacao.md";
    const meio = " conforme descrito naquele arquivo ";
    // O `.md` cabe na janela (por isso havia match), mas o começo do nome NÃO — era ali que truncava.
    expect(meio.length).toBeLessThan(48);
    expect(nome.length + meio.length).toBeGreaterThan(48);
    expect(citedSectionRefs(`O inventário está em ${nome}${meio}§7.2`)).toEqual([
      { ref: "§7.2", file: nome },
    ]);
  });

  it("nome colado à citação continua sendo lido igual (a correção não muda o caso comum)", () => {
    expect(citedSectionRefs("contradiz `privacidade-lgpd.md` §3.3 e nada mais")).toEqual([
      { ref: "§3.3", file: "privacidade-lgpd.md" },
    ]);
  });

  it("citação sem arquivo nomeado é do PRÓPRIO arquivo — `file` fica null", () => {
    expect(citedSectionRefs("a regra da §8.6 contradiz a §9.1")).toEqual([
      { ref: "§8.6", file: null },
      { ref: "§9.1", file: null },
    ]);
  });

  it("nome LONGE da citação não é associado — a janela ainda mede distância", () => {
    const longe = "modelo-dados.md" + " palavras que separam os dois fatos".repeat(3);
    expect(citedSectionRefs(`${longe} §2.7`)[0].file).toBeNull();
  });

  it("não engole a palavra anterior: a fronteira do nome é o primeiro char que não é de nome", () => {
    expect(citedSectionRefs("ver arquivo contratos-erros.md §7.4")[0].file).toBe("contratos-erros.md");
    expect(citedSectionRefs("(vide contratos-erros.md) §7.4")[0].file).toBe("contratos-erros.md");
  });

  it("normaliza para minúsculas — a comparação do outro lado é por nome minúsculo", () => {
    expect(citedSectionRefs("ver Modelo-Dados.MD §2.7")[0].file).toBe("modelo-dados.md");
  });
});
