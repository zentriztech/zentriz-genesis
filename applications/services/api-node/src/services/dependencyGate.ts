/**
 * dependencyGate.ts — gate de dependência + contrato para iniciar um projeto (RFC-0003, G3/C3).
 *
 * Extraído do POST /api/projects/:id/run (pipeline.ts) para virar a fonte ÚNICA da regra.
 * Motivo (G3/C3): a cascata de ondas dispara via `dispatchProjectRun`, que só checava
 * RUNNABLE_STATUSES + spec file — NÃO os predecessores nem o api_contract.md. Assim uma
 * onda-1+ podia começar antes do contrato do predecessor existir em disco. Centralizando
 * aqui, TANTO o /run interativo QUANTO a cascata/promoção passam pelo mesmo gate.
 *
 * Regra (I-4):
 *   (a) todo predecessor (project_triggers) deve estar completed OU accepted; e
 *   (b) predecessor accepted deve ter api_contract.md em disco (quando PROJECT_FILES_ROOT
 *       está definido) — exceto projetos DB-only (só migrations).
 */

/** Interface mínima de query — aceita tanto Pool quanto PoolClient. */
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface GateBlock {
  code: "DEPENDENCY_NOT_READY" | "CONTRACT_MISSING";
  message: string;
  blockers?: Array<{ id: string; title: string; status: string }>;
  missingContracts?: string[];
}

export type GateResult = { ok: true } | { ok: false; block: GateBlock };

export async function checkDependencyGate(q: Queryable, projectId: string): Promise<GateResult> {
  const triggersRes = await q.query(
    `SELECT pt.trigger_project_id, p.title, p.status, p.product_id
       FROM project_triggers pt
       JOIN projects p ON p.id = pt.trigger_project_id
      WHERE pt.project_id = $1`,
    [projectId],
  );

  // (a) predecessores não concluídos
  const blockers = triggersRes.rows.filter(
    (r) => !["completed", "accepted"].includes(r.status as string),
  ) as Array<{ trigger_project_id: string; title: string; status: string }>;
  if (blockers.length > 0) {
    const list = blockers.map((b) => `"${b.title}" (${b.status})`).join(", ");
    return {
      ok: false,
      block: {
        code: "DEPENDENCY_NOT_READY",
        message:
          `Aguardando conclusão dos projetos predecessores: ${list}. ` +
          `Eles precisam estar completed ou accepted antes de iniciar este projeto.`,
        blockers: blockers.map((b) => ({ id: b.trigger_project_id, title: b.title, status: b.status })),
      },
    };
  }

  // (b) predecessores accepted mas sem api_contract.md em disco
  const filesRoot = (process.env.PROJECT_FILES_ROOT ?? process.env.HOST_PROJECT_FILES_ROOT ?? "").trim();
  if (filesRoot && triggersRes.rows.length > 0) {
    const { existsSync, readdirSync } = await import("fs");
    const { join } = await import("path");

    const contractMissing: string[] = [];
    for (const pred of triggersRes.rows) {
      const predId = pred.trigger_project_id as string;
      const predTitle = pred.title as string;
      const predProductId = pred.product_id as string | null;

      const contractCandidates = [
        ...(predProductId ? [join(filesRoot, predProductId, predId, "project", "api_contract.md")] : []),
        ...(predProductId ? [join(filesRoot, predProductId, "contracts")] : []),
        join(filesRoot, predId, "project", "api_contract.md"),
      ];

      const hasContract = contractCandidates.some((p) => {
        if (p.endsWith("contracts")) {
          try {
            return readdirSync(p).some(
              (f: string) => f.includes(predId.slice(0, 8)) || f.includes("api_contract"),
            );
          } catch {
            return false;
          }
        }
        return existsSync(p);
      });

      // Projetos de banco (só migrations) não geram api_contract.md — exceção.
      const isDbOnly = predTitle.toLowerCase().includes("-db") || predTitle.toLowerCase().includes("database");
      if (!hasContract && !isDbOnly) {
        contractMissing.push(`"${predTitle}" (aceito mas sem api_contract.md no disco)`);
      }
    }

    if (contractMissing.length > 0) {
      const list = contractMissing.join(", ");
      return {
        ok: false,
        block: {
          code: "CONTRACT_MISSING",
          message:
            `Predecessores accepted mas sem contratos de API no disco: ${list}. ` +
            `Execute 'bash project/start.sh' nos predecessores ou verifique se api_contract.md foi gerado pelo DevOps.`,
          missingContracts: contractMissing,
        },
      };
    }
  }

  return { ok: true };
}
