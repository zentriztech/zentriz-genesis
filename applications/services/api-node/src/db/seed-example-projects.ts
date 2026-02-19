/**
 * Seed: 2 projetos de exemplo + logs de diálogo para testar o Genesis-Web.
 * Usa o primeiro tenant e usuário com tenant (ex.: admin@tenant.com) existentes.
 *
 * Executar (na raiz do repo ou em applications/services/api-node):
 *   PGHOST=localhost PGUSER=genesis PGPASSWORD=genesis_dev PGDATABASE=zentriz_genesis npm run seed:examples
 * Ou, com .env na raiz carregado: npm run seed:examples (a API usa variáveis do ambiente).
 *
 * Se a API rodar no Docker, use: docker compose exec api node -e "
 *   require('dotenv').config({ path: '/app/.env' }); require('./dist/db/seed-example-projects.js');
 * " ou rode na máquina local com PGHOST=localhost.
 */
import { pool } from "./client.js";

const TITLE_DEV = "Portal de Vouchers (em desenvolvimento)";
const TITLE_DONE = "Sistema de Cadastro MVP (concluído)";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const tenantUser = await client.query(
      `SELECT id, tenant_id FROM users WHERE tenant_id IS NOT NULL AND status = 'active' LIMIT 1`
    );
    if (tenantUser.rows.length === 0) {
      console.error("Nenhum usuário com tenant encontrado. Rode o seed principal primeiro (npm start ou seed).");
      process.exit(1);
    }
    const userId = tenantUser.rows[0].id as string;
    const tenantId = tenantUser.rows[0].tenant_id as string;

    const existingByTitle = await client.query(
      `SELECT id, title FROM projects WHERE tenant_id = $1 AND (title = $2 OR title = $3)`,
      [tenantId, TITLE_DEV, TITLE_DONE]
    );
    const hasDev = existingByTitle.rows.some((r: { title: string }) => r.title === TITLE_DEV);
    const hasDone = existingByTitle.rows.some((r: { title: string }) => r.title === TITLE_DONE);
    let projectDevId: string | null = hasDev ? existingByTitle.rows.find((r: { title: string }) => r.title === TITLE_DEV)?.id ?? null : null;
    let projectDoneId: string | null = hasDone ? existingByTitle.rows.find((r: { title: string }) => r.title === TITLE_DONE)?.id ?? null : null;

    const now = new Date();
    const startedDev = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const startedDone = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const completedDone = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    if (!hasDev) {
      const ins = await client.query(
        `INSERT INTO projects (tenant_id, created_by, title, spec_ref, status, charter_summary, started_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
        [
          tenantId,
          userId,
          TITLE_DEV,
          "spec/vouchers-portal.md",
          "dev_qa",
          "Charter: portal de vouchers com listagem, filtros e gestão por tenant.",
          startedDev,
        ]
      );
      projectDevId = ins.rows[0].id;
      console.log("Projeto criado (em dev):", projectDevId);
    }

    if (!hasDone) {
      const ins = await client.query(
        `INSERT INTO projects (tenant_id, created_by, title, spec_ref, status, charter_summary, started_at, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
        [
          tenantId,
          userId,
          TITLE_DONE,
          "spec/cadastro-mvp.md",
          "completed",
          "Charter: MVP de cadastro de entidades com CRUD e validação.",
          startedDone,
          completedDone,
        ]
      );
      projectDoneId = ins.rows[0].id;
      console.log("Projeto criado (concluído):", projectDoneId);
    }

    const dialogueRows: { project_id: string; from_agent: string; to_agent: string; event_type: string; summary_human: string; created_at: Date }[] = [];

    const add = (projectId: string, from: string, to: string, eventType: string, summary: string, createdAt: Date) => {
      dialogueRows.push({ project_id: projectId, from_agent: from, to_agent: to, event_type: eventType, summary_human: summary, created_at: createdAt });
    };

    const projectIdsToRefresh = [projectDevId, projectDoneId].filter(Boolean) as string[];
    if (projectIdsToRefresh.length > 0) {
      await client.query(`DELETE FROM project_dialogue WHERE project_id = ANY($1)`, [projectIdsToRefresh]);
    }

    if (projectDevId) {
      let t = new Date(now.getTime() - 60 * 60 * 1000);
      add(projectDevId, "cto", "engineer", "cto.engineer.request", "O CTO enviou a especificação do projeto ao Engineer para definir as equipes e squads técnicas necessárias.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 2);
      add(projectDevId, "engineer", "cto", "engineer.cto.response", "O Engineer entregou a proposta técnica (squads, equipes e dependências) ao CTO.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 3);
      add(projectDevId, "cto", "pm", "project.created", "O CTO consolidou o Charter do projeto com base na proposta do Engineer.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 5);
      add(projectDevId, "pm", "cto", "module.planned", "O PM gerou o backlog do módulo com base no Charter.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 2);
      add(projectDevId, "pm", "dev", "pm.stack.hire", "Contratação da squad: atribuída a tarefa T1 (API de listagem de vouchers) ao Dev.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 1);
      add(projectDevId, "pm", "qa", "pm.stack.hire", "Contratação da squad: atribuída a validação das tarefas da sprint ao QA.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 1);
      add(projectDevId, "pm", "monitor", "pm.stack.hire", "Contratação da squad: atribuído o acompanhamento do progresso e o acionamento do QA ao Monitor.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 5);
      add(projectDevId, "pm", "dev", "pm.task.assign", "Sprint 1: prioridade nas tasks T1 (API listagem) e T2 (endpoint de resgate); prazo até sexta.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 30);
      add(projectDevId, "dev", "pm", "dev.task.done", "T1 concluída; evidências no repositório. Iniciando T2.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 2);
      add(projectDevId, "pm", "monitor", "pm.monitor.request", "Por favor acione o QA para validar a tarefa T1 (API de listagem).", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 1);
      add(projectDevId, "monitor", "qa", "monitor.qa.request", "Validar tarefa T1 (API listagem) conforme critérios de aceite do backlog.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 15);
      add(projectDevId, "qa", "monitor", "qa.result", "Validação T1: OK. Relatório anexado.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 2);
      add(projectDevId, "monitor", "pm", "monitor.status", "QA aprovou T1. Dev segue em T2.", new Date(t.getTime()));
    }

    if (projectDoneId) {
      let t = new Date(completedDone.getTime() - 120 * 60 * 1000);
      add(projectDoneId, "cto", "engineer", "cto.engineer.request", "O CTO enviou a especificação do projeto ao Engineer para definir as equipes e squads técnicas necessárias.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 2);
      add(projectDoneId, "engineer", "cto", "engineer.cto.response", "O Engineer entregou a proposta técnica (squads, equipes e dependências) ao CTO.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 3);
      add(projectDoneId, "cto", "pm", "project.created", "O CTO consolidou o Charter do projeto com base na proposta do Engineer.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 4);
      add(projectDoneId, "pm", "cto", "module.planned", "O PM gerou o backlog do módulo com base no Charter.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 2);
      add(projectDoneId, "pm", "dev", "pm.stack.hire", "Contratação da squad: atribuídas as tarefas de CRUD e validação ao Dev.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 1);
      add(projectDoneId, "pm", "qa", "pm.stack.hire", "Contratação da squad: atribuída a validação e testes ao QA.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 1);
      add(projectDoneId, "pm", "monitor", "pm.stack.hire", "Contratação da squad: atribuído o acompanhamento e o acionamento QA/DevOps ao Monitor.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 10);
      add(projectDoneId, "pm", "dev", "pm.task.assign", "Sprint única: entregar CRUD completo e documentação da API.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 45);
      add(projectDoneId, "dev", "pm", "dev.task.done", "CRUD e testes de integração concluídos; documentação OpenAPI disponível.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 5);
      add(projectDoneId, "pm", "monitor", "pm.monitor.request", "Acionar QA para validação final e depois DevOps para provisionamento.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 3);
      add(projectDoneId, "monitor", "qa", "monitor.qa.request", "Validar fluxo completo (CRUD e critérios de aceite) e reportar resultado.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 20);
      add(projectDoneId, "qa", "monitor", "qa.result", "Validação final: OK. Todos os critérios atendidos.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 2);
      add(projectDoneId, "monitor", "pm", "monitor.status", "QA aprovou. Acionando DevOps para deploy.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 60);
      add(projectDoneId, "devops", "monitor", "devops.deployed", "O DevOps concluiu o provisionamento e informou o Monitor.", new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 5);
      add(projectDoneId, "monitor", "pm", "monitor.alert", "O Monitor informou ao PM que o pipeline foi concluído com sucesso.", new Date(t.getTime()));
    }

    for (const row of dialogueRows) {
      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.project_id, row.from_agent, row.to_agent, row.event_type, row.summary_human, row.created_at]
      );
    }
    console.log("Diálogos de exemplo inseridos:", dialogueRows.length);
    console.log("Pronto. Faça login no Genesis-Web (admin@tenant.com ou user@tenant.com) e abra os projetos.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
