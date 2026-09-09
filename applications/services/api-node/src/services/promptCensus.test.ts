/**
 * 🔴 GAP-146 — testes do CENSO DO PROMPT do lado da api.
 *
 * O instrumento existe porque `spec_cto` custa 69.548 tokens de ENTRADA por chamada (764 chamadas /
 * 52,9 M tokens em 3 dias medidos em prod) e ninguém sabia de QUEM: o prompt por-arquivo é uma pilha
 * de ~15 blocos e o caminho dominante (`/invoke/raw`) monta o prompt AQUI, fora do censo do `agents`
 * — medido ao vivo: zero linhas `[prompt-census]` com o laço rodando CTO.
 *
 * Estes testes pinam o que faz o censo ser confiável, não o que ele imprime:
 *
 *   1. o censo FECHA (`soma(campos) + outros == total`) — sem isso, campo esquecido viraria "economia";
 *   2. `outros` NEGATIVO é denunciado, não escondido: negativo = contagem dupla no chamador;
 *   3. campo vazio não aparece (ruído ≠ fato) e a ordem é do maior para o menor;
 *   4. o censo não carrega conteúdo (vai para log; spec de cliente não vai);
 *   5. no PROMPT REAL do CTO por-arquivo `outros` é pequeno — é este teste que quebra quando alguém
 *      acrescenta um bloco grande ao prompt e esquece de somá-lo ao censo (o apodrecimento esperado).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PROMPT_CACHE_MIN_HEAD_CHARS, PROMPT_CACHE_TTL_MS, recordPromptCensus, resetPromptCensusHeads,
  setPromptCensusSink, type PromptCensus,
} from "./promptCensus.js";
import { buildGapFileRequest, buildRawFileRequest } from "../routes/specChat.js";
import { deadRemissionFactBlock } from "./specTreeFacts.js";
import type { ValidationFinding } from "./specValidation.js";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("recordPromptCensus", () => {
  it("fecha a conta: soma(campos) + outros == total", () => {
    const c = recordPromptCensus({
      origem: "t", role: "CTO", file: "a.md",
      total: 1_000, fields: { file_content: 600, gaps: 300 },
    });
    expect(c.fields).toEqual({ file_content: 600, gaps: 300 });
    expect(c.outros).toBe(100);
    expect(Object.values(c.fields).reduce((a, b) => a + b, 0) + c.outros).toBe(c.total);
  });

  it("denuncia contagem dupla em vez de esconder (outros negativo)", () => {
    const c = recordPromptCensus({ origem: "t", total: 100, fields: { a: 80, b: 80 } });
    expect(c.outros).toBe(-60);
    expect(logs.join("\n")).toContain("CONTAGEM-DUPLA");
  });

  it("omite campo vazio e ordena do maior para o menor", () => {
    const c = recordPromptCensus({
      origem: "t", total: 500, fields: { pequeno: 10, vazio: 0, grande: 400, negativo: -5 },
    });
    expect(Object.keys(c.fields)).toEqual(["grande", "pequeno"]);
  });

  it("não carrega conteúdo do prompt — só tamanhos", () => {
    const c = recordPromptCensus({ origem: "t", total: 10, fields: { file_content: 10 } });
    expect(JSON.stringify(c)).not.toContain("SEGREDO");
    expect(logs.join("\n")).toContain("[prompt-census] origem=t");
  });

  it("registra uma linha por censo, com role e arquivo", () => {
    recordPromptCensus({ origem: "api-gapfile", role: "CTO", file: "tecnico/dados.md", total: 7, fields: {} });
    const linha = logs.find((l) => l.includes("[prompt-census]")) ?? "";
    expect(linha).toContain("role=CTO");
    expect(linha).toContain("file=tecnico/dados.md");
    expect(linha).toContain("total=7c");
  });
});

// ── 5. o censo sobre o PROMPT REAL (guarda contra bloco novo não somado) ───────────────────────────

function finding(over: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    file: "tecnico/dados.md", line: 12, severity: "blocker",
    title: "Contradição de contrato", rationale: "422 aqui × 400 no irmão",
    source: "stage_b", category: "consistency", anchor: "§8.6",
    ...over,
  };
}

describe("censo do prompt REAL do CTO por-arquivo", () => {
  it("fecha a conta e `outros` fica em delimitadores (não em bloco esquecido)", () => {
    const content = "# Dados\n" + "linha de spec\n".repeat(300);
    buildGapFileRequest(
      content, "tecnico/dados.md", [finding(), finding({ title: "Outro" })],
      { siblingsBlock: "", findingsBlock: "", findings: [], derivedStatus: "validated",
        productMapBlock: "MAPA ".repeat(200), contextWarnings: [], emitV2: true,
        // 🔴 GAP-160: a árvore da spec entra no prompt real — e no censo, com campo próprio.
        specTree: [
          { path: "tecnico/dados.md", bytes: 90_000, title: "Dados", isPrimary: false, isManifest: false },
          { path: "README.md", bytes: 85_000, title: "Manifesto", isPrimary: true, isManifest: true },
          { path: "privacidade-lgpd.md", bytes: 90_500, title: "LGPD", isPrimary: false, isManifest: false },
        ] },
      null,
      "IRMÃO ".repeat(100),   // siblingBlock
      false,
      "ORÁCULO ".repeat(50),  // oracleBlock
      "RECUSA ".repeat(30),   // priorRejectionBlock
      "PERSISTENTE ".repeat(20),
      "FOCO ".repeat(10),
      "DESFECHO ".repeat(15),
      "",                     // consolidationBlock (rodada normal)
      "",                     // indexBlock (não é o manifesto)
      "TENTATIVAS ".repeat(12),
    );
    const linha = logs.find((l) => l.includes("origem=api-gapfile")) ?? "";
    expect(linha).not.toBe("");
    const num = (k: string) => Number(new RegExp(`${k}=(-?\\d+)c`).exec(linha)?.[1] ?? NaN);
    // `outros` = delimitadores + rótulos + instrução final. Um bloco novo não somado apareceria aqui
    // como milhares de chars — e é exatamente isso que este teto pega.
    expect(num("outros")).toBeGreaterThan(0);
    expect(num("outros")).toBeLessThan(2_500);
    expect(num("file_content")).toBe(content.length);
    expect(num("total")).toBeGreaterThan(content.length);
  });

  // 🔴 GAP-160: no prompt REAL a árvore tem de chegar ao editor, ser somada ao censo e vir ANTES do nome
  // do alvo (é o enquadramento — e o único prefixo invariável entre arquivos do passe).
  it("a árvore da spec chega ao prompt real, é somada ao censo e vem ANTES de `ARQUIVO:`", () => {
    const req = buildGapFileRequest(
      "# Dados\nconteúdo\n", "tecnico/dados.md", [finding()],
      { siblingsBlock: "", findingsBlock: "", findings: [], derivedStatus: "validated",
        productMapBlock: "", contextWarnings: [], emitV2: true,
        specTree: [
          { path: "tecnico/dados.md", bytes: 90_000, title: "Dados", isPrimary: false, isManifest: false },
          { path: "privacidade-lgpd.md", bytes: 90_500, title: "LGPD", isPrimary: false, isManifest: false },
        ] },
      null,
      "─── IRMÃO SÓ LEITURA: `privacidade-lgpd.md` ───\ncorpo do irmão",
    );
    const msg = String(req.user_message);
    expect(msg).toContain("privacidade-lgpd.md");
    expect(msg.indexOf("ÁRVORE DA ESPECIFICAÇÃO")).toBeGreaterThanOrEqual(0);
    expect(msg.indexOf("ÁRVORE DA ESPECIFICAÇÃO")).toBeLessThan(msg.indexOf("ARQUIVO: tecnico/dados.md"));
    // O corpo do irmão VEIO: a árvore não pode declará-lo ausente (seria mentir sobre o próprio prompt).
    expect(msg).not.toContain("o TEXTO de 1 destes arquivos NÃO está");
    const linha = logs.find((l) => l.includes("origem=api-gapfile")) ?? "";
    expect(linha).toMatch(/spec_tree=\d+c/);
  });

  // 🔴 GAP-163: a remissão morta é fato NOVO no prompt — tem de chegar ao editor nos DOIS caminhos e ser
  // somada com nome próprio (em `outros` ela estouraria o teto que existe para acusar o não somado).
  it("as remissões mortas chegam ao prompt do laço e são somadas com nome próprio", () => {
    const bloco = deadRemissionFactBlock([{ ref: "§7.4", toPath: "contratos-erros.md" }], "modelo-dados.md");
    const req = buildGapFileRequest(
      "# Dados\nconteúdo\n", "modelo-dados.md", [finding()], undefined, null,
      "", false, "", "", "", "", "", "", "", "", bloco,
    );
    const msg = String(req.user_message);
    expect(msg).toContain("§7.4");
    expect(msg).toContain("REMISSÕES DESTE ARQUIVO QUE NÃO CASAM");
    const linha = logs.find((l) => l.includes("origem=api-gapfile")) ?? "";
    expect(linha).toContain(`dead_remissions=${bloco.length}c`);
  });

  it("mede o ENTREGUE: bloco ausente não aparece como despesa", () => {
    buildGapFileRequest("conteúdo curto", "tecnico/dados.md", [finding()]);
    const linha = logs.find((l) => l.includes("origem=api-gapfile")) ?? "";
    expect(linha).not.toContain("siblings=");
    expect(linha).not.toContain("product_map=");
    expect(linha).toContain("file_content=14c");
  });
});

// 🔴 GAP-153 — o escritor da Bancada nunca marcou ponto de cache, e marcar às cegas é REGRESSÃO
// (prefixo que não repete paga 1,25× de escrita e não lê nada). Antes de marcar, mede-se se a cabeça
// estável repete byte a byte DENTRO do TTL. Estes testes pinam o que faz essa taxa ser honesta.
describe("recordPromptCensus — GAP-153: a cabeça estável é medida antes de ser marcada", () => {
  beforeEach(() => { resetPromptCensusHeads(); });

  const censo = (head?: string, origem = "t") =>
    recordPromptCensus({ origem, total: 10_000, fields: { file_content: 9_000 }, head });

  it("cabeça não declarada é `null` — 'não declarado' ≠ 'não repete'", () => {
    expect(censo().head).toBeNull();
    expect(censo("").head).toBeNull();
    expect(logs.at(-1)).not.toContain("head=");
  });

  it("primeira vez é ESTREIA, segunda dentro do TTL é ACERTO — e o contador acumula", () => {
    const grande = "x".repeat(PROMPT_CACHE_MIN_HEAD_CHARS + 1);
    const a = censo(grande);
    expect(a.head).toMatchObject({ seen: 1, sinceLastMs: null, hitWithinTtl: false, cacheable: true });
    expect(logs.at(-1)).toContain("head_repeat=estreia");
    const b = censo(grande);
    expect(b.head).toMatchObject({ seen: 2, hitWithinTtl: true });
    expect(b.head!.hash).toBe(a.head!.hash);
    expect(logs.at(-1)).toContain("head_repeat=ACERTO(0s)");
  });

  it("repetição FORA do TTL não é acerto — o prefixo já expirou e a escrita seria paga de novo", () => {
    vi.useFakeTimers();
    try {
      const grande = "y".repeat(PROMPT_CACHE_MIN_HEAD_CHARS + 1);
      censo(grande);
      vi.advanceTimersByTime(PROMPT_CACHE_TTL_MS + 1_000);
      const b = censo(grande);
      // `seen` sobe (é o MESMO prefixo), mas não conta como acerto: contar contaria uma economia
      // que o provedor não daria — exatamente o defeito que o GAP-147 mostrou no medidor.
      expect(b.head).toMatchObject({ seen: 2, hitWithinTtl: false });
      expect(logs.at(-1)).toContain("head_repeat=fora-do-ttl");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cabeça abaixo do piso do provedor é declarada NAO-CACHEAVEL (marcar ali é pagar por nada)", () => {
    const c = censo("z".repeat(PROMPT_CACHE_MIN_HEAD_CHARS - 1));
    expect(c.head!.cacheable).toBe(false);
    expect(logs.at(-1)).toContain("NAO-CACHEAVEL");
    const d = censo("w".repeat(PROMPT_CACHE_MIN_HEAD_CHARS));
    expect(d.head!.cacheable).toBe(true);
    expect(logs.at(-1)).not.toContain("NAO-CACHEAVEL");
  });

  it("a identidade é por ORIGEM: caminhos diferentes não se aproveitam do mesmo prefixo", () => {
    const mesmo = "k".repeat(PROMPT_CACHE_MIN_HEAD_CHARS + 1);
    const a = censo(mesmo, "api-gapfile");
    const b = censo(mesmo, "api-rawfile");
    expect(b.head!.hash).not.toBe(a.head!.hash);
    expect(b.head).toMatchObject({ seen: 1, hitWithinTtl: false });
  });

  it("o log leva HASH e TAMANHO, nunca o texto da cabeça (spec de cliente não vai para log)", () => {
    const segredo = "SEGREDO-DA-SPEC-".repeat(300);
    const c = censo(segredo);
    expect(c.head!.chars).toBe(segredo.length);
    expect(logs.at(-1)).not.toContain("SEGREDO-DA-SPEC");
    expect(logs.at(-1)).toContain(`head=${c.head!.hash}`);
    expect(logs.at(-1)).toContain(`head_chars=${segredo.length}c`);
  });

  it("no prompt REAL do CTO a cabeça termina ANTES do conteúdo do arquivo", () => {
    // Se a cabeça incluísse o conteúdo, ela mudaria a cada edição e a taxa medida seria sempre zero —
    // o instrumento provaria a hipótese errada. O teto abaixo é a garantia disso no caminho real.
    const content = "# Dados\n" + "linha de conteúdo do arquivo em edição\n".repeat(400);
    buildGapFileRequest(content, "tecnico/dados.md", [finding()]);
    const linha = logs.find((l) => l.includes("origem=api-gapfile")) ?? "";
    const chars = Number(/head_chars=(\d+)c/.exec(linha)?.[1] ?? NaN);
    expect(chars).toBeGreaterThan(0);
    expect(chars).toBeLessThan(content.length);
  });
});

// 🔴 GAP-159 — o censo só decide corte se SOBREVIVER ao deploy. O destino é um sink registrado no boot
// (nunca por call site), e estes testes pinam as duas coisas que fariam a série mentir: um caminho
// medido que não chega ao destino, e um destino que derruba a chamada que ele mede.
describe("recordPromptCensus — GAP-159: o censo vai para um destino, e TODO caminho medido passa por ele", () => {
  beforeEach(() => { resetPromptCensusHeads(); setPromptCensusSink(null); });
  afterEach(() => { setPromptCensusSink(null); });

  it("os DOIS caminhos reais do CTO entregam ao MESMO destino (não é escolha do chamador)", () => {
    const vistos: PromptCensus[] = [];
    setPromptCensusSink((c) => { vistos.push(c); });
    buildGapFileRequest("# Dados\nconteúdo\n", "tecnico/dados.md", [finding()]);
    buildRawFileRequest("# Dados\nconteúdo\n", [{ role: "user", content: "ajuste a seção 8" }], "tecnico/dados.md");
    expect(vistos.map((c) => c.origem)).toEqual(["api-gapfile", "api-rawfile"]);
    // O que se persiste é o mesmo fato que se loga: tamanho por bloco, nunca conteúdo.
    expect(JSON.stringify(vistos)).not.toContain("ajuste a seção 8");
    for (const c of vistos) expect(c.total).toBeGreaterThan(0);
  });

  // 🔴 GAP-163 + lição do GAP-156: um caminho entregar o fato e o outro não é o defeito que mais custou
  // caro nesta frente. Os dois builders REAIS são chamados com o mesmo bloco.
  it("os DOIS caminhos põem a remissão morta no prompt e a somam com o MESMO nome", () => {
    const vistos: PromptCensus[] = [];
    setPromptCensusSink((c) => { vistos.push(c); });
    const bloco = deadRemissionFactBlock([{ ref: "§2.6", toPath: "contratos-erros.md" }], "definicao-de-pronto.md");
    const laco = buildGapFileRequest(
      "# Pronto\nconteúdo\n", "definicao-de-pronto.md", [finding()], undefined, null,
      "", false, "", "", "", "", "", "", "", "", bloco,
    );
    const humano = buildRawFileRequest(
      "# Pronto\nconteúdo\n", [{ role: "user", content: "ajuste a seção 2" }], "definicao-de-pronto.md",
      undefined, null, bloco,
    );
    for (const req of [laco, humano]) expect(String(req.user_message)).toContain("§2.6");
    expect(vistos.map((c) => c.fields.dead_remissions)).toEqual([bloco.length, bloco.length]);
  });

  it("destino que lança NÃO derruba a chamada medida (e o log já saiu antes)", () => {
    setPromptCensusSink(() => { throw new Error("banco fora"); });
    const c = recordPromptCensus({ origem: "t", total: 10, fields: { a: 4 } });
    expect(c.outros).toBe(6);
    expect(logs.join("\n")).toContain("[prompt-census] origem=t");
  });

  it("sem destino registrado o censo segue válido — persistir é adicional, não pré-condição", () => {
    expect(recordPromptCensus({ origem: "t", total: 5, fields: {} }).total).toBe(5);
  });
});
