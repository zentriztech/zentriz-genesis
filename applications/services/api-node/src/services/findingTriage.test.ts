import { describe, it, expect, vi } from "vitest";
import {
  normalizeText, normalizeCategory, findingFingerprint, findingTitleFingerprint, jaccard, isTriageable, matchTriage,
  enrichFindings, countFindings, deriveResolved, checkTriagePolicy, applyTriage, registerRecurrences, type TriageRow,
} from "./findingTriage.js";
import type { ValidationFinding } from "./specValidation.js";

const F = (o: Partial<ValidationFinding>): ValidationFinding => ({
  file: "spec.md", line: null, severity: "warning", title: "t", rationale: "", source: "stage_b", category: "other", anchor: null, ...o,
});
const T = (o: Partial<TriageRow>): TriageRow => ({
  id: "t1", project_id: "p", fingerprint: "x", state: "ignored", reason_code: "accepted_risk", reason: "", severity_at: "warning",
  finding_snapshot: {}, spec_hash_at: "", actor_user_id: null, actor_role: "user", expires_at: null, inherited_from: null,
  recurrence_count: 0, created_at: "2026-09-04T00:00:00Z", ...o,
});

describe("findingTriage — identidade (RFC-0005 §3)", () => {
  it("normaliza texto e categoria; fingerprint ignora linha/rationale/severidade/título quando há anchor", () => {
    expect(normalizeText("Falta modelo de dados: 'Usuário' (FR-03)!")).toBe("falta modelo de dados usuario fr");
    expect(normalizeCategory("Security_Gap")).toBe("security_gap");
    expect(normalizeCategory("qualquer coisa")).toBe("other");
    const a = F({ title: "Falta modelo de dados para Usuário", category: "missing_data_model", anchor: "FR-03", line: 10, severity: "warning" });
    const b = F({ title: "Modelo de dados de Usuário ausente", category: "missing_data_model", anchor: "fr-03", line: 42, severity: "blocker", rationale: "outro" });
    expect(findingFingerprint(a)).toBe(findingFingerprint(b));       // churn de título com mesmo category|anchor casa
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(F({ ...a, file: "contratos.md" })));
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(F({ ...a, category: "security_gap" })));
    // sem anchor → cai no título normalizado
    const c = F({ title: "Falta modelo de dados", category: "missing_data_model" });
    expect(findingFingerprint(c)).toBe(findingTitleFingerprint(c));
    expect(jaccard("Falta modelo de dados", "Modelo de dados falta")).toBe(1);
    expect(jaccard("Falta modelo de dados", "Modelo de dados ausente")).toBeLessThan(0.8);
  });

  it("matchTriage: cascata exato → título → Jaccard no mesmo file+category", () => {
    const base = F({ title: "Falta modelo de dados para Usuário", category: "missing_data_model", anchor: "FR-03" });
    const exact = T({ fingerprint: findingFingerprint(base), finding_snapshot: { file: "spec.md", category: "missing_data_model", title: base.title } });
    expect(matchTriage(F({ ...base, title: "Outro título", line: 99 }), [exact])?.id).toBe("t1");
    // antigo sem anchor → casa por fingerprint de título
    const old = F({ title: "Falta autenticação nas rotas", category: "security_gap" });
    const byTitle = T({ id: "t2", fingerprint: findingTitleFingerprint(old), finding_snapshot: { file: "spec.md", category: "security_gap", title: old.title } });
    expect(matchTriage(F({ ...old, anchor: "rotas" }), [byTitle])?.id).toBe("t2");
    // Jaccard: mesma ideia reordenada + 1 palavra a mais, mesmo file+category
    const jac = T({ id: "t3", fingerprint: "zzz", finding_snapshot: { file: "spec.md", category: "security_gap", title: "Rotas sem autenticação de usuário" } });
    expect(matchTriage(F({ title: "Autenticação de usuário sem rotas", category: "security_gap" }), [jac])?.id).toBe("t3");
    expect(matchTriage(F({ title: "Autenticação de usuário sem rotas", category: "missing_nfr" }), [jac])).toBeNull();
    expect(matchTriage(F({ title: "Autenticação de usuário sem rotas", category: "security_gap", file: "outro.md" }), [jac])).toBeNull();
  });

  it("não triáveis: blocker do Stage A e prompt_injection", () => {
    expect(isTriageable(F({ source: "stage_a", severity: "blocker" }))).toBe(false);
    expect(isTriageable(F({ source: "stage_a", severity: "warning" }))).toBe(true);
    expect(isTriageable(F({ category: "prompt_injection", severity: "info" }))).toBe(false);
    expect(isTriageable(F({ severity: "blocker" }))).toBe(true);
  });
});

describe("findingTriage — estado derivado (§4)", () => {
  const f1 = F({ title: "A", anchor: "a", category: "security_gap" });
  const f2 = F({ title: "B", anchor: "b", category: "missing_nfr" });
  const fA = F({ title: "Spec sem manifesto (README.md)", source: "stage_a", category: "structural", anchor: "no_readme" });

  it("enrich + counts: ativos, ignorados (expirado volta a ativo), refutados, blockers ativos, byCategory", () => {
    const tIgn = T({ fingerprint: findingFingerprint(f1), state: "ignored" });
    const tExp = T({ id: "t9", fingerprint: findingFingerprint(f2), state: "ignored", expires_at: "2020-01-01T00:00:00Z" });
    const bl = F({ title: "C", anchor: "c", severity: "blocker" });
    const tRef = T({ id: "t8", fingerprint: findingFingerprint(bl), state: "refuted", reason_code: "false_positive", severity_at: "warning" });
    const e = enrichFindings([f1, f2, bl, fA], [tIgn, tExp, tRef]);
    expect(e[0].triage?.state).toBe("ignored");
    expect(e[1].triage).toBeNull();                       // expirado → ativo
    expect(e[2].triage?.state).toBe("refuted");
    expect(e[2].triage?.severityChanged).toBe(true);
    expect(e[3].triageable).toBe(true);
    const c = countFindings(e, []);
    expect(c).toMatchObject({ active: 2, ignored: 1, refuted: 1, blockersActive: 0 });
    expect(c.byCategory).toEqual({ missing_nfr: 1, structural: 1 });
  });

  it("resolvido: Stage B exige 2 ausências consecutivas (anti-flapping); Stage A 1; arquivo removido marcado; reaparecer cancela", () => {
    const runs = [
      { id: "r3", created_at: "3", findings: [f2] },              // atual
      { id: "r2", created_at: "2", findings: [f2, fA] },
      { id: "r1", created_at: "1", findings: [f1, f2, fA] },
    ];
    let res = deriveResolved(runs, new Set(["spec.md"]));
    expect(res.map((r) => r.title).sort()).toEqual(["A", "Spec sem manifesto (README.md)"]); // A ausente em r2 e r3 (2); fA ausente em r3 (Stage A: 1)
    expect(res.find((r) => r.title === "A")?.absentRuns).toBe(2);
    // ausência em só 1 run (Stage B) → NÃO resolvido
    res = deriveResolved([{ id: "r2", created_at: "2", findings: [f2] }, { id: "r1", created_at: "1", findings: [f1, f2] }], null);
    expect(res).toEqual([]);
    // arquivo removido
    const fx = F({ title: "X", anchor: "x", file: "antigo.md" });
    res = deriveResolved([{ id: "r3", created_at: "3", findings: [] }, { id: "r2", created_at: "2", findings: [] }, { id: "r1", created_at: "1", findings: [fx] }], new Set(["spec.md"]));
    expect(res[0]).toMatchObject({ title: "X", fileRemoved: true, lastSeenRunId: "r1" });
    // menos de 2 runs → nada
    expect(deriveResolved([{ id: "r1", created_at: "1", findings: [f1] }], null)).toEqual([]);
  });
});

describe("findingTriage — política e transação (§5/§7)", () => {
  const user = { id: "11111111-1111-1111-1111-111111111111", role: "user" };
  const admin = { id: "22222222-2222-2222-2222-222222222222", role: "tenant_admin" };
  const bl = F({ severity: "blocker", anchor: "x" });

  it("checkTriagePolicy: papéis, reason_code, blocker, não triável", () => {
    const code = (r: ReturnType<typeof checkTriagePolicy>) => (r && !r.ok ? r.code : null);
    expect(checkTriagePolicy(F({}), user, { state: "ignored", reasonCode: "accepted_risk", reason: "" })).toBeNull();
    expect(code(checkTriagePolicy(F({}), { ...user, svc: "runner" }, { state: "ignored", reasonCode: "accepted_risk", reason: "" }))).toBe("FORBIDDEN");
    expect(code(checkTriagePolicy(F({}), { id: "z", role: "zentriz_admin" }, { state: "ignored", reasonCode: "accepted_risk", reason: "" }))).toBe("MANAGEMENT_ACCOUNT");
    expect(code(checkTriagePolicy(F({}), user, { state: "ignored", reasonCode: "false_positive", reason: "" }))).toBe("BAD_REASON_CODE");
    expect(code(checkTriagePolicy(F({}), user, { state: "refuted", reasonCode: "accepted_risk", reason: "" }))).toBe("BAD_REASON_CODE");
    expect(code(checkTriagePolicy(F({}), user, { state: "ignored", reasonCode: "xx" as never, reason: "" }))).toBe("BAD_REASON_CODE");
    expect(code(checkTriagePolicy(F({ source: "stage_a", severity: "blocker" }), admin, { state: "ignored", reasonCode: "accepted_risk", reason: "motivo suficientemente longo aqui" }))).toBe("FINDING_NOT_TRIAGEABLE");
    expect(code(checkTriagePolicy(bl, user, { state: "ignored", reasonCode: "accepted_risk", reason: "motivo suficientemente longo aqui" }))).toBe("BLOCKER_REQUIRES_TENANT_ADMIN");
    expect(code(checkTriagePolicy(bl, admin, { state: "ignored", reasonCode: "accepted_risk", reason: "curto" }))).toBe("REASON_TOO_SHORT");
    expect(checkTriagePolicy(bl, admin, { state: "refuted", reasonCode: "false_positive", reason: "motivo suficientemente longo aqui" })).toBeNull();
  });

  it("applyTriage: BEGIN/FOR UPDATE/COMMIT; mesmo estado vivo → idempotente; estado diferente → revoga e insere; refutado não expira", async () => {
    const calls: string[] = [];
    let live: TriageRow | undefined;
    const db = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push(sql.split(" ")[0]);
      if (/FOR UPDATE/.test(sql)) return { rows: live ? [live as unknown as Record<string, unknown>] : [] };
      if (/INSERT INTO spec_finding_triage/.test(sql)) {
        live = T({ id: "new", fingerprint: params[1] as string, state: params[2] as "ignored", reason_code: params[3] as never, reason: params[4] as string, expires_at: (params[10] as string | null) ?? null });
        return { rows: [live as unknown as Record<string, unknown>] };
      }
      return { rows: [] };
    }) };
    const f = F({ anchor: "a" });
    const r1 = await applyTriage(db as never, { projectId: "p", finding: f, actor: user, state: "ignored", reasonCode: "accepted_risk", reason: "", expiresAt: "2030-01-01T00:00:00Z" });
    expect(r1.ok && r1.created).toBe(true);
    expect(calls).toEqual(["BEGIN", "SELECT", "INSERT", "COMMIT"]);
    calls.length = 0;
    const r2 = await applyTriage(db as never, { projectId: "p", finding: f, actor: user, state: "ignored", reasonCode: "accepted_risk", reason: "" });
    expect(r2.ok && !r2.created).toBe(true);
    expect(calls).toEqual(["BEGIN", "SELECT", "COMMIT"]);
    calls.length = 0;
    const r3 = await applyTriage(db as never, { projectId: "p", finding: f, actor: user, state: "refuted", reasonCode: "false_positive", reason: "" });
    expect(r3.ok && r3.created).toBe(true);
    expect(calls).toEqual(["BEGIN", "SELECT", "UPDATE", "INSERT", "COMMIT"]);
    expect(live?.expires_at).toBeNull();
    const r4 = await applyTriage(db as never, { projectId: "p", finding: f, actor: user, state: "refuted", reasonCode: "false_positive", reason: "", expiresAt: "2030-01-01" });
    expect(r4.ok).toBe(false); expect(!r4.ok && r4.code).toBe("REFUTED_NO_EXPIRY");
  });

  it("registerRecurrences: reincidência sobre refutado vivo conta (só triáveis); casa por título reformulado", async () => {
    const ref = F({ title: "Falta autenticação nas rotas", category: "security_gap", anchor: "rotas" });
    const tr = T({ id: "t7", fingerprint: findingFingerprint(ref), state: "refuted", reason_code: "false_positive", finding_snapshot: { file: "spec.md", category: "security_gap", title: ref.title } });
    const updates: unknown[][] = [];
    const db = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM spec_finding_triage/.test(sql)) return { rows: [tr as unknown as Record<string, unknown>] };
      if (/recurrence_count = recurrence_count \+ 1/.test(sql)) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    }) };
    const n = await registerRecurrences(db as never, "p", [F({ title: "Rotas sem autenticação", category: "security_gap", anchor: "Rotas" }), F({ title: "outro", anchor: "z" })]);
    expect(n).toBe(1);
    expect(updates[0][0]).toEqual(["t7"]);
    // não triável nunca é auto-refutado
    const n2 = await registerRecurrences(db as never, "p", [F({ ...ref, category: "prompt_injection" })]);
    expect(n2).toBe(0);
  });
});
