/**
 * skillFeedbackMemory.ts — Store em memória + simulação offline do ciclo de feedback (plano 1.1, ADR-025).
 *
 * NÃO é usado em produção: serve aos testes e ao script `scripts/simulate-skill-feedback.ts`, que
 * mostram as transições de status resultantes de um histórico de sinais ANTES (regra legada) e
 * DEPOIS (regra corrigida). Critério de aceite do ADR-025 §5: exercitar a transição com histórico,
 * não só chamar o endpoint.
 */
import {
  applySkillSignal, legacyNextQualityScore, defaultSignalWeight, isStrongSignal, isStrongPositive,
  type FeedbackStore, type SkillRow, type BundleSkillRef, type SkillFeedbackMode,
} from "./skillFeedback.js";

export interface MemSkill extends SkillRow { use_count: number }

export class MemoryFeedbackStore implements FeedbackStore {
  skills = new Map<string, MemSkill>();
  feedback: { skillId: string; signal: string; key: string; weight: number }[] = [];
  bundles: { projectId: string; taskId: string | null; skillIds: string[] }[] = [];
  injections: { projectId: string; taskId: string; slug: string }[] = [];
  lessonHits = new Map<string, { slug: string; key: string }>();
  lessons = new Map<string, { hit_count: number }>();

  addSkill(id: string, init: Partial<MemSkill> = {}): MemSkill {
    const s: MemSkill = { id, quality_score: 1, status: "shadow", hard_rule: false, use_count: 0, ...init };
    this.skills.set(id, s);
    return s;
  }
  async lockSkill(id: string) { return this.skills.get(id) ?? null; }
  async insertFeedback(r: { skillId: string; signal: string; key: string; weight: number }) {
    if (this.feedback.some((f) => f.key === r.key)) return false;
    this.feedback.push({ skillId: r.skillId, signal: r.signal, key: r.key, weight: r.weight });
    return true;
  }
  async countStrong(skillId: string, shadow: boolean) {
    let positive = 0, negative = 0;
    for (const f of this.feedback) {
      if (f.skillId !== skillId || f.key.startsWith("shadow|") !== shadow) continue;
      if (isStrongPositive(f.signal)) positive++; else if (isStrongSignal(f.signal)) negative++;
    }
    return { positive, negative };
  }
  async updateSkill(id: string, quality: number, incUse: boolean) {
    const s = this.skills.get(id)!;
    s.quality_score = quality;
    if (incUse) s.use_count += 1;
  }
  async setStatus(id: string, status: "trusted" | "deprecated") { this.skills.get(id)!.status = status; }
  async listBundleSkills(projectId: string, taskId: string | null): Promise<BundleSkillRef[]> {
    const out: BundleSkillRef[] = [];
    for (const b of this.bundles) {
      if (b.projectId !== projectId || (taskId !== null && b.taskId !== taskId)) continue;
      for (const sid of b.skillIds) out.push({ skill_id: sid, task_ref: b.taskId ?? "~project", bundle_id: null });
    }
    return out;
  }
  async listInjectedLessons(projectId: string, taskId: string | null) {
    return this.injections.filter((i) => i.projectId === projectId && (taskId === null || i.taskId === taskId)).map((i) => i.slug);
  }
  async insertLessonHit(key: string, slug: string) {
    if (this.lessonHits.has(key)) return false;
    this.lessonHits.set(key, { slug, key });
    return true;
  }
  async incrementLessonHit(slug: string) {
    const l = this.lessons.get(slug) ?? { hit_count: 0 };
    l.hit_count += 1;
    this.lessons.set(slug, l);
  }
}

// ── Simulação offline ────────────────────────────────────────────────────────

export interface SimEvent {
  task: string;
  signal: string;
}
export interface SimStep { n: number; signal: string; quality: number; status: string; use_count: number }

/**
 * Regra LEGADA (código antes da 1.1): cada montagem de bundle conta use_count; QA_PASS é sinal que
 * promove; fórmula com ponto fixo 0,5+0,05·w; limiares sobre use_count.
 */
export function simulateLegacy(events: SimEvent[], startQuality = 1): SimStep[] {
  let q = startQuality, status = "shadow", use = 0;
  const steps: SimStep[] = [];
  events.forEach((e, i) => {
    use += 1; // legado: a montagem do prompt já contava uso
    q = legacyNextQualityScore(q, defaultSignalWeight(e.signal));
    if (status === "shadow" && q >= 0.7 && use >= 5) status = "trusted";
    else if (status === "trusted" && q < 0.3 && use >= 10) status = "deprecated";
    steps.push({ n: i + 1, signal: e.signal, quality: q, status, use_count: use });
  });
  return steps;
}

/** Regra CORRIGIDA: roda o motor real (applySkillSignal) sobre o store em memória. */
export async function simulateNew(
  events: SimEvent[], mode: Exclude<SkillFeedbackMode, "off"> = "on", startQuality = 1, startStatus = "shadow",
): Promise<SimStep[]> {
  const store = new MemoryFeedbackStore();
  const s = store.addSkill("sim-skill", { quality_score: startQuality, status: startStatus });
  const steps: SimStep[] = [];
  let i = 0;
  for (const e of events) {
    i += 1;
    await applySkillSignal(store, mode, { projectId: "sim-project", taskRef: e.task, skillId: "sim-skill", signal: e.signal });
    steps.push({ n: i, signal: e.signal, quality: s.quality_score, status: s.status, use_count: s.use_count });
  }
  return steps;
}
