/**
 * platformLlmConfig.test.ts — a fila de LLM da CONTA DE GESTÃO.
 *
 * O que está travado aqui é o desenho que concilia o agente interno com a LEI dos slots
 * (2026-09-10): a Zentriz pode pagar o trabalho INTERNO dela, mas só por uma linha de banco
 * explícita, com credencial própria — nunca por `.env` e nunca herdando de tenant.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  erro: null as (Error & { code?: string }) | null,
}));

vi.mock("../db/client.js", () => ({
  pool: {
    query: async () => {
      if (db.erro) throw db.erro;
      return { rows: db.rows };
    },
  },
}));

import {
  getPlatformSlots, platformSlotUsable, resolvePlatformCandidates,
  PlatformLlmNotConfiguredError,
} from "./platformLlmConfig.js";

const SLOT = (over: Record<string, unknown> = {}) => ({
  id: "s0", priority: 0, provider: "foundry", model_id: "claude-opus-5",
  model_id_fallback: null, label: null, is_active: true,
  credentials: { foundry_api_key: "CHAVE" },
  verified_at: null, verify_status: null, verify_error: null,
  verify_model: null, verify_latency_ms: null,
  ...over,
});

beforeEach(() => { db.rows = []; db.erro = null; });

describe("getPlatformSlots", () => {
  it("lê a fila em ORDEM e devolve a credencial de cada slot", async () => {
    db.rows = [SLOT(), SLOT({ id: "s1", priority: 1, provider: "bedrock",
      model_id: "us.anthropic.claude-opus-4-6-v1",
      credentials: { aws_access_key_id: "AKIA_G", aws_secret_access_key: "S" } })];
    const s = await getPlatformSlots();
    expect(s.map((x) => x.priority)).toEqual([0, 1]);
    expect(s[1].credentials.aws_access_key_id).toBe("AKIA_G");
  });

  it("migration ausente (42P01/42703) vira fila vazia — o resto PROPAGA", async () => {
    db.erro = Object.assign(new Error('relation "zentriz_llm_config" does not exist'), { code: "42P01" });
    expect(await getPlatformSlots()).toEqual([]);
    db.erro = Object.assign(new Error("column verify_model does not exist"), { code: "42703" });
    expect(await getPlatformSlots()).toEqual([]);
    // Banco fora do ar NÃO pode virar "não configurado": mandaria o operador criar um slot que já
    // existe, e o diagnóstico verdadeiro (a conexão) ficaria escondido.
    db.erro = Object.assign(new Error("connection terminated"), { code: "57P01" });
    await expect(getPlatformSlots()).rejects.toThrow(/connection terminated/);
  });
});

describe("platformSlotUsable — a gestão paga, mas declaradamente", () => {
  it("exige credencial PRÓPRIA: não há isenção BYOC na conta de gestão", async () => {
    db.rows = [SLOT({ credentials: {} })];
    const [s] = await getPlatformSlots();
    expect(platformSlotUsable(s)).toBe(false);
  });
  it("slot inativo, sem provider ou sem modelo não serve", async () => {
    db.rows = [SLOT({ is_active: false }), SLOT({ id: "b", provider: "" }), SLOT({ id: "c", model_id: "" })];
    const s = await getPlatformSlots();
    expect(s.every(platformSlotUsable)).toBe(false);
  });
});

describe("resolvePlatformCandidates", () => {
  it("sem slot utilizável FALHA ALTO — não existe caminho para o env", async () => {
    db.rows = [SLOT({ credentials: {} })];
    await expect(resolvePlatformCandidates()).rejects.toBeInstanceOf(PlatformLlmNotConfiguredError);
  });

  it("cada candidato viaja com a credencial DELE (defeito do Grupo C)", async () => {
    db.rows = [SLOT(), SLOT({ id: "s1", priority: 1, provider: "bedrock",
      model_id: "us.anthropic.claude-opus-4-6-v1",
      credentials: { aws_access_key_id: "AKIA_G", aws_secret_access_key: "S", aws_region: "us-east-1" } })];
    const c = await resolvePlatformCandidates();
    expect(c[0].foundryApiKey).toBe("CHAVE");
    expect(c[1].awsAccessKeyId).toBe("AKIA_G");
    expect(c[1].foundryApiKey).toBeUndefined();
    // `isDefault` marca o LLM que ninguém escolheu; aqui alguém escolheu, numa linha de banco.
    expect(c.every((x) => x.isDefault === false)).toBe(true);
  });
});
