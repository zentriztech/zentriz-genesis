/**
 * connectDeclaration.test.ts — GAP-133: o que este arquivo PROVA.
 *
 * O valor do módulo não é "gerar YAML": é (a) a identidade vir do sistema e não do LLM, (b) todo
 * descarte ser DECLARADO, (c) vocabulário fechado ser lido DO SCHEMA e (d) a serialização não
 * corromper texto em PT-BR (acento, `:`, `#`) — que é o que o consumidor Python vai ler.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assembleDeclaration, extractDeclarationJson, toYaml, declarationToYaml, schemaEnum,
  capFromEnv, extractHeadings, packSpecText, parseSelection, applySelection,
  buildConnectDeclSelectRequest, buildConnectDeclRequest, DECL_DIMENSIONS,
  type ConnectDeclContext, type ReadableSpecFile,
} from "./connectDeclaration.js";
import { loadVendoredSchema, VENDORED_CONNECT_VERSION, validateAgainst } from "./connectSchema.js";

const ctx: ConnectDeclContext = {
  projectId: "11111111-2222-3333-4444-555555555555",
  title: "Rastreamento de Entregas",
  productName: "NVX LastMile",
  systemId: "nvx-lastmile",
  serviceId: "nvx-lastmile-tracking",
  specText: "# Spec\nqualquer coisa",
  files: ["01-spec.md"],
  existing: null,
  truncated: [],
  truncatedBase: [],
  facts: [{ path: "01-spec.md", isPrimary: true, chars: 21, headings: ["Spec"], headingsOmitted: 0 }],
  readable: [{ path: "01-spec.md", isPrimary: true, body: "# Spec\nqualquer coisa" }],
  readPaths: ["01-spec.md"],
  leftOut: [],
  needsSelection: false,
  selection: null,
};

const minimal = {
  serviceName: "Rastreamento de Entregas",
  responsibility: "Manter a posição e o estado de cada entrega, expondo consulta e histórico.",
  interfaces: [{ name: "tracking-api", type: "http", description: "Consulta de posição pelo portal." }],
};

describe("extractDeclarationJson", () => {
  it("aceita cerca ```json e prosa ao redor", () => {
    const o = extractDeclarationJson("Segue a declaração:\n```json\n{\"serviceName\":\"x\"}\n```\nespero que sirva.");
    expect(o.serviceName).toBe("x");
  });
  it("recusa o que não é objeto JSON", () => {
    expect(() => extractDeclarationJson("não devolvi nada útil")).toThrow(/DECL_NOT_JSON/);
    expect(() => extractDeclarationJson("[1,2,3]")).toThrow(/DECL_NOT_JSON/);
  });
});

describe("assembleDeclaration — identidade é do SISTEMA", () => {
  it("descarta schemaVersion/systemId/serviceId/owners do LLM e DECLARA o descarte", () => {
    const { declaration, warnings } = assembleDeclaration(ctx, {
      ...minimal,
      schemaVersion: "9.9.9",
      systemId: "inventado-pelo-modelo",
      serviceId: "outro-servico",
      owners: { technicalOwner: { id: "u1", name: "Fulano" } },
    });
    expect(declaration.schemaVersion).toBe(VENDORED_CONNECT_VERSION);
    expect(declaration.systemId).toBe("nvx-lastmile");
    expect(declaration.serviceId).toBe("nvx-lastmile-tracking");
    expect(declaration.owners).toBeUndefined();
    expect(warnings.some((w) => /Identidade .*DESCARTADA/.test(w) && /schemaVersion/.test(w) && /owners/.test(w))).toBe(true);
  });

  it("mono-serviço (serviceId nulo) não grava a chave", () => {
    const { declaration } = assembleDeclaration({ ...ctx, serviceId: null }, minimal);
    expect("serviceId" in declaration).toBe(false);
  });

  it("chave desconhecida é ignorada e DECLARADA", () => {
    const { declaration, warnings } = assembleDeclaration(ctx, { ...minimal, slaTarget: "99.9%", foo: 1 });
    expect(declaration.slaTarget).toBeUndefined();
    expect(warnings.some((w) => /desconhecidas/.test(w) && /foo, slaTarget/.test(w))).toBe(true);
  });
});

describe("assembleDeclaration — vocabulário fechado vem do SCHEMA", () => {
  it("schemaEnum lê o enum do schema vendorizado (não é lista fixa no código)", () => {
    const schema = loadVendoredSchema("spec-connect-declaration");
    expect(schemaEnum(schema, "interfaces.items.type")).toContain("http");
    expect(schemaEnum(schema, "environments.items.criticality")).toEqual(["low", "medium", "high", "critical"]);
    expect(schemaEnum(schema, "campo.que.nao.existe")).toBeNull();
  });

  it("tipo de interface fora do vocabulário cai em `other`, declarado", () => {
    const { declaration, warnings } = assembleDeclaration(ctx, {
      ...minimal,
      interfaces: [{ name: "grpc-svc", type: "grpc" }],
    });
    expect((declaration.interfaces as Array<{ type: string }>)[0].type).toBe("other");
    expect(warnings.some((w) => /grpc-svc.*"grpc" fora do vocabulário.*other/.test(w))).toBe(true);
  });

  it("criticality inválida é OMITIDA (o enum não tem `other`), declarada", () => {
    const { declaration, warnings } = assembleDeclaration(ctx, {
      ...minimal,
      environments: [{ name: "prod", type: "prod", criticality: "altíssima" }],
    });
    const env = (declaration.environments as Array<Record<string, unknown>>)[0];
    expect(env.criticality).toBeUndefined();
    expect(env.type).toBe("prod");
    expect(warnings.some((w) => /criticality.*OMITIDO/.test(w))).toBe(true);
  });

  it("valueEvent fora do contrato value/ é descartado e declarado", () => {
    const { declaration, warnings } = assembleDeclaration(ctx, {
      ...minimal,
      events: { publishes: ["delivery.assigned"], valueEvents: ["deploy_completed", "entrega_chegou"] },
    });
    const ev = declaration.events as Record<string, string[]>;
    expect(ev.valueEvents).toEqual(["deploy_completed"]);
    expect(ev.publishes).toEqual(["delivery.assigned"]);
    expect(warnings.some((w) => /valueEvents.*entrega_chegou/.test(w))).toBe(true);
  });
});

describe("assembleDeclaration — vetos", () => {
  it("sem interface nenhuma, recusa (o schema exige ao menos uma)", () => {
    expect(() => assembleDeclaration(ctx, { ...minimal, interfaces: [] })).toThrow(/DECL_WITHOUT_INTERFACES/);
    expect(() => assembleDeclaration(ctx, { ...minimal, interfaces: [{ description: "sem nome nem tipo" }] }))
      .toThrow(/DECL_WITHOUT_INTERFACES/);
  });

  it("interface incompleta é descartada e DECLARADA (as boas sobrevivem)", () => {
    const { declaration, warnings } = assembleDeclaration(ctx, {
      ...minimal,
      interfaces: [{ name: "tracking-api", type: "http" }, { name: "sem-tipo" }],
    });
    expect((declaration.interfaces as unknown[]).length).toBe(1);
    expect(warnings.some((w) => /1 interface\(s\) sem/.test(w))).toBe(true);
  });

  it("responsibility ausente não some em silêncio", () => {
    const { declaration, warnings } = assembleDeclaration(ctx, { ...minimal, responsibility: "" });
    expect(String(declaration.responsibility)).toContain("Rastreamento de Entregas");
    expect(warnings.some((w) => /responsibility. ausente/.test(w))).toBe(true);
  });

  it("a declaração montada passa no schema Connect vendorizado", () => {
    const schema = loadVendoredSchema("spec-connect-declaration");
    expect(schema).not.toBeNull();
    const { declaration } = assembleDeclaration(ctx, {
      ...minimal,
      dependencies: ["nvx-lastmile-infra"],
      events: { publishes: ["delivery.assigned"], subscribes: ["order.created"] },
      runtimeType: "container",
      queues: ["tracking-events"],
      healthModel: { hasHealthEndpoint: true, signals: ["latency_p95"], sloCritical: false },
      environments: [{ name: "prod", type: "prod", region: "us-east-1", criticality: "high" }],
      integrationTierTarget: "tier2-deadpool-ready",
      notes: ["A spec não fixa a região de dev."],
    });
    expect(validateAgainst(declaration, schema!)).toEqual([]);
  });
});

// ── 🔴 GAP-135 — quem escolhe o que ler é o ARQUITETO, não a ordem da listagem ─
//
// O que estes testes PROVAM (o defeito medido em prod): com a spec maior que o teto, `packSpecText`
// lia na ordem da listagem e o oráculo de health ficava fora — o corte era declarado, mas a ESCOLHA
// era cega. Agora a ordem vem do passe 1, caminho inventado é descartado, dimensão sem arquivo é
// declarada, e o provisório NÃO sobrevive à decisão.

const arq = (path: string, chars: number, isPrimary = false): ReadableSpecFile =>
  ({ path, isPrimary, body: `# ${path}\n${"x".repeat(Math.max(0, chars - path.length - 3))}` });

describe("capFromEnv — teto calibrável por ambiente, com piso", () => {
  afterEach(() => { delete process.env.CAP_TESTE; vi.restoreAllMocks(); });

  it("sem env, usa o padrão", () => {
    expect(capFromEnv("CAP_TESTE", 240_000, 10_000)).toBe(240_000);
  });

  it("valor válido acima do piso vence o padrão", () => {
    process.env.CAP_TESTE = "500000";
    expect(capFromEnv("CAP_TESTE", 240_000, 10_000)).toBe(500_000);
  });

  it("valor abaixo do piso ou não-inteiro é RECUSADO com aviso (cai no padrão)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CAP_TESTE = "10";
    expect(capFromEnv("CAP_TESTE", 240_000, 10_000)).toBe(240_000);
    process.env.CAP_TESTE = "muito grande";
    expect(capFromEnv("CAP_TESTE", 240_000, 10_000)).toBe(240_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("extractHeadings — o passe 1 reconhece o assunto sem ler o arquivo", () => {
  it("pega `#`/`##` (indentando o nível 2) e DECLARA quantos ficaram fora", () => {
    const body = "# Título\ntexto\n## Interfaces\n### fundo demais\n## Eventos\n";
    expect(extractHeadings(body).headings).toEqual(["Título", "  Interfaces", "  Eventos"]);
    const muitos = Array.from({ length: 20 }, (_, i) => `## H${i}`).join("\n");
    const r = extractHeadings(muitos, 5);
    expect(r.headings.length).toBe(5);
    expect(r.omitted).toBe(15);
  });
});

describe("packSpecText — lê na ORDEM PEDIDA e declara tudo que ficou fora", () => {
  const files = [arq("01-spec.md", 100, true), arq("health.md", 100), arq("api.md", 100)];
  const caps = { specCap: 100_000, fileCap: 50_000, maxFiles: 32 };

  it("a ordem é de quem chama (é assim que a escolha do arquiteto entra)", () => {
    const r = packSpecText(files, ["health.md", "01-spec.md"], caps);
    expect(r.readPaths).toEqual(["health.md", "01-spec.md"]);
    expect(r.specText.indexOf("ARQUIVO: health.md")).toBeLessThan(r.specText.indexOf("ARQUIVO: 01-spec.md"));
    expect(r.specText).toContain("ARQUIVO: 01-spec.md (PRIMÁRIO)");
  });

  it("arquivo fora da ordem é DECLARADO pelo nome (nunca some calado)", () => {
    const r = packSpecText(files, ["01-spec.md"], caps);
    expect(r.leftOut).toEqual(["health.md", "api.md"]);
    expect(r.truncated.some((t) => /1 de 3 arquivo\(s\) lidos — FORA: health\.md, api\.md/.test(t))).toBe(true);
  });

  it("caminho inexistente e repetido não quebram nem duplicam a leitura", () => {
    const r = packSpecText(files, ["nao-existe.md", "api.md", "api.md"], caps);
    expect(r.readPaths).toEqual(["api.md"]);
  });

  it("teto por arquivo morde com a marca de corte e é declarado com os dois tamanhos", () => {
    const r = packSpecText([arq("grande.md", 9_000)], ["grande.md"], { specCap: 100_000, fileCap: 2_000, maxFiles: 32 });
    expect(r.specText).toContain("⟨CORTADO:");
    expect(r.truncated.some((t) => /grande\.md: 9000 → 2000 chars/.test(t))).toBe(true);
  });

  it("teto por arquivo nunca excede o teto total (senão o 1º arquivo já o estouraria)", () => {
    const r = packSpecText([arq("grande.md", 9_000)], ["grande.md"], { specCap: 3_000, fileCap: 50_000, maxFiles: 32 });
    expect(r.readPaths).toEqual(["grande.md"]);
    expect(r.specText.length).toBeLessThanOrEqual(3_000 + "--- ARQUIVO: grande.md ---\n".length);
  });

  it("teto total interrompe DIZENDO em que arquivo parou; teto de arquivos também", () => {
    const total = packSpecText(files, ["01-spec.md", "health.md", "api.md"], { specCap: 150, fileCap: 150, maxFiles: 32 });
    expect(total.readPaths).toEqual(["01-spec.md"]);
    expect(total.truncated.some((t) => /teto total de 150 chars atingido em "health\.md"/.test(t))).toBe(true);
    const nArq = packSpecText(files, ["01-spec.md", "health.md", "api.md"], { ...caps, maxFiles: 2 });
    expect(nArq.readPaths).toEqual(["01-spec.md", "health.md"]);
    expect(nArq.truncated.some((t) => /teto de 2 arquivo\(s\) lido\(s\) atingido/.test(t))).toBe(true);
  });
});

describe("parseSelection — a escolha do arquiteto entra validada, nunca aproximada", () => {
  const facts = [
    { path: "01-spec.md", isPrimary: true, chars: 100, headings: ["Spec"], headingsOmitted: 0 },
    { path: "docs/health.md", isPrimary: false, chars: 100, headings: ["Health"], headingsOmitted: 0 },
  ];

  it("normaliza `./`, `/` e `\\` e preserva a ORDEM de importância", () => {
    const sel = parseSelection(JSON.stringify({ read: ["./docs\\health.md", "/01-SPEC.md"], why: "cobre health" }), facts);
    expect(sel.read).toEqual(["docs/health.md", "01-spec.md"]);
    expect(sel.why).toBe("cobre health");
  });

  it("caminho inventado e repetido são DESCARTADOS e declarados em `invalid`", () => {
    const sel = parseSelection(JSON.stringify({ read: ["01-spec.md", "01-spec.md", "inventado.md"] }), facts);
    expect(sel.read).toEqual(["01-spec.md"]);
    expect(sel.invalid).toEqual(["repetido: 01-spec.md", "inexistente: inventado.md"]);
  });

  it("nenhum caminho válido ⇒ falha (não há fallback para a ordem da listagem)", () => {
    expect(() => parseSelection(JSON.stringify({ read: ["nada.md"] }), facts)).toThrow(/DECL_SELECTION_EMPTY/);
    expect(() => parseSelection(JSON.stringify({ why: "esqueci de escolher" }), facts)).toThrow(/DECL_SELECTION_EMPTY/);
  });

  it("dimensão sem arquivo escolhido vira `uncovered`; arquivo citado fora de `read` não conta", () => {
    const sel = parseSelection(JSON.stringify({
      read: ["01-spec.md"],
      dimensions: { interfaces: ["01-spec.md"], health: ["docs/health.md"], events: "não é lista" },
      riskIfMissing: ["Sem o oráculo de health, `healthModel` fica sem base.", 42],
    }), facts);
    expect(sel.dimensions).toEqual({ interfaces: ["01-spec.md"] });
    expect(sel.uncovered).toEqual(DECL_DIMENSIONS.filter((d) => d !== "interfaces"));
    expect(sel.riskIfMissing).toEqual(["Sem o oráculo de health, `healthModel` fica sem base."]);
  });
});

describe("applySelection — o provisório NÃO sobrevive à decisão", () => {
  const grande: ConnectDeclContext = {
    ...ctx,
    readable: [arq("01-spec.md", 100, true), arq("docs/health.md", 100)],
    facts: [
      { path: "01-spec.md", isPrimary: true, chars: 100, headings: ["Spec"], headingsOmitted: 0 },
      { path: "docs/health.md", isPrimary: false, chars: 100, headings: ["Health"], headingsOmitted: 0 },
    ],
    files: ["01-spec.md", "docs/health.md"],
    specText: "provisório na ordem da listagem",
    readPaths: ["01-spec.md"],
    leftOut: ["docs/health.md"],
    truncated: ["01-spec.md: ilegível no disco — não entrou na leitura", "spec: 1 de 2 arquivo(s) lidos — FORA: docs/health.md"],
    truncatedBase: ["01-spec.md: ilegível no disco — não entrou na leitura"],
    needsSelection: true,
  };

  it("reempacota na ordem do arquiteto e troca os cortes do provisório pelos reais", () => {
    const sel = parseSelection(JSON.stringify({ read: ["docs/health.md"], why: "o health está aqui" }), grande.facts);
    const novo = applySelection(grande, sel);
    expect(novo.readPaths).toEqual(["docs/health.md"]);
    expect(novo.specText).toContain("ARQUIVO: docs/health.md");
    // o corte de DISCO permanece; o corte do provisório (que falava do health) morreu com ele
    expect(novo.truncated[0]).toMatch(/ilegível no disco/);
    expect(novo.truncated.some((t) => /FORA: 01-spec\.md/.test(t))).toBe(true);
    expect(novo.truncated.some((t) => /FORA: docs\/health\.md/.test(t))).toBe(false);
    expect(novo.selection?.why).toBe("o health está aqui");
  });

  it("escolha que não rende texto nenhum FALHA (não gera declaração sobre o vazio)", () => {
    const sel = { read: ["fantasma.md"], why: "", riskIfMissing: [], dimensions: {}, uncovered: [], invalid: [] };
    expect(() => applySelection(grande, sel)).toThrow(/DECL_SELECTION_UNREADABLE/);
  });

  it("o passe 2 devolve ao arquiteto a escolha, o critério e as dimensões descobertas", () => {
    const sel = parseSelection(JSON.stringify({
      read: ["docs/health.md"], why: "o health está aqui",
      dimensions: { health: ["docs/health.md"] },
      riskIfMissing: ["Interfaces HTTP ficaram de fora."],
    }), grande.facts);
    const msg = String(buildConnectDeclRequest(applySelection(grande, sel)).user_message);
    expect(msg).toContain("LEITURA QUE VOCÊ PEDIU no passe 1 (1 de 2 arquivo(s)): docs/health.md");
    expect(msg).toContain("Seu critério: o health está aqui");
    expect(msg).toContain("Dimensões que você NÃO conseguiu apontar");
    expect(msg).toContain("Interfaces HTTP ficaram de fora.");
  });

  it("o passe 1 recebe tamanho, cabeçalhos e o ORÇAMENTO — nenhum conteúdo de arquivo", () => {
    const msg = String(buildConnectDeclSelectRequest(grande).user_message);
    expect(msg).toContain("• 01-spec.md (PRIMÁRIO) — 100 chars");
    expect(msg).toContain("Health");
    expect(msg).toContain("ORÇAMENTO DO PASSE 2");
    expect(msg).not.toContain("xxxxxxxxxx");
  });
});

describe("toYaml — o consumidor é o PyYAML da fábrica", () => {
  it("cita toda string (acento, dois-pontos, cerquilha, quebra de linha)", () => {
    expect(toYaml({ a: "Responsabilidade: manter a posição # atual\ncom acento" }))
      .toBe('a: "Responsabilidade: manter a posição # atual\\ncom acento"');
  });

  it("booleano e número saem sem aspas; lista vazia é `[]`", () => {
    expect(toYaml({ ok: true, n: 3, l: [] })).toBe("ok: true\nn: 3\nl: []");
  });

  it("lista de objetos indenta com o primeiro par na linha do `-`", () => {
    const y = toYaml({ interfaces: [{ name: "a", type: "http" }, { name: "b", type: "event" }] });
    expect(y).toBe(
      "interfaces:\n" +
      '  - name: "a"\n' +
      '    type: "http"\n' +
      '  - name: "b"\n' +
      '    type: "event"',
    );
  });

  it("objeto aninhado indenta por nível", () => {
    expect(toYaml({ events: { publishes: ["x.y"] } })).toBe('events:\n  publishes:\n    - "x.y"');
  });

  it("declarationToYaml comenta o cabeçalho e termina com newline", () => {
    const y = declarationToYaml({ systemId: "s" }, ["linha um", "linha dois"]);
    expect(y).toBe('# linha um\n# linha dois\nsystemId: "s"\n');
  });
});
