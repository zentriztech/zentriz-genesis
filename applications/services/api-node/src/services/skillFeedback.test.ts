/**
 * skillFeedback.test.ts — plano v2 tarefas 1.1/1.2, ADR-025.
 * Convergência da fórmula nos dois sentidos, idempotência, QA nunca transita estado,
 * use_count só após oráculo, hit_count idempotente, shadow sem efeito, simulação antes/depois.
 */
import { describe, it, expect } from "vitest";
import {
  nextQualityScore, legacyNextQualityScore, getSkillFeedbackMode, applySkillSignal, applyOutcome,
  feedbackKey, TRUSTED_THRESHOLD, DEPRECATED_THRESHOLD, defaultSignalWeight,
} from "./skillFeedback.js";
import { MemoryFeedbackStore, simulateLegacy, simulateNew } from "./skillFeedbackMemory.js";
import { SCENARIOS } from "./skillFeedbackScenarios.js";

const P = "11111111-1111-4111-8111-111111111111";

function iterate(f: (q: number, w: number) => number, q0: number, w: number, n: number): number[] {
  const out: number[] = [];
  let q = q0;
  for (let i = 0; i < n; i++) { q = f(q, w); out.push(q); }
  return out;
}

describe("flag SKILL_FEEDBACK", () => {
  it("padrão off; valores inválidos caem em off", () => {
    expect(getSkillFeedbackMode({} as NodeJS.ProcessEnv)).toBe("off");
    expect(getSkillFeedbackMode({ SKILL_FEEDBACK: "" } as NodeJS.ProcessEnv)).toBe("off");
    expect(getSkillFeedbackMode({ SKILL_FEEDBACK: "yes" } as NodeJS.ProcessEnv)).toBe("off");
    expect(getSkillFeedbackMode({ SKILL_FEEDBACK: " SHADOW " } as NodeJS.ProcessEnv)).toBe("shadow");
    expect(getSkillFeedbackMode({ SKILL_FEEDBACK: "on" } as NodeJS.ProcessEnv)).toBe("on");
  });
});

describe("fórmula do quality_score — convergência", () => {
  it("BUG legado provado: ponto fixo 0,5+0,05·w — trusted (>=0,7) e deprecated (<0,3) inalcançáveis", () => {
    const up = iterate(legacyNextQualityScore, 0.5, 0.5, 2000).at(-1)!;
    const down = iterate(legacyNextQualityScore, 0.5, -0.5, 2000).at(-1)!;
    expect(up).toBeLessThan(0.53);   // ~0,525
    expect(down).toBeGreaterThan(0.47); // ~0,475
    expect(Math.max(...iterate(legacyNextQualityScore, 0.5, 0.5, 2000))).toBeLessThan(TRUSTED_THRESHOLD);
    expect(Math.min(...iterate(legacyNextQualityScore, 1, -0.5, 2000))).toBeGreaterThan(DEPRECATED_THRESHOLD);
  });

  it("corrigida, sentido positivo: w=+0,5 converge a 1 e cruza 0,7 (de 0,5 em 10 passos)", () => {
    const seq = iterate(nextQualityScore, 0.5, 0.5, 400);
    expect(seq.at(-1)).toBeGreaterThanOrEqual(0.99);
    const n = seq.findIndex((q) => q >= TRUSTED_THRESHOLD) + 1;
    expect(n).toBe(10);
  });

  it("corrigida, sentido negativo: w=-0,5 converge a 0 e cruza <0,3 (de 1,0 em 24 passos; de 0,5 em 10)", () => {
    const seq = iterate(nextQualityScore, 1, -0.5, 400);
    expect(seq.at(-1)).toBeLessThanOrEqual(0.01);
    expect(seq.findIndex((q) => q < DEPRECATED_THRESHOLD) + 1).toBe(24);
    expect(iterate(nextQualityScore, 0.5, -0.5, 50).findIndex((q) => q < DEPRECATED_THRESHOLD) + 1).toBe(10);
  });

  it("mantém a faixa [0,1] para qualquer q e w (inclusive pesos fora de faixa)", () => {
    for (const q of [0, 0.001, 0.5, 0.999, 1]) {
      for (const w of [-5, -1, -0.5, 0, 0.3, 0.5, 1, 5]) {
        const r = nextQualityScore(q, w);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
    }
  });

  it("é média móvel: no regime, sinais ±0,5 com taxa de acerto p dão score ~p (estimador da taxa)", () => {
    for (const p of [0.2, 0.5, 0.8]) {
      let q = 0.5;
      const pattern = Array.from({ length: 100 }, (_, i) => (i < p * 100 ? 0.5 : -0.5));
      // intercala para evitar viés de ordem
      const shuffled = pattern.map((_, i) => pattern[(i * 37) % 100]);
      const tail: number[] = [];
      for (let r = 0; r < 6; r++) shuffled.forEach((w, i) => { q = nextQualityScore(q, w); if (r >= 3) tail.push(q); void i; });
      const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
      expect(Math.abs(mean - p)).toBeLessThan(0.08);
    }
  });

  it("pesos legados preservados", () => {
    expect(defaultSignalWeight("qa_pass")).toBe(0.5);
    expect(defaultSignalWeight("qa_fail")).toBe(-0.5);
    expect(defaultSignalWeight("cyborg_reject")).toBe(-0.3);
    expect(defaultSignalWeight("oracle_pass")).toBe(0.5);
  });
});

describe("idempotência (projeto+task+skill+sinal)", () => {
  it("a repetição do mesmo sinal não conta duas vezes; sinal diferente conta", async () => {
    const st = new MemoryFeedbackStore();
    const s = st.addSkill("sk1");
    const a = await applySkillSignal(st, "on", { projectId: P, taskRef: "T1", skillId: "sk1", signal: "oracle_pass" });
    const q1 = s.quality_score;
    const b = await applySkillSignal(st, "on", { projectId: P, taskRef: "T1", skillId: "sk1", signal: "oracle_pass" });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(s.quality_score).toBe(q1);
    expect(s.use_count).toBe(1);
    expect(st.feedback).toHaveLength(1);
    const c = await applySkillSignal(st, "on", { projectId: P, taskRef: "T1", skillId: "sk1", signal: "qa_fail" });
    expect(c.duplicate).toBe(false);
    expect(st.feedback).toHaveLength(2);
  });

  it("a mesma task em projetos diferentes não colide (task_id repete entre projetos)", async () => {
    const st = new MemoryFeedbackStore();
    st.addSkill("sk1");
    await applySkillSignal(st, "on", { projectId: P, taskRef: "TSK-001", skillId: "sk1", signal: "oracle_pass" });
    const r = await applySkillSignal(st, "on", { projectId: "22222222-2222-4222-8222-222222222222", taskRef: "TSK-001", skillId: "sk1", signal: "oracle_pass" });
    expect(r.duplicate).toBe(false);
    expect(feedbackKey(P, "T", "s", "x")).toBe(`${P}|T|s|x`);
  });

  it("skill inexistente não quebra", async () => {
    const st = new MemoryFeedbackStore();
    const r = await applySkillSignal(st, "on", { projectId: P, taskRef: "T1", skillId: "nope", signal: "oracle_pass" });
    expect(r.missing).toBe(true);
  });
});

describe("QA (LLM) é sinal fraco: nunca transita estado nem conta uso (ADR-025)", () => {
  it("100 qa_pass não promovem shadow e não incrementam use_count", async () => {
    const st = new MemoryFeedbackStore();
    const s = st.addSkill("sk1", { quality_score: 0.5 });
    for (let i = 0; i < 100; i++) await applySkillSignal(st, "on", { projectId: P, taskRef: `T${i}`, skillId: "sk1", signal: "qa_pass" });
    expect(s.quality_score).toBeGreaterThan(0.9); // score informativo sobe
    expect(s.status).toBe("shadow");
    expect(s.use_count).toBe(0);
  });

  it("100 qa_fail/cyborg_reject/bug_recurrence não deprecam trusted", async () => {
    const st = new MemoryFeedbackStore();
    const s = st.addSkill("sk1", { status: "trusted" });
    for (let i = 0; i < 100; i++) {
      for (const sig of ["qa_fail", "cyborg_reject", "bug_recurrence"]) {
        await applySkillSignal(st, "on", { projectId: P, taskRef: `T${i}`, skillId: "sk1", signal: sig });
      }
    }
    expect(s.quality_score).toBeLessThan(DEPRECATED_THRESHOLD);
    expect(s.status).toBe("trusted");
  });
});

describe("oráculo forte transita estado", () => {
  it("shadow->trusted exige >=5 sinais fortes E score>=0,7 (aqui o score é o gargalo: 10 acertos a partir do prior 0,5)", async () => {
    const st = new MemoryFeedbackStore();
    const s = st.addSkill("sk1");
    for (let i = 0; i < 9; i++) await applySkillSignal(st, "on", { projectId: P, taskRef: `T${i}`, skillId: "sk1", signal: i % 2 ? "oracle_pass" : "human_approve" });
    expect(s.status).toBe("shadow"); // 5+ evidências, mas score 0,685 < 0,7
    const r = await applySkillSignal(st, "on", { projectId: P, taskRef: "T9", skillId: "sk1", signal: "oracle_pass" });
    expect(r.transition).toBe("trusted");
    expect(s.status).toBe("trusted");
    expect(s.use_count).toBe(10);
  });

  it("trusted->deprecated por oracle_fail/human_reject, nunca para hard_rule", async () => {
    const st = new MemoryFeedbackStore();
    const s = st.addSkill("sk1", { status: "trusted" });
    const h = st.addSkill("hr", { status: "trusted", hard_rule: true });
    for (let i = 0; i < 30; i++) {
      await applySkillSignal(st, "on", { projectId: P, taskRef: `T${i}`, skillId: "sk1", signal: i % 2 ? "oracle_fail" : "human_reject" });
      await applySkillSignal(st, "on", { projectId: P, taskRef: `T${i}`, skillId: "hr", signal: "oracle_fail" });
    }
    expect(s.status).toBe("deprecated");
    expect(h.status).toBe("trusted");
  });

  it("deprecar não fica refém do use_count (que só conta acertos)", async () => {
    const st = new MemoryFeedbackStore();
    const s = st.addSkill("sk1", { status: "trusted" });
    for (let i = 0; i < 12; i++) await applySkillSignal(st, "on", { projectId: P, taskRef: `T${i}`, skillId: "sk1", signal: "oracle_fail" });
    expect(s.use_count).toBe(0);
    expect(s.status).toBe("deprecated");
  });
});

describe("shadow: registra e loga, não altera nada", () => {
  it("não muda score, status nem use_count; grava chave com prefixo shadow; loga", async () => {
    const st = new MemoryFeedbackStore();
    const s = st.addSkill("sk1", { quality_score: 0.8 });
    const logs: string[] = [];
    for (let i = 0; i < 8; i++) await applySkillSignal(st, "shadow", { projectId: P, taskRef: `T${i}`, skillId: "sk1", signal: "oracle_pass" }, (m) => logs.push(m));
    expect(s).toMatchObject({ quality_score: 0.8, status: "shadow", use_count: 0 });
    expect(st.feedback.every((f) => f.key.startsWith("shadow|"))).toBe(true);
    expect(logs.some((m) => m.includes("transition=trusted"))).toBe(true); // diria que promoveria
    expect(logs.every((m) => m.includes("nada aplicado"))).toBe(true);
    // evidência shadow não conta para o modo on
    const on = await st.countStrong("sk1", false);
    expect(on).toEqual({ positive: 0, negative: 0 });
  });

  it("migrar shadow->on não herda as chaves shadow (o sinal ainda conta em on)", async () => {
    const st = new MemoryFeedbackStore();
    const s = st.addSkill("sk1");
    await applySkillSignal(st, "shadow", { projectId: P, taskRef: "T1", skillId: "sk1", signal: "oracle_pass" });
    const r = await applySkillSignal(st, "on", { projectId: P, taskRef: "T1", skillId: "sk1", signal: "oracle_pass" });
    expect(r.duplicate).toBe(false);
    expect(s.use_count).toBe(1);
  });
});

describe("fan-out de desfecho + hit_count de lições (1.2)", () => {
  function seed() {
    const st = new MemoryFeedbackStore();
    st.addSkill("sk1"); st.addSkill("sk2");
    // rework: 2 bundles da mesma task com as mesmas skills
    st.bundles.push({ projectId: P, taskId: "T1", skillIds: ["sk1", "sk2"] });
    st.bundles.push({ projectId: P, taskId: "T1", skillIds: ["sk1"] });
    st.injections.push({ projectId: P, taskId: "T1", slug: "les-a" }, { projectId: P, taskId: "T2", slug: "les-a" }, { projectId: P, taskId: "T2", slug: "les-b" });
    return st;
  }

  it("oráculo positivo: skills deduplicadas por task e hit_count +1 por lição", async () => {
    const st = seed();
    const r = await applyOutcome(st, "on", { projectId: P, taskId: null, signal: "oracle_pass" });
    expect(r.skills).toHaveLength(2);
    expect(st.skills.get("sk1")!.use_count).toBe(1); // 2 bundles, 1 contagem
    expect(st.lessons.get("les-a")!.hit_count).toBe(1); // 2 tasks, 1 contagem por projeto
    expect(st.lessons.get("les-b")!.hit_count).toBe(1);
  });

  it("retry (mesmo desfecho de novo) não conta duas vezes", async () => {
    const st = seed();
    await applyOutcome(st, "on", { projectId: P, taskId: null, signal: "human_approve" });
    const again = await applyOutcome(st, "on", { projectId: P, taskId: null, signal: "human_approve" });
    expect(again.skills.every((s) => s.duplicate)).toBe(true);
    expect(again.lessons.every((l) => l.duplicate)).toBe(true);
    expect(st.lessons.get("les-a")!.hit_count).toBe(1);
    expect(st.skills.get("sk1")!.use_count).toBe(1);
  });

  it("sinal fraco ou negativo não incrementa hit_count", async () => {
    const st = seed();
    for (const signal of ["qa_pass", "qa_fail", "oracle_fail", "human_reject", "cyborg_reject"]) {
      await applyOutcome(st, "on", { projectId: P, taskId: null, signal });
    }
    expect(st.lessons.size).toBe(0);
  });

  it("recuperação sem desfecho não conta (lição injetada de outro projeto não recebe hit)", async () => {
    const st = seed();
    await applyOutcome(st, "on", { projectId: "33333333-3333-4333-8333-333333333333", taskId: null, signal: "oracle_pass" });
    expect(st.lessons.size).toBe(0);
  });

  it("shadow não incrementa hit_count", async () => {
    const st = seed();
    const logs: string[] = [];
    await applyOutcome(st, "shadow", { projectId: P, taskId: null, signal: "oracle_pass" }, (m) => logs.push(m));
    expect(st.lessons.size).toBe(0);
    expect(logs.some((m) => m.includes("LessonHit/shadow"))).toBe(true);
  });
});

describe("recordProjectOutcome (gancho de aceite/rejeição)", () => {
  it("flag off: no-op, não toca o pool", async () => {
    const { recordProjectOutcome } = await import("./skillFeedback.js");
    const pool = { connect: async () => { throw new Error("não deveria conectar"); } };
    await expect(recordProjectOutcome(pool as never, P, "human_approve", {} as NodeJS.ProcessEnv)).resolves.toBeUndefined();
  });
  it("flag on: erro de banco é engolido (não crítico) e faz ROLLBACK", async () => {
    const { recordProjectOutcome } = await import("./skillFeedback.js");
    const seen: string[] = [];
    const client = {
      query: async (sql: string) => { seen.push(sql.trim().split(/\s+/)[0]); if (sql.includes("skill_bundle")) throw new Error("boom"); return { rows: [] }; },
      release: () => {},
    };
    await expect(recordProjectOutcome({ connect: async () => client } as never, P, "human_approve", { SKILL_FEEDBACK: "on" } as unknown as NodeJS.ProcessEnv)).resolves.toBeUndefined();
    expect(seen).toContain("ROLLBACK");
  });
});

describe("simulação offline: transições antes vs depois", () => {
  it("cada cenário termina onde o ADR-025 manda; o legado errava", async () => {
    const rows: string[] = [];
    for (const sc of SCENARIOS) {
      const neu = await simulateNew(sc.events, "on", sc.startQuality, sc.startStatus);
      rows.push(`${sc.name}: corrigido=${neu.at(-1)!.status}`);
      expect(neu.at(-1)!.status, sc.name).toBe(sc.expectNew);
    }
    expect(rows).toHaveLength(SCENARIOS.length);
  });

  it("legado: skill ruim só pelo QA (D) vira trusted e skill que falha (E) nunca é deprecada", () => {
    const d = SCENARIOS.find((s) => s.name.startsWith("D."))!;
    const e = SCENARIOS.find((s) => s.name.startsWith("E."))!;
    expect(simulateLegacy(d.events, 1).at(-1)!.status).toBe("trusted"); // BUG
    // legado em E: score nunca fica abaixo de ~0,475 -> sem deprecated
    let q = 1; for (const ev of e.events) q = legacyNextQualityScore(q, defaultSignalWeight(ev.signal));
    expect(q).toBeGreaterThan(DEPRECATED_THRESHOLD);
  });
});
