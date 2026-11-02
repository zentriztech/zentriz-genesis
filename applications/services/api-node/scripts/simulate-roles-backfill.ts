/**
 * Simulação do backfill de papéis (plano v2, 2A.3) — SEM banco, SEM credenciais.
 *
 * Lê um JSON de slots (campos: label, table "tenant"|"platform", priority, provider, model_id,
 * model_id_fallback, cyborg_model_id) e imprime, por slot, o mapeamento
 *   model_id → Orchestrator · model_id_fallback → Advisor · cyborg_model_id → Advisor (D3) · Staff NULL
 * mais os casos de borda do doc 05 §15.2 e o que a UI/validação diria de cada resultado.
 * Usa EXATAMENTE a função que a migration 139 espelha (`backfillRolesFromLegacy`).
 *
 * Uso: npx tsx scripts/simulate-roles-backfill.ts [slots.json]
 *      (padrão: scripts/fixtures/roles-backfill-slots.json)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { backfillRolesFromLegacy, validateRoleModels } from "../src/lib/llmRoleSlots.js";
import { modelPower, modelFamilyOf } from "../src/services/reviewerModel.js";

interface SlotIn {
  label: string; table: "tenant" | "platform"; priority: number; provider: string;
  model_id: string; model_id_fallback?: string | null; cyborg_model_id?: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? path.join(here, "fixtures/roles-backfill-slots.json");
const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { slots: SlotIn[] };

const CLASSE = ["desconhecida", "pequeno", "médio (sonnet-like)", "topo (opus-like)"] as const;
const cls = (id: string | null) => (id ? CLASSE[modelPower(id)] : "—");
const short = (id: string | null) => (id ? id.replace(/^(us|global)\.anthropic\./, "") : "NULL");

const resumo = { total: 0, comAdvisor: 0, advisorVazio: 0, mesmaClasse: 0, advisorMaisFraco: 0, viaCyborg: 0, avisos: 0, erros: 0 };
console.log(`# Simulação do backfill de papéis — ${path.basename(file)}\n`);
console.log("slot | tabela/prio | Orchestrator (classe) | Advisor (classe) | origem | Staff | alertas");
console.log("---- | ----------- | --------------------- | ---------------- | ------ | ----- | -------");

for (const s of data.slots) {
  const r = backfillRolesFromLegacy(
    { modelId: s.model_id, modelIdFallback: s.model_id_fallback, cyborgModelId: s.cyborg_model_id },
    { includeCyborg: s.table !== "platform" },
  );
  const alertas: string[] = [];
  resumo.total++;
  if (r.advisor) resumo.comAdvisor++; else resumo.advisorVazio++;
  if (r.origin === "cyborg") { resumo.viaCyborg++; alertas.push("Advisor via cyborg_model_id (D3, carimbado pela 030)"); }
  if (r.advisor) {
    const po = modelPower(r.orchestrator), pa = modelPower(r.advisor);
    if (po > 0 && pa > 0 && po === pa) { resumo.mesmaClasse++; alertas.push("Advisor da MESMA classe do Orchestrator: escalada não eleva capacidade (sinalizar na UI)"); }
    if (po > 0 && pa > 0 && pa < po) { resumo.advisorMaisFraco++; alertas.push("Advisor MAIS FRACO que o Orchestrator"); }
    if (po === 0 || pa === 0) alertas.push(`classe não reconhecida (${modelFamilyOf(r.orchestrator)}): papéis não validáveis só pelo nome`);
  } else {
    alertas.push(...r.notes.filter((n) => /sem escalada/.test(n)));
  }
  const v = validateRoleModels(s.provider, { orchestrator: r.orchestrator, advisor: r.advisor, staff: null });
  resumo.avisos += v.warnings.length; resumo.erros += v.errors.length;
  for (const e of v.errors) alertas.push(`INVÁLIDO se salvo pelo portal novo: ${e}`);
  console.log([
    s.label, `${s.table}/${s.priority}`, `${short(r.orchestrator)} (${cls(r.orchestrator)})`,
    r.advisor ? `${short(r.advisor)} (${cls(r.advisor)})` : "NULL = sem escalada",
    r.origin, "NULL (usa Orchestrator, D1)", alertas.length ? alertas.join(" ; ") : "—",
  ].join(" | "));
}

console.log("\n## Resumo");
console.log(JSON.stringify(resumo, null, 2));
console.log("\n## Leitura");
console.log("- Advisor NULL significa SEM escalada (D1b): rework Dev/QA e escalada do Cyborg repetem o modelo principal, como hoje com fallback nulo.");
console.log("- Mesma classe: no baseline de produção 2 de 3 fallbacks são da classe do principal. A migração mantém o valor (não corrige em silêncio) e a UI deve sinalizar.");
console.log("- O backfill não muda comportamento: as colunas antigas continuam autoritativas e LLM_ROLES_MODE=off ignora as novas.");
