/**
 * connectDeclaration.test.ts — GAP-133: o que este arquivo PROVA.
 *
 * O valor do módulo não é "gerar YAML": é (a) a identidade vir do sistema e não do LLM, (b) todo
 * descarte ser DECLARADO, (c) vocabulário fechado ser lido DO SCHEMA e (d) a serialização não
 * corromper texto em PT-BR (acento, `:`, `#`) — que é o que o consumidor Python vai ler.
 */
import { describe, it, expect } from "vitest";
import {
  assembleDeclaration, extractDeclarationJson, toYaml, declarationToYaml, schemaEnum,
  type ConnectDeclContext,
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
