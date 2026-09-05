/**
 * specChatJobs.test.ts — o julgamento do resultado do CTO (correção 2026-09-05).
 *
 * O QUE ISTO PROTEGE: em prod a Bancada respondia `O CTO não conseguiu revisar (BLOCKED).
 * Reformule o pedido e tente de novo.` — mensagem que (a) escondia o motivo real, já presente
 * no envelope, e (b) DESCARTAVA a spec inteira que o agente havia produzido (~20 min de Opus 5)
 * só porque o enforcer reprovou metadados. As três funções abaixo são o coração do fix:
 *   • `ctoFailureReason` — extrai o motivo (validation_errors > cauda "; Enforcer:" > error/reason);
 *   • `salvageableSpec` — recupera o artefato .md substancial, NUNCA o summary;
 *   • `judgeCtoResult` — mantém `status: "error"` mas devolve a spec para ser OFERECIDA.
 */
import { describe, it, expect } from "vitest";
import {
  ctoFailureReason,
  salvageableSpec,
  judgeCtoResult,
  findInFlightSpecChatJob,
  isTruncatedResult,
  recordCtoUsage,
  TRUNCATED_WARNING,
  WORKBENCH_CTO_AGENT,
} from "./specChatJobs.js";

/** Extrator equivalente ao da rota (`extractSpecMarkdown`): artefato .md primeiro, fallback no
 *  summary — é exatamente esse fallback que obriga `salvageableSpec` a olhar só artefatos. */
const extract = (r: Record<string, unknown>): string => {
  const arts = Array.isArray(r.artifacts) ? (r.artifacts as Array<Record<string, unknown>>) : [];
  const md = arts.find((a) => typeof a?.content === "string" && String(a?.path ?? "").endsWith(".md"));
  if (md) return String(md.content);
  return typeof r.summary === "string" ? r.summary : "";
};

const bigSpec = `# PRODUCT SPEC\n\n## 1. Contexto\n${"Conteúdo substantivo da spec revisada. ".repeat(80)}`;

describe("ctoFailureReason", () => {
  it("prefere validation_errors (máx. 3) ao texto genérico", () => {
    const reason = ctoFailureReason({
      status: "BLOCKED",
      validation_errors: ["status=OK exige evidence não vazio", "artifacts[0].path bloqueado", "terceiro", "QUARTO_IGNORADO"],
    });
    expect(reason).toContain("evidence não vazio");
    expect(reason).toContain("path bloqueado");
    expect(reason).toContain("terceiro");
    expect(reason).not.toContain("QUARTO_IGNORADO");
  });

  it("extrai a cauda '; Enforcer: ...' do summary quando não há validation_errors", () => {
    const reason = ctoFailureReason({
      status: "BLOCKED",
      summary: "Spec revisada com sucesso; Enforcer: envelope sem evidência de leitura da spec base",
    });
    expect(reason).toBe("envelope sem evidência de leitura da spec base");
  });

  it("cai para error/reason/blocked_reason e recorta em 240 caracteres", () => {
    expect(ctoFailureReason({ error: "timeout no provedor" })).toBe("timeout no provedor");
    const longo = ctoFailureReason({ reason: "x".repeat(500) })!;
    expect(longo.length).toBeLessThanOrEqual(241);
    expect(longo.endsWith("…")).toBe(true);
  });

  it("devolve null quando o envelope não diz nada de útil", () => {
    expect(ctoFailureReason({ status: "BLOCKED", summary: "Revisão concluída." })).toBeNull();
    expect(ctoFailureReason({})).toBeNull();
  });
});

describe("salvageableSpec", () => {
  it("recupera o artefato .md substancial", () => {
    const got = salvageableSpec({
      artifacts: [{ path: "docs/spec/PRODUCT_SPEC.md", content: bigSpec }],
    });
    expect(got).toBe(bigSpec);
  });

  it("IGNORA o summary — oferecê-lo sobrescreveria a spec real com um resumo", () => {
    expect(salvageableSpec({ summary: bigSpec, artifacts: [] })).toBeNull();
  });

  it("ignora artefatos curtos (não são uma spec)", () => {
    expect(salvageableSpec({ artifacts: [{ path: "docs/spec/PRODUCT_SPEC.md", content: "# Spec\n\nTODO" }] })).toBeNull();
  });

  it("ignora artefato substancial que não parece spec", () => {
    expect(salvageableSpec({ artifacts: [{ path: "apps/src/index.ts", content: bigSpec }] })).toBeNull();
  });
});

describe("judgeCtoResult", () => {
  it("OK com spec → done, com reply", () => {
    const patch = judgeCtoResult(
      { status: "OK", summary: "Resolvi os 3 blockers.", artifacts: [{ path: "docs/spec/PRODUCT_SPEC.md", content: bigSpec }], model_used: "opus-5" },
      extract,
    );
    expect(patch.status).toBe("done");
    expect(patch.specMarkdown).toBe(bigSpec);
    expect(patch.reply).toBe("Resolvi os 3 blockers.");
    expect(patch.modelUsed).toBe("opus-5");
  });

  it("BLOCKED com spec → error COM o motivo E a spec recuperada (oferece, não aplica)", () => {
    const patch = judgeCtoResult(
      {
        status: "BLOCKED",
        summary: "Revisão pronta; Enforcer: evidence vazio",
        artifacts: [{ path: "docs/spec/PRODUCT_SPEC.md", content: bigSpec }],
      },
      extract,
    );
    expect(patch.status).toBe("error");
    expect(patch.error).toContain("(BLOCKED)");
    expect(patch.error).toContain("evidence vazio");
    expect(patch.error).toContain("recuperada");
    // A spec segue no patch → `finishSpecChatJob` a persiste e a tela a OFERECE.
    expect(patch.specMarkdown).toBe(bigSpec);
  });

  it("BLOCKED sem artefato aproveitável → error puro, sem specMarkdown", () => {
    const patch = judgeCtoResult({ status: "BLOCKED", summary: "não consegui" }, extract);
    expect(patch.status).toBe("error");
    expect(patch.specMarkdown).toBeNull();
    expect(patch.error).toContain("Reformule o pedido");
  });

  it("status OK mas spec vazia/minúscula → error (não grava lixo no editor)", () => {
    const patch = judgeCtoResult({ status: "OK", summary: "ok" }, extract);
    expect(patch.status).toBe("error");
    expect(patch.error).toContain("não retornou uma spec revisada válida");
  });

  // ── T1 (2026-09-05): o corte no teto de saída viajava INVISÍVEL até o editor ──
  it("OK + _truncated → segue done, MAS marcado e com o aviso na reply", () => {
    const patch = judgeCtoResult(
      { status: "OK", summary: "Resolvi tudo.", artifacts: [{ path: "docs/spec/PRODUCT_SPEC.md", content: bigSpec }], _truncated: true, _model: "opus-5" },
      extract,
    );
    // `done` de propósito: o parcial tem valor. Quem protege é a marca (UI oferece, autônomo recusa).
    expect(patch.status).toBe("done");
    expect(patch.truncated).toBe(true);
    expect(patch.reply).toContain(TRUNCATED_WARNING);
    expect(patch.specMarkdown).toBe(bigSpec);
  });

  it("sem _truncated → truncated=false e reply LIMPA (nada de aviso fantasma)", () => {
    const patch = judgeCtoResult(
      { status: "OK", summary: "Resolvi tudo.", artifacts: [{ path: "docs/spec/PRODUCT_SPEC.md", content: bigSpec }] },
      extract,
    );
    expect(patch.truncated).toBe(false);
    expect(patch.reply).not.toContain("CORTADA");
  });

  it("BLOCKED + _truncated → o aviso de corte acompanha o motivo da reprovação", () => {
    const patch = judgeCtoResult(
      { status: "BLOCKED", summary: "parcial; Enforcer: evidence vazio", artifacts: [{ path: "docs/spec/PRODUCT_SPEC.md", content: bigSpec }], _truncated: true },
      extract,
    );
    expect(patch.status).toBe("error");
    expect(patch.truncated).toBe(true);
    expect(patch.error).toContain("CORTADA");
  });

  // G9: `model_used` ficava NULL em todo job vindo do /invoke/cto/async (o envelope usa `_model`).
  it("modelUsed cai para `_model` quando não há `model_used` (fecha o NULL do cto/async)", () => {
    const patch = judgeCtoResult(
      { status: "OK", summary: "ok", artifacts: [{ path: "docs/spec/PRODUCT_SPEC.md", content: bigSpec }], _model: "us.anthropic.claude-opus-5" },
      extract,
    );
    expect(patch.modelUsed).toBe("us.anthropic.claude-opus-5");
  });
});

describe("isTruncatedResult", () => {
  it("só `true` estrito conta (string 'true' não é sinal do runtime)", () => {
    expect(isTruncatedResult({ _truncated: true })).toBe(true);
    expect(isTruncatedResult({ _truncated: "true" })).toBe(false);
    expect(isTruncatedResult({})).toBe(false);
  });
});

// ── G5: o CTO da Bancada não era debitado em project_agent_metrics ────────────
describe("recordCtoUsage", () => {
  const envelope = { status: "OK", _input_tokens_total: 100_900, _output_tokens_total: 58_200, _input_tokens: 40_000, _output_tokens: 20_000, _llm_calls: 2, _model: "opus-5", _duration_ms: 96_000 };

  it("debita usando os TOTAIS (repairs pagos) com task_id idempotente", async () => {
    let sql = ""; let params: unknown[] = [];
    const db = { query: async (q: string, p: unknown[]) => { sql = q; params = p; return { rows: [], rowCount: 1 }; } } as never;
    const ok = await recordCtoUsage(db, { id: "job-9", projectId: "proj-1", kind: "resolve_gaps" }, envelope);
    expect(ok).toBe(true);
    expect(sql).toContain("INSERT INTO project_agent_metrics");
    expect(sql).toContain("WHERE NOT EXISTS");
    expect(params[1]).toBe(WORKBENCH_CTO_AGENT);
    expect(params[2]).toBe("spec_chat:job-9");
    // TOTAL, não a última chamada — senão os repairs da LEI 5 sairiam de graça.
    expect(params[3]).toBe(100_900);
    expect(params[4]).toBe(58_200);
    expect(params[5]).toBe("opus-5");
  });

  it("cai para `_input_tokens` quando o envelope é antigo (agents não redeployado)", async () => {
    let params: unknown[] = [];
    const db = { query: async (_q: string, p: unknown[]) => { params = p; return { rows: [], rowCount: 1 }; } } as never;
    await recordCtoUsage(db, { id: "j", projectId: "p", kind: "chat" }, { status: "OK", _input_tokens: 7, _output_tokens: 9 });
    expect(params[3]).toBe(7);
    expect(params[4]).toBe(9);
  });

  it("NÃO debita kind='file' — /invoke/raw já reporta pelo _report_direct_usage (dupla contagem)", async () => {
    let called = false;
    const db = { query: async () => { called = true; return { rows: [], rowCount: 1 }; } } as never;
    expect(await recordCtoUsage(db, { id: "j", projectId: "p", kind: "file" }, envelope)).toBe(false);
    expect(called).toBe(false);
  });

  it("sem projeto ou sem tokens → não escreve nada", async () => {
    let called = false;
    const db = { query: async () => { called = true; return { rows: [], rowCount: 1 }; } } as never;
    expect(await recordCtoUsage(db, { id: "j", projectId: null, kind: "chat" }, envelope)).toBe(false);
    expect(await recordCtoUsage(db, { id: "j", projectId: "p", kind: "chat" }, { status: "OK" })).toBe(false);
    expect(called).toBe(false);
  });

  it("segunda coleta do MESMO job não duplica (rowCount 0 → false)", async () => {
    const db = { query: async () => ({ rows: [], rowCount: 0 }) } as never;
    expect(await recordCtoUsage(db, { id: "job-9", projectId: "p", kind: "chat" }, envelope)).toBe(false);
  });

  it("falha de banco NUNCA derruba a entrega da revisão", async () => {
    const db = { query: async () => { throw new Error("db down"); } } as never;
    expect(await recordCtoUsage(db, { id: "j", projectId: "p", kind: "chat" }, envelope)).toBe(false);
  });
});

describe("findInFlightSpecChatJob", () => {
  const row = {
    id: "job-1", project_id: "p1", tenant_id: null, owner_user_id: "u1", agents_job_id: "a1",
    kind: "chat", file_path: null, base_sha: null, base_spec_sha: null,
    status: "error", reply: null, error: "O CTO não conseguiu revisar (BLOCKED): evidence vazio",
    created_at: "2026-09-05T10:00:00Z", finished_at: null, collected_at: null, deadline_at: null,
    has_spec: true,
  };

  it("aceita job REPROVADO que ainda guarda spec e marca hasSpecMarkdown sem trazer os ~95 KB", async () => {
    let sql = "";
    const db = { query: async (q: string) => { sql = q; return { rows: [row], rowCount: 1 }; } } as never;
    const job = await findInFlightSpecChatJob(db, { projectId: "p1", filePath: null, ownerUserId: "u1" });
    expect(job?.status).toBe("error");
    expect(job?.hasSpecMarkdown).toBe(true);
    // O corpo NÃO vem na query do in-flight (roda a cada mount da tela).
    expect(job?.specMarkdown).toBeNull();
    expect(sql).not.toMatch(/\bspec_markdown\b(?!\s+IS NOT NULL)/);
    expect(sql).toContain("status IN ('error','interrupted','lost') AND spec_markdown IS NOT NULL AND collected_at IS NULL");
  });

  it("hasSpecMarkdown falso quando o job reprovado não guardou nada", async () => {
    const db = { query: async () => ({ rows: [{ ...row, has_spec: false }], rowCount: 1 }) } as never;
    const job = await findInFlightSpecChatJob(db, { projectId: "p1", filePath: null, ownerUserId: "u1" });
    expect(job?.hasSpecMarkdown).toBe(false);
  });

  it("falha de banco degrada para null (nunca derruba o chat)", async () => {
    const db = { query: async () => { throw new Error("db down"); } } as never;
    expect(await findInFlightSpecChatJob(db, { projectId: "p1", filePath: null, ownerUserId: "u1" })).toBeNull();
  });
});
