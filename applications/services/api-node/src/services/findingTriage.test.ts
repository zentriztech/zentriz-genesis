import { describe, it, expect, vi } from "vitest";
import {
  normalizeText, normalizeCategory, findingFingerprint, findingTitleFingerprint, jaccard, isTriageable, matchTriage,
  enrichFindings, countFindings, deriveResolved, checkTriagePolicy, applyTriage, registerRecurrences, type TriageRow,
  surveyFindings, judgedFilesOf, projectFindingsState, unionFindingsByCoverage, gapDelta, gapDeltaSinceLastRun,
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
    // adversarial G1-A: dígitos do anchor PRESERVADOS — FR-03 ≠ FR-04; "## 3. Modelo" ≠ "## 5. Modelo"
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(F({ ...a, anchor: "FR-04" })));
    expect(findingFingerprint(F({ ...a, anchor: "## 3. Modelo" }))).not.toBe(findingFingerprint(F({ ...a, anchor: "## 5. Modelo" })));
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

  it("colisão dentro da run (mesmo file|category|anchor, problemas distintos) → fingerprint efetivo por título; únicos mantêm o primário (E2E 2026-09-04)", async () => {
    const { effectiveFingerprints } = await import("./findingTriage.js");
    const a = F({ title: "Ausência de rate limiting e volumetria", category: "missing_nfr", anchor: "## 6. Não funcionais" });
    const b = F({ title: "LGPD/PII não endereçada", category: "missing_nfr", anchor: "## 6. Não funcionais" });
    const c = F({ title: "Único", category: "security_gap", anchor: "FR-01" });
    const fps = effectiveFingerprints([a, b, c]);
    expect(fps[0]).not.toBe(fps[1]);
    expect(fps[0]).toBe(findingTitleFingerprint(a));
    expect(fps[2]).toBe(findingFingerprint(c));
    // enrichFindings expõe o efetivo e casa a triagem gravada com ele
    const tr = T({ fingerprint: fps[1], state: "ignored" });
    const e = enrichFindings([a, b, c], [tr]);
    expect(e[0].triage).toBeNull(); expect(e[1].triage?.state).toBe("ignored"); expect(e[1].fingerprint).toBe(fps[1]);
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

/**
 * 🔴 GAP-20 — ausência só é prova se ALGUÉM OLHOU.
 *
 * Medido em prod 2026-09-06 (NVX LastMile): 4 runs seguidas com o MESMO `spec_hash` (721cb185 — spec
 * byte-idêntica, zero edição) devolveram 14 / 15 / 22 GAPs "ativos" e **110 findings RESOLVIDOS**,
 * incluindo dezenas de blockers. Causa: com a rotação de cobertura (GAP-18) cada validação julga um
 * subconjunto diferente dos 12 arquivos; quem não entrou "desaparecia" e virava resolvido sozinho.
 */
describe("findingTriage — GAP-20: cobertura decide o que é ausência", () => {
  const cov = (...full: string[]) => ({ full, outlineOnly: [], oversized: [], cap: 400000, totalChars: 1 });
  const gA = F({ file: "a.md", title: "GAP de A", anchor: "a1" });
  const gB = F({ file: "b.md", title: "GAP de B", anchor: "b1" });

  it("judgedFilesOf: só `full` conta; cobertura ausente/inválida = desconhecida", () => {
    expect(judgedFilesOf(cov("A.md"))?.has("a.md")).toBe(true);
    expect(judgedFilesOf(null)).toBeNull();
    expect(judgedFilesOf({ outlineOnly: ["a.md"] })).toBeNull();
  });

  it("🔴 o caso de prod: rodadas que NÃO julgaram o arquivo não resolvem nem tiram dos ativos", () => {
    // r3 e r2 julgaram só `b.md`; `a.md` foi julgado pela última vez em r1 e continua com o GAP.
    const runs = [
      { id: "r3", created_at: "3", findings: [gB], coverage: cov("b.md") },
      { id: "r2", created_at: "2", findings: [gB], coverage: cov("b.md") },
      { id: "r1", created_at: "1", findings: [gA, gB], coverage: cov("a.md", "b.md") },
    ];
    const s = surveyFindings(runs, new Set(["a.md", "b.md"]));
    expect(s.active.map((f) => f.title).sort()).toEqual(["GAP de A", "GAP de B"]);
    expect(s.resolved).toEqual([]);
    // Antes da correção: `a.md` ausente em 2 runs ⇒ resolvido sem ninguém ter corrigido.
    expect(deriveResolved(runs.map((r) => ({ ...r, coverage: undefined })), null).map((r) => r.title)).toEqual(["GAP de A"]);
  });

  it("ativos = UNIÃO do julgamento mais recente de cada arquivo (não os da última run)", () => {
    const gA2 = F({ file: "a.md", title: "GAP novo de A", anchor: "a2" });
    const runs = [
      { id: "r2", created_at: "2", findings: [gB], coverage: cov("b.md") },     // só b.md
      { id: "r1", created_at: "1", findings: [gA, gA2], coverage: cov("a.md") }, // só a.md
    ];
    const s = surveyFindings(runs, null);
    expect(s.active.map((f) => f.title).sort()).toEqual(["GAP de A", "GAP de B", "GAP novo de A"]);
  });

  it("quem JULGOU e não viu resolve normalmente (a correção não cega o resolvedor)", () => {
    const runs = [
      { id: "r3", created_at: "3", findings: [], coverage: cov("a.md") },
      { id: "r2", created_at: "2", findings: [], coverage: cov("a.md") },
      { id: "r1", created_at: "1", findings: [gA], coverage: cov("a.md") },
    ];
    const s = surveyFindings(runs, new Set(["a.md"]));
    expect(s.active).toEqual([]);
    expect(s.resolved.map((r) => ({ t: r.title, n: r.absentRuns }))).toEqual([{ t: "GAP de A", n: 2 }]);
  });

  it("uma só rodada julgando de novo = limbo anti-flapping (nem ativo, nem resolvido)", () => {
    const runs = [
      { id: "r2", created_at: "2", findings: [], coverage: cov("a.md") },
      { id: "r1", created_at: "1", findings: [gA], coverage: cov("a.md") },
    ];
    const s = surveyFindings(runs, null);
    expect(s.active).toEqual([]);
    expect(s.resolved).toEqual([]);
  });

  it("stage_a é determinístico e lê a spec inteira → ausência conta mesmo sem cobertura", () => {
    const sa = F({ file: "a.md", source: "stage_a", severity: "blocker", title: "Spec sem manifesto", anchor: null });
    const runs = [
      { id: "r2", created_at: "2", findings: [], coverage: cov("b.md") },
      { id: "r1", created_at: "1", findings: [sa], coverage: cov("a.md", "b.md") },
    ];
    expect(surveyFindings(runs, null).resolved.map((r) => r.title)).toEqual(["Spec sem manifesto"]);
  });

  it("run SEM cobertura num projeto que já rastreia não prova ausência (juiz lia 2 de 12)", () => {
    const runs = [
      { id: "r3", created_at: "3", findings: [] },                              // cobertura desconhecida
      { id: "r2", created_at: "2", findings: [] },                              // cobertura desconhecida
      { id: "r1", created_at: "1", findings: [gA], coverage: cov("a.md") },
    ];
    expect(surveyFindings(runs, null).resolved).toEqual([]);
    expect(surveyFindings(runs, null).active.map((f) => f.title)).toEqual(["GAP de A"]);
  });

  it("projeto sem NENHUMA cobertura (legado, pré-migração 101) mantém o comportamento antigo", () => {
    const runs = [
      { id: "r3", created_at: "3", findings: [] },
      { id: "r2", created_at: "2", findings: [] },
      { id: "r1", created_at: "1", findings: [gA] },
    ];
    expect(surveyFindings(runs, null).resolved.map((r) => r.title)).toEqual(["GAP de A"]);
  });

  it("🔴 arquivo apagado da spec: resolve na hora — senão o GAP trava a promoção para sempre", () => {
    const runs = [
      { id: "r2", created_at: "2", findings: [], coverage: cov("b.md") },
      { id: "r1", created_at: "1", findings: [gA], coverage: cov("a.md") },
    ];
    const s = surveyFindings(runs, new Set(["b.md"]));
    expect(s.active).toEqual([]);
    expect(s.resolved[0]).toMatchObject({ title: "GAP de A", fileRemoved: true });
  });

  it("`file` sem diretório casa com o path canônico (o validador devolve os dois formatos)", () => {
    const g = F({ file: "01-api.md", title: "GAP", anchor: "x" });
    const runs = [
      { id: "r2", created_at: "2", findings: [], coverage: cov("backend/01-api.md") },
      { id: "r1", created_at: "1", findings: [g], coverage: cov("backend/01-api.md") },
    ];
    // quem julgou `backend/01-api.md` é evidência sobre um finding cujo `file` veio só como basename
    expect(surveyFindings(runs, new Set(["backend/01-api.md"])).resolved.length).toBe(0); // 1 ausência < 2
    const s = surveyFindings([{ id: "r3", created_at: "3", findings: [], coverage: cov("backend/01-api.md") }, ...runs], new Set(["backend/01-api.md"]));
    expect(s.resolved.map((r) => r.title)).toEqual(["GAP"]);
    // …e não é declarado "arquivo removido" só porque o path veio sem o diretório
    expect(s.resolved[0].fileRemoved).toBe(false);
  });

  it("🔴 basename AMBÍGUO não fala pelo outro arquivo (`backend/README.md` ≠ `web/README.md`)", () => {
    const g = F({ file: "README.md", title: "GAP do README", anchor: "x" });
    const dois = cov("backend/README.md", "web/README.md");
    const runs = [
      { id: "r3", created_at: "3", findings: [], coverage: dois },
      { id: "r2", created_at: "2", findings: [], coverage: dois },
      { id: "r1", created_at: "1", findings: [g], coverage: dois },
    ];
    // dois candidatos com o mesmo nome → nenhum é evidência sobre um `file` sem diretório
    expect(surveyFindings(runs, new Set(["backend/README.md", "web/README.md"])).resolved).toEqual([]);
  });

  it("projectFindingsState lê `stage_b_coverage` e conta a união (ativos ≠ findings da última run)", async () => {
    const rows = [
      { id: "r2", created_at: "2", findings: [gB], stage_b_coverage: cov("b.md") },
      { id: "r1", created_at: "1", findings: [gA], stage_b_coverage: cov("a.md") },
    ];
    const db = { query: vi.fn(async (q: string) => {
      if (q.includes("FROM spec_validation_runs")) {
        expect(q).toContain("stage_b_coverage");
        return { rows };
      }
      return { rows: [] };
    }) };
    const st = await projectFindingsState(db as never, "p1", { currentFiles: ["a.md", "b.md"] });
    expect(st.latestRunId).toBe("r2");
    expect(st.findings.map((f) => f.title).sort()).toEqual(["GAP de A", "GAP de B"]);
    expect(st.counts.active).toBe(2);
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
    // expiresAt inválido / no passado → 400
    const r5 = await applyTriage(db as never, { projectId: "p", finding: F({ anchor: "q" }), actor: user, state: "ignored", reasonCode: "accepted_risk", reason: "", expiresAt: "amanhã" });
    expect(!r5.ok && r5.code).toBe("BAD_EXPIRES_AT");
    const r6 = await applyTriage(db as never, { projectId: "p", finding: F({ anchor: "q" }), actor: user, state: "ignored", reasonCode: "accepted_risk", reason: "", expiresAt: "2020-01-01T00:00:00Z" });
    expect(!r6.ok && r6.code).toBe("BAD_EXPIRES_AT");
  });

  it("revokeTriage: blocker só por tenant_admin; sem triagem viva → 404; gestão/runner → 403", async () => {
    const { revokeTriage } = await import("./findingTriage.js");
    const mk = (sev: string | null) => ({ query: vi.fn(async (sql: string) => {
      if (/SELECT severity_at/.test(sql)) return { rows: sev ? [{ severity_at: sev }] : [] };
      if (/UPDATE spec_finding_triage SET revoked_at/.test(sql)) return { rows: [{ id: "t1", severity_at: sev, state: "ignored" }] };
      return { rows: [] };
    }) });
    expect((await revokeTriage(mk("blocker") as never, { projectId: "p", fingerprint: "x", actor: user })).ok).toBe(false);
    const r = await revokeTriage(mk("blocker") as never, { projectId: "p", fingerprint: "x", actor: user });
    expect(!r.ok && r.code).toBe("BLOCKER_REQUIRES_TENANT_ADMIN");
    expect((await revokeTriage(mk("blocker") as never, { projectId: "p", fingerprint: "x", actor: admin })).ok).toBe(true);
    expect((await revokeTriage(mk("warning") as never, { projectId: "p", fingerprint: "x", actor: user })).ok).toBe(true);
    const nf = await revokeTriage(mk(null) as never, { projectId: "p", fingerprint: "x", actor: user });
    expect(!nf.ok && nf.status).toBe(404);
    const adm = await revokeTriage(mk("warning") as never, { projectId: "p", fingerprint: "x", actor: { id: "z", role: "zentriz_admin" } });
    expect(!adm.ok && adm.status).toBe(403);
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

/**
 * 🔴 GAP-21 — o GATE de promoção contava blockers de UMA run só.
 *
 * Mesma raiz do GAP-20, outra vítima: `assessSpecValidation` lia a run mais recente do hash atual e
 * contava os blockers DELA. Com a rotação de cobertura, essa run pode ter julgado 2 dos 12 arquivos —
 * então uma spec com blockers nos outros 10 passava no gate e saía com Certificado Factory verde.
 */
describe("findingTriage — GAP-21: união por cobertura para o gate", () => {
  const cov = (...full: string[]) => ({ full, outlineOnly: [], oversized: [], cap: 400000, totalChars: 1 });
  const gA = F({ file: "a.md", title: "GAP de A", anchor: "a1" });
  const gB = F({ file: "b.md", title: "GAP de B", anchor: "b1" });

  it("une as rodadas do mesmo conteúdo: cada arquivo entra pelo julgamento que o leu", () => {
    const out = unionFindingsByCoverage([
      { id: "r2", created_at: "2", findings: [gB], coverage: cov("b.md") },
      { id: "r1", created_at: "1", findings: [gA], coverage: cov("a.md") },
    ]);
    expect(out.map((f) => f.title).sort()).toEqual(["GAP de A", "GAP de B"]);
  });

  it("o julgamento INTEGRAL mais recente vence: rejulgou o arquivo e não achou → o GAP sai da conta", () => {
    const out = unionFindingsByCoverage([
      { id: "r2", created_at: "2", findings: [], coverage: cov("a.md") },
      { id: "r1", created_at: "1", findings: [gA], coverage: cov("a.md") },
    ]);
    expect(out).toEqual([]);
  });

  it("leitura PARCIAL não fala por quem leu tudo: finding de outra run sobre arquivo já rejulgado cai fora", () => {
    // r2 leu `a.md` por inteiro (nada achou); r1 leu `b.md` por inteiro e opinou sobre `a.md` pelo outline.
    const out = unionFindingsByCoverage([
      { id: "r2", created_at: "2", findings: [], coverage: cov("a.md") },
      { id: "r1", created_at: "1", findings: [gA, gB], coverage: cov("b.md") },
    ]);
    expect(out.map((f) => f.title)).toEqual(["GAP de B"]);
  });

  it("arquivo que NENHUM juiz leu por inteiro: o que existe vale (é o único sinal que temos)", () => {
    const out = unionFindingsByCoverage([
      { id: "r2", created_at: "2", findings: [], coverage: cov("b.md") },
      { id: "r1", created_at: "1", findings: [gA], coverage: cov("b.md") },
    ]);
    expect(out.map((f) => f.title)).toEqual(["GAP de A"]);
  });

  it("`stage_a` é determinístico sobre a spec inteira → só a run mais recente conta (sem duplicar)", () => {
    const fa = F({ file: "", title: "Spec sem manifesto", anchor: "no_readme", source: "stage_a" });
    const out = unionFindingsByCoverage([
      { id: "r2", created_at: "2", findings: [fa], coverage: cov("a.md") },
      { id: "r1", created_at: "1", findings: [fa], coverage: cov("b.md") },
    ]);
    expect(out).toHaveLength(1);
    // A run mais nova não repetiu o finding do Stage A → ele não sobrevive pela run velha.
    expect(unionFindingsByCoverage([
      { id: "r2", created_at: "2", findings: [], coverage: cov("a.md") },
      { id: "r1", created_at: "1", findings: [fa], coverage: cov("b.md") },
    ])).toEqual([]);
  });

  it("basename ambíguo não fala pelo irmão (mesma regra do GAP-20)", () => {
    const g = F({ file: "README.md", title: "sem critérios", anchor: "r1" });
    const out = unionFindingsByCoverage([
      { id: "r2", created_at: "2", findings: [], coverage: cov("backend/README.md", "web/README.md") },
      { id: "r1", created_at: "1", findings: [g], coverage: cov("backend/README.md") },
    ]);
    // `README.md` casa com DOIS paths julgados → não sei de qual é; o finding permanece.
    expect(out.map((f) => f.title)).toEqual(["sem critérios"]);
  });

  it("sem cobertura em nenhuma run: união vira a lista crua, deduplicada por fingerprint", () => {
    const out = unionFindingsByCoverage([
      { id: "r2", created_at: "2", findings: [gA] },
      { id: "r1", created_at: "1", findings: [gA, gB] },
    ]);
    expect(out.map((f) => f.title).sort()).toEqual(["GAP de A", "GAP de B"]);
  });
});

/**
 * 🔴 GAP-41 — o laço só sabia comparar o AGREGADO ("26 → 36 GAPs").
 *
 * Medido em prod (NVX LastMile, 14 runs, 4 janelas de 10): 11–17 GAPs saem e 11–25 entram por passe,
 * com `openedOnNewSurface = 0` em TODAS as janelas — a rotação de cobertura explicava zero. Sem o diff
 * finding-a-finding, um total parado é indistinguível de "nada aconteceu".
 */
describe("findingTriage — GAP-41: diff finding-a-finding entre validações", () => {
  const cov = (...full: string[]) => ({ full, outlineOnly: [], oversized: [], cap: 400000, totalChars: 1 });
  const R = (id: string, findings: ValidationFinding[], ...full: string[]) => ({ id, created_at: id, findings, coverage: cov(...full) });

  it("GAP corrigido de verdade: sai da conta como FECHADO e nada entra", () => {
    const gA = F({ file: "a.md", title: "GAP de A", anchor: "a1" });
    // r3 rejulgou `a.md` por inteiro e não achou nada → o finding saiu do conjunto ativo.
    const d = gapDelta([R("r3", [], "a.md"), R("r2", [gA], "a.md"), R("r1", [gA], "a.md")], null, 2);
    expect(d.closed.map((f) => f.title)).toEqual(["GAP de A"]);
    expect(d.opened).toEqual([]);
    expect(d.openedOnNewSurface).toBe(0);
  });

  it("🔴 o defeito que o GAP-39 ataca: MESMO problema com anchor reescrito = 1 fechado + 1 novo (par real de prod)", () => {
    // Par literal da run 3cfd4cc0 do NVX: o juiz reencontrou o mesmo bloco de merge no DDL e anexou o
    // raciocínio ao anchor. O total não se move; o diff mostra que o laço apenas trocou seis por meia dúzia.
    const antes = F({ file: "modelo-dados.md", title: "Blocos de merge não resolvidos no DDL", anchor: "Convenções gerais", category: "missing_data_model" });
    const depois = F({ file: "modelo-dados.md", title: "Blocos de merge não resolvidos no DDL", anchor: "Convenções gerais (bloco com marcadores =======)", category: "stack_inconsistent" });
    const d = gapDelta([R("r3", [depois], "modelo-dados.md"), R("r2", [antes], "modelo-dados.md"), R("r1", [antes], "modelo-dados.md")], null, 2);
    expect(d.closed.map((f) => f.anchor)).toEqual(["Convenções gerais"]);
    expect(d.opened.map((f) => f.anchor)).toEqual(["Convenções gerais (bloco com marcadores =======)"]);
    expect(d.openedOnNewSurface).toBe(0); // mesmo arquivo, já julgado antes → não é descoberta
  });

  it("separa DESCOBERTA de REGRESSÃO: só arquivo inédito na janela anterior conta como superfície nova", () => {
    const novoEmA = F({ file: "a.md", title: "regressão em A", anchor: "a9" });
    const novoEmC = F({ file: "c.md", title: "achado em C", anchor: "c1" });
    const d = gapDelta([R("r3", [novoEmA, novoEmC], "a.md", "c.md"), R("r2", [], "a.md"), R("r1", [], "a.md")], null, 2);
    expect(d.opened.map((f) => f.title).sort()).toEqual(["achado em C", "regressão em A"]);
    expect(d.openedOnNewSurface).toBe(1); // `c.md` nunca foi julgado por inteiro antes; `a.md` já era
  });

  it("🔴 revisão adversarial da própria correção: sair da janela por IDADE não é fechar", () => {
    // `gA` só apareceu na run mais antiga e NENHUMA run posterior julgou `a.md` — logo ninguém disse que
    // ele sumiu. Deslocar a janela o expulsa; contar isso como "fechado" seria a mesma mentira do GAP-18.
    const gA = F({ file: "a.md", title: "GAP de A", anchor: "a1" });
    const d = gapDelta([R("r3", [], "b.md"), R("r2", [], "b.md"), R("r1", [gA], "a.md")], null, 2);
    expect(d.closed).toEqual([]);
    expect(d.opened).toEqual([]);
  });

  it("menos de duas validações: não há o que comparar (zeros, nunca um palpite)", () => {
    expect(gapDelta([], null)).toEqual({ closed: [], opened: [], openedOnNewSurface: 0 });
    expect(gapDelta([{ id: "r1", created_at: "1", findings: [F({ anchor: "x" })] }], null))
      .toEqual({ closed: [], opened: [], openedOnNewSurface: 0 });
  });

  it("gapDeltaSinceLastRun: uma query, janela W+1, só runs terminais", async () => {
    const gA = F({ file: "a.md", title: "GAP de A", anchor: "a1" });
    const db = { query: vi.fn(async (q: string, p: unknown[]) => {
      expect(q).toContain("FROM spec_validation_runs");
      expect(q).toContain("status IN ('passed','failed')"); // run em voo não é evidência
      expect(p[1]).toBe(11);                                // RESOLVED_WINDOW_RUNS + 1
      return { rows: [
        { id: "r2", created_at: "2", findings: [], stage_b_coverage: cov("a.md") },
        { id: "r1", created_at: "1", findings: [gA], stage_b_coverage: cov("a.md") },
      ] };
    }) };
    const d = await gapDeltaSinceLastRun(db as never, "p1", ["a.md"]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(d.closed.map((f) => f.title)).toEqual(["GAP de A"]);
  });
});
