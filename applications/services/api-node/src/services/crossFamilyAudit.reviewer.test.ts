/**
 * GRUPO C — o defeito que fazia a auditoria "cross-family" ser auto-revisão em silêncio —
 * e a LEI 2026-09-10, que mudou de onde o auditor VEM.
 *
 * 1º defeito (Grupo C): `auditFindings` montava `model_id: AUDIT_MODEL` **antes** de espalhar
 *    `args.llm`. Como o envelope do tenant também traz `model_id`, o modelo do TENANT sobrescrevia o
 *    auditor: o módulo cujo nome é "cross-family" pedia parecer ao MESMO modelo que escreveu a
 *    acusação — a configuração que `arXiv:2609.04270` mede como zero ganho e 35% de rejeição falsa.
 *
 * 2º defeito (LEI do Jean): o candidato saía de `SPEC_CROSS_AUDIT_MODEL` — um modelo escolhido pela
 *    infra e **cobrado na credencial do slot Padrão do tenant**. Além do hard-code proibido, isso só
 *    funcionava enquanto todo mundo era Bedrock: pedir `amazon.nova-pro` ao Foundry (que nesta conta
 *    só tem Claude) é 400 na cara. Agora cada SLOT concorre com o próprio provider e a própria chave.
 *
 * Os testes prendem as três metades: quem é escolhido, com qual envelope, e o que acontece quando
 * ninguém serve (ALERTA e ZERO chamada de LLM — rodar com o modelo do tenant seria o bug de volta).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { httpPostMock } = vi.hoisted(() => ({ httpPostMock: vi.fn() }));
vi.mock("../routes/specs.js", () => ({ httpPost: httpPostMock }));

const PROJ = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";

/** Slots que o tenant cadastrou na tela — a ÚNICA fonte de candidato a revisor. */
let slotRows: Record<string, unknown>[] = [];
const poolQuery = vi.fn(async (sql: string) => {
  if (sql.includes("FROM tenant_llm_configs")) return { rows: slotRows };
  if (sql.includes("FROM projects")) return { rows: [{ tenant_id: TENANT }] };
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({ pool: { query: (s: string) => poolQuery(s) } }));

import { auditFindings } from "./crossFamilyAudit.js";
import type { Db } from "./findingTriage.js";
import type { ValidationFinding } from "./specValidation.js";

const AWS = { aws_access_key_id: "AKIA", aws_secret_access_key: "s", aws_region: "us-east-1" };
const slot = (over: Record<string, unknown>) => ({
  provider: "bedrock", model_id: "us.anthropic.claude-opus-5", model_id_fallback: null,
  credentials: AWS, max_concurrent_projects: 3, daily_token_quota: null,
  deadpool_token_reserve: 0, priority: 0, byoc_exempt: false, ...over,
});

const finding: ValidationFinding = {
  file: "spec.md", line: null, severity: "blocker", title: "Camada de integração contraditória",
  rationale: "diz tier1 numa seção e tier2 noutra", source: "stage_b",
  category: "stack_inconsistent", anchor: "§1.1",
};

/** Banco com UM arquivo de spec real em disco (o auditor precisa do texto verbatim). */
function dbComArquivo(): Db {
  const dir = mkdtempSync(join(tmpdir(), "cfa-"));
  const filePath = join(dir, "spec.md");
  writeFileSync(filePath, "# Produto\n\n## §1.1 Integração\n\nintegrationTier: tier1-sync-only\n");
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM project_spec_files")) {
        return { rows: [{ filename: "spec.md", rel_dir: "", file_path: filePath, is_primary: true }] as never };
      }
      return { rows: [] as never };
    },
  } as unknown as Db;
}

/** Banco SEM arquivo: serve para provar que a seleção passou (o veto viria antes desta consulta). */
const dbVazio = { query: async () => ({ rows: [] }) } as unknown as Db;

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.SPEC_CROSS_AUDIT = "on";
  process.env.API_AGENTS_URL = "http://agents:8000";
  delete process.env.GENESIS_LLM_PROVIDER;
  delete process.env.SPEC_CROSS_AUDIT_MODEL;
  slotRows = [];
  httpPostMock.mockReset();
  poolQuery.mockClear();
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("auditFindings — o auditor sai dos SLOTS do tenant, e é escolhido, não herdado", () => {
  // Executor topo + slot que é a variante PEQUENA da própria linha ⇒ a linha inerte do paper
  // (0 respostas mudadas, dobro do custo). O `nova-pro`, mid-tier, NÃO cai aqui: é justamente a
  // configuração medida em +12 p.p. — recusá-la era o defeito da faixa única de poder (2026-09-10).
  it("slot revisor PEQUENO (flash) contra executor opus ⇒ ALERTA e ZERO chamada de LLM", async () => {
    slotRows = [
      slot({ priority: 0 }),
      slot({ provider: "google", model_id: "gemini-2.5-flash", credentials: { google_api_key: "AIza" }, priority: 1 }),
    ];
    const r = await auditFindings(dbVazio, {
      projectId: PROJ, findings: [finding],
      llm: { model_id: "us.anthropic.claude-opus-5", llm_config: { provider: "bedrock" } },
    });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("PEQUENA");
    expect(httpPostMock).not.toHaveBeenCalled();
  });

  it("todos os slots da MESMA família do executor ⇒ ALERTA (auto-revisão não é revisão)", async () => {
    slotRows = [
      slot({ priority: 0 }),
      slot({ provider: "foundry", model_id: "claude-opus-4-8", credentials: { foundry_api_key: "k" }, priority: 1 }),
    ];
    const r = await auditFindings(dbVazio, {
      projectId: PROJ, findings: [finding],
      llm: { model_id: "us.anthropic.claude-opus-5", llm_config: { provider: "bedrock" } },
    });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("MESMA família");
    // O alerta tem de dizer o que fazer: slot de outra família é ação do tenant, na tela.
    expect(r.reason).toContain("Configurações → LLM");
    expect(httpPostMock).not.toHaveBeenCalled();
  });

  // 🔴 LEI 2026-09-10: o envelope INTEIRO é o do slot revisor. Antes viajava a credencial do slot
  // PRIMÁRIO com o id de outra família — 400/401 assim que os dois slots não fossem o mesmo provider.
  it("havendo slot viável, vão o modelo E as credenciais DELE — não as do slot primário", async () => {
    httpPostMock.mockResolvedValue(JSON.stringify({
      response: '{"verdict":"ausente","gravity":"","evidence":"integrationTier: tier1-sync-only","why":"conforme"}',
    }));
    slotRows = [
      slot({ provider: "foundry", model_id: "claude-sonnet-5", credentials: { foundry_api_key: "chave-foundry" }, priority: 0 }),
      slot({ provider: "bedrock", model_id: "amazon.nova-pro-v1:0", credentials: AWS, priority: 1 }),
    ];
    const r = await auditFindings(dbComArquivo(), {
      projectId: PROJ, findings: [finding],
      llm: { model_id: "claude-sonnet-5", llm_config: { provider: "foundry", foundry_api_key: "chave-foundry" } },
    });
    expect(r.ran).toBe(true);
    const body = JSON.parse(httpPostMock.mock.calls[0][1] as string) as Record<string, unknown>;
    // o modelo do AUDITOR venceu o do tenant (era o inverso — este é o Grupo C)
    expect(body.model_id).toBe("amazon.nova-pro-v1:0");
    // e o provider/credencial vieram do slot 1, não do slot 0 que executou
    expect(body.llm_config).toEqual({
      provider: "bedrock", model: "amazon.nova-pro-v1:0",
      aws_access_key_id: "AKIA", aws_secret_access_key: "s", aws_region: "us-east-1",
    });
    expect(r.model).toBe("amazon.nova-pro-v1:0");
    expect(r.audits[0]?.model).toBe("amazon.nova-pro-v1:0");
  });

  it("os slots são percorridos NA ORDEM cadastrada até achar um que sirva", async () => {
    slotRows = [
      slot({ priority: 0 }),                                                    // executor: mesma família
      slot({ provider: "google", model_id: "gemini-2.5-flash", credentials: { google_api_key: "AIza" }, priority: 1 }),
      slot({ provider: "bedrock", model_id: "mistral.mistral-large-3-675b-instruct", credentials: AWS, priority: 2 }),
    ];
    const r = await auditFindings(dbVazio, {
      projectId: PROJ, findings: [finding],
      llm: { model_id: "us.anthropic.claude-opus-5", llm_config: { provider: "bedrock" } },
    });
    // 1º recusado por MESMA família, 2º por porte pequeno ⇒ ficou o 3º; passou da seleção e morreu
    // na falta de arquivo de spec (o veto pararia ANTES desta consulta).
    expect(r.reason).toContain("projeto sem arquivos de spec");
  });

  // A lei tem dente: slot sem credencial PRÓPRIA não é candidato — auditar na conta da Zentriz é
  // exatamente a fatura que o Jean mandou parar de pagar.
  it("slot de outra família SEM credencial própria não vira revisor", async () => {
    slotRows = [
      slot({ priority: 0 }),
      slot({ provider: "bedrock", model_id: "amazon.nova-pro-v1:0", credentials: {}, priority: 1 }),
    ];
    const r = await auditFindings(dbVazio, {
      projectId: PROJ, findings: [finding],
      llm: { model_id: "us.anthropic.claude-opus-5", llm_config: { provider: "bedrock" } },
    });
    expect(r.ran).toBe(false);
    expect(httpPostMock).not.toHaveBeenCalled();
  });

  it("tenant sem slot nenhum ⇒ ALERTA, nunca um modelo de env", async () => {
    process.env.SPEC_CROSS_AUDIT_MODEL = "amazon.nova-pro-v1:0"; // a env não pode mais ressuscitar
    slotRows = [];
    const r = await auditFindings(dbVazio, {
      projectId: PROJ, findings: [finding],
      llm: { model_id: "us.anthropic.claude-opus-5", llm_config: { provider: "bedrock" } },
    });
    expect(r.ran).toBe(false);
    expect(r.reason).toContain("nenhum slot de LLM utilizável");
    expect(r.model).toBe("");
    expect(httpPostMock).not.toHaveBeenCalled();
  });
});
