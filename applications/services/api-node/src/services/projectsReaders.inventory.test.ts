/**
 * Fase 2 / S-16 — GUARDA ESTÁTICA POR CONSULTA do inventário de leitores de `projects` (substitui a guarda por arquivo/janela de ±4 linhas).
 *
 * Para CADA literal de string/template do código de produto que contém `FROM projects` ou `JOIN projects`
 * (extração por tokenizador: `src/testing/sqlLiterals.ts`), a consulta INTEIRA tem de cair numa destas classes:
 *   1. OCULTA   — usa `notHiddenProjectSql`/`HIDDEN_FROM_PRODUCT_STATUSES` (ou `status <> 'card_draft'`);
 *   2. PERMISSÃO — filtra por lista de status positiva (`status IN ('a','b')` / `status = 'x'`) sem `card_draft`;
 *   3. SEM ESCOPO — não filtra por `product_id`/`tenant_id`/`created_by` (busca por id, por pai, por run…: o rascunho, sem versão e sem pai,
 *      só é alcançado por quem já tem o id);
 *   4. EXCEÇÃO POR CONSULTA — chave `arquivo:hash` (sha1 do texto da consulta, espaços colapsados; 8 hex) com justificativa.
 * Mudou uma letra da consulta ⇒ o hash muda ⇒ a exceção deixa de valer e a consulta é reavaliada. Exceção sem consulta correspondente
 * (órfã) também falha, para a lista não apodrecer. NÃO há exceção por arquivo inteiro.
 *
 * Também cobre `SELECT *`/`RETURNING *` sobre `tickets` nas rotas (S-05): coluna nova de card nunca vaza por spread.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { extractLiterals } from "../testing/sqlLiterals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f === "migrations" || f === "node_modules") continue; walk(p, out); }
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const hashOf = (t: string) => createHash("sha1").update(norm(t)).digest("hex").slice(0, 8);

const READS_PROJECTS = /\b(FROM|JOIN)\s+projects\b/i;
const HIDDEN = /notHiddenProjectSql|HIDDEN_FROM_PRODUCT_STATUSES|status\s*<>\s*'card_draft'/;
/** Filtro de escopo explícito OU WHERE montado dinamicamente (`${where…}`), que a regex não enxerga e por isso conta como escopado. */
const SCOPE = /\b(product_id|tenant_id|created_by)\s*(=|IS\s+NOT\s+DISTINCT|IN\b|<>|!=)|\$\{\s*where\w*\s*\}/i;
/** Apelidos com que a consulta referencia `projects` (`FROM projects p` ⇒ `p`; sem apelido ⇒ "" para `status` solto). */
function projectAliases(t: string): string[] {
  const out = new Set<string>();
  for (const m of t.matchAll(/\b(?:FROM|JOIN)\s+projects\b(?:\s+(?:AS\s+)?(?!(?:WHERE|LEFT|RIGHT|INNER|JOIN|ON|GROUP|ORDER|LIMIT|SET|USING|CROSS|FULL|UNION|FOR|HAVING)\b)([a-z_]\w*))?/gi)) out.add(m[1] ?? "");
  return [...out];
}
/** Lista de permissão sobre o STATUS DE PROJETO (não de outra tabela da mesma consulta): `<alias>.status IN ('a',…)` / `= 'x'` sem `card_draft`. */
const allowlist = (t: string) => projectAliases(t).some((a) => {
  const col = a ? `${a}\\.status` : `(?<![\\w.])status`;
  return new RegExp(`${col}\\s+IN\\s*\\(\\s*'`, "i").test(t) && !/card_draft/.test(t) && !new RegExp(`${col}\\s+NOT\\s+IN`, "i").test(t)
    || new RegExp(`${col}\\s*=\\s*'(?!card_draft)`, "i").test(t);
});

/** Consultas que listam por escopo (produto/tenant/autor) e NÃO ocultam o rascunho — cada uma com o motivo. Chave: `arquivo:hash`. */
const EXCEPTIONS: Record<string, string> = {
  "routes/dashboard.ts:4faf974a": "Lista de permissão por constante: p.status IN (STATUS_IN_FACTORY) exclui card_draft por construção (a regex só vê listas literais)",
  "routes/products.ts:654d5aef": "Subconsulta por id (título do projeto de origem da proposta); a lista é de product_proposals, não de projects",
  "routes/reports.ts:ba6e44e8": "WHERE montado dinamicamente: where[] começa SEMPRE com notHiddenProjectSql(\"p\"); coberto pelo teste de rota GET /api/reports/type-compliance",
  "services/specQuestions.ts:9f5c16b6": "WHERE dinâmico com lista de permissão fixa (p.status = 'needs_spec_input'): exclui card_draft por construção",
  "db/seed-example-projects.ts:8907b06d": "Script de seed: busca por título dentro do tenant, não é leitor de runtime",
  "db/seed-venuxx-v2.ts:b6b454fd": "Script de seed (limpeza do produto de exemplo); não roda no runtime",
  "db/seed-venuxx-v2.ts:dc6f2248": "Script de seed: busca por título exato no produto, não é leitor de runtime",
  "routes/dashboard.ts:fa66e620": "DEVE contar o rascunho: custo real do chat do rascunho entra na telemetria do tenant (S §3.3)",
  "routes/dashboard.ts:ceff89b7": "Diálogo/alertas por projeto do tenant: o rascunho não emite diálogo de fábrica (severidade/evento), e se emitir deve aparecer",
  "routes/deadpool.ts:e0ca905a": "Monitoramento do Deadpool por project_id: só projetos executáveis têm linha em project_deadpool_monitoring",
  "routes/deadpool.ts:229f5d54": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "routes/deadpool.ts:0caa06ec": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "routes/products.ts:355ad236": "Lista de permissão por constante (SPEC_DECOMPOSABLE_STATUSES = draft, spec_submitted, pending_conversion): exclui card_draft por construção",
  "routes/products.ts:43eb1506": "Posse do projeto por id + tenant (autorização), não lista",
  "routes/products.ts:ab5f2b33": "pipeline_runs em andamento: só projeto executável tem run (o rascunho nunca roda pipeline)",
  "routes/products.ts:68d61b97": "DELETE do produto: DEVE contar o rascunho (excluir o produto com rascunho vivo apagaria o card por cascata)",
  "routes/products.ts:4cb0cde2": "Relações entre projetos por par de ids (project_links); o rascunho não tem relações",
  "routes/projects.ts:d7ddf633": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "routes/projects.ts:03d61183": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "routes/tenants.ts:6cecc7d7": "Métrica administrativa projects_count do tenant (visão da plataforma); reavaliar se virar métrica de plano (S §3.3)",
  "routes/users.ts:2ca26a2b": "DEVE contar o rascunho: usuário que criou um rascunho não pode ser excluído sem destino (autoria)",
  "services/costReconcile.ts:dd6e0fcf": "DEVE contar o rascunho: reconciliação de custo do ledger por tenant inclui o chat do rascunho (S §3.3)",
  "services/cardDelivery.ts:f0e686f7": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/evolutionMerge.ts:f0a7a098": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/evolutionPromote.ts:f20bf521": "Lista de permissão por constante (EVOLUTION_PROMOTABLE_STATUSES): exclui card_draft por construção",
  "services/evolveClaim.ts:a6b7bb19": "findExisting (S-02): casa por extra.ticket_id / evolve_idempotency_key; o rascunho grava extra.card_ticket_id (não ticket_id nem a chave), então não é adotado — coberto por teste de regressão",
  "services/evolveClaim.ts:03d61183": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/githubPush.ts:62ec1471": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/githubPush.ts:3d05d46d": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/inbox.ts:c77d0cde": "DEVE contar o rascunho: só apaga produto solo vazio (NOT EXISTS projects); rascunho vivo impede a exclusão",
  "services/postMerge/handoffMonitoring.ts:bb050d6e": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/postMerge/realignWorkingTree.ts:b4c23b78": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/provision/cloudDeploy.ts:92be433c": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/provision/deployBackendCloud.ts:43d4221d": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/s3StaticDeploy.ts:43d4221d": "Busca por id de projeto já resolvido (join por project_id/id); não lista projetos do produto/tenant, então o rascunho só aparece para quem já tem o id",
  "services/tenantCostCap.ts:05e9a1a1": "DEVE contar o rascunho: custo do chat do rascunho entra no teto de gasto do tenant (S §3.3)",
  "services/tenantCostCap.ts:247252d5": "DEVE contar o rascunho: custo do chat do rascunho entra no teto de gasto do tenant (S §3.3)",
  "services/watchdog.ts:67181311": "DEVE contar o rascunho: gasto diário por tenant (alerta) inclui o chat do rascunho",
};

interface Found { file: string; line: number; text: string; key: string }
function readers(): Found[] {
  const out: Found[] = [];
  for (const f of walk(root)) {
    const rel = relative(root, f);
    for (const l of extractLiterals(readFileSync(f, "utf-8"))) {
      if (!READS_PROJECTS.test(l.text)) continue;
      out.push({ file: rel, line: l.line, text: norm(l.text), key: `${rel}:${hashOf(l.text)}` });
    }
  }
  return out;
}

describe("Fase 2 / S-16 — inventário por consulta de FROM/JOIN projects (card_draft)", () => {
  const all = readers();

  it("o extrator enxerga um número plausível de consultas (sanidade contra falso verde)", () => {
    expect(all.length).toBeGreaterThan(150);
    expect(all.some((q) => q.file === "routes/products.ts" && /WITH RECURSIVE topo/.test(q.text))).toBe(true); // a consulta da S-03
  });

  it("toda consulta que lista projetos por produto/tenant/autor oculta o card_draft, é lista de permissão ou tem exceção POR CONSULTA", () => {
    const offenders = all
      .filter((q) => !HIDDEN.test(q.text) && !allowlist(q.text) && SCOPE.test(q.text) && !EXCEPTIONS[q.key])
      .map((q) => `${q.file}:${q.line} [${q.key}] ${q.text.slice(0, 140)}`);
    expect(offenders).toEqual([]);
  });

  it("nenhuma exceção está órfã (a consulta mudou ou sumiu) nem é redundante (já oculta o rascunho)", () => {
    const byKey = new Map(all.map((q) => [q.key, q]));
    const orphans = Object.keys(EXCEPTIONS).filter((k) => !byKey.has(k));
    expect(orphans).toEqual([]);
    const redundant = Object.keys(EXCEPTIONS).filter((k) => { const q = byKey.get(k)!; return HIDDEN.test(q.text); });
    expect(redundant).toEqual([]);
    for (const [k, why] of Object.entries(EXCEPTIONS)) expect(why.length, k).toBeGreaterThan(20);
  });

  it("a consulta do detalhe do produto (S-03) e a do relatório de tipos (S-16) ocultam o rascunho em TODOS os níveis", () => {
    const topo = all.find((q) => q.file === "routes/products.ts" && /WITH RECURSIVE topo/.test(q.text))!;
    // nível 0, subconsulta de predecessores, nível N e WHERE final = 4 ocorrências
    expect((topo.text.match(/notHiddenProjectSql\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    const rep = all.find((q) => q.file === "routes/reports.ts" && /project_type_needs_manual_review/.test(q.text));
    expect(rep, "consulta do relatório não encontrada").toBeTruthy();
  });

  it("o antigo padrão por '<> archived' continua coberto: projeto + 'archived' sem ocultar o rascunho só passa com exceção por consulta", () => {
    const re = /status\s*(<>|!=)\s*'archived'|status\s+NOT\s+IN\s*\([^)]*'archived'[^)]*\)/i;
    const bad = all.filter((q) => re.test(q.text) && !HIDDEN.test(q.text) && SCOPE.test(q.text) && !allowlist(q.text) && !EXCEPTIONS[q.key]);
    expect(bad.map((q) => q.key)).toEqual([]);
  });
});

describe("Fase 2 / S-05 — SELECT * / RETURNING * sobre tickets nas rotas (coluna nova de card não vaza por spread)", () => {
  /** Rotas autorizadas a ler `tickets.*`: a API de cards devolve o card inteiro de propósito (só com a flag ligada). */
  const ALLOWED_STAR: Record<string, string> = {
    "routes/cards.ts": "API de cards: devolve o card (colunas de card) e só existe com CARDS_BANCADA ligada (404 com a flag off)",
  };
  it("nenhuma rota fora da API de cards usa SELECT * / RETURNING * sobre tickets", () => {
    const offenders: string[] = [];
    for (const f of walk(join(root, "routes"))) {
      const rel = relative(root, f);
      if (ALLOWED_STAR[rel]) continue;
      for (const l of extractLiterals(readFileSync(f, "utf-8"))) {
        const t = norm(l.text);
        if (/\b(FROM|UPDATE|INTO)\s+tickets\b/i.test(t) && /(\bSELECT\s+\*|\bRETURNING\s+\*|\bt\.\*)/i.test(t)) offenders.push(`${rel}:${l.line} ${t.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
