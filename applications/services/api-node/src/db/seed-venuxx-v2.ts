/**
 * Seed: produto "Venuxx V2" + 28 apps (projetos) com arco de diálogo canônico,
 * para o tenant Venuxx já existente em PRODUÇÃO.
 *
 * Modelo "todo App vive num Produto" (migração 064): os 28 apps NÃO vão para o INBOX
 * "Rascunhos"; nascem como projetos do produto de entrega "Venuxx V2" (system_id='venuxx-v2'),
 * cada um em estado terminal ('accepted' = serviço vivo próprio; 'completed' = lib/CLI/infra/e2e).
 *
 * Uso (no container de PROD, com o JS compilado):
 *   node dist/db/seed-venuxx-v2.js            # dry-run (default): executa tudo numa tx e faz ROLLBACK
 *   node dist/db/seed-venuxx-v2.js --commit   # persiste (COMMIT)
 *   node dist/db/seed-venuxx-v2.js --rollback # DELETE real escopado por tenant+produto (não é ROLLBACK-de-tx)
 *
 * Idempotência (§9 do plano): tenant e admin JÁ existem — o seed NÃO os cria.
 *   - Produto: find-or-create por (tenant_id, lower(system_id)) — evita ON CONFLICT em índice PARCIAL.
 *   - Apps: find-or-create por (tenant_id, product_id, title) — NÃO há unique nessa tripla.
 *   - Diálogos/tarefas/specs: DELETE por project_id antes de reinserir o arco (reexecução limpa).
 *
 * O admin já existe → não é preciso senha/hashPassword. Auto Care (Deadpool) fica FORA do seed.
 */
import { pool } from "./client.js";
import { normalizeProjectType } from "../services/typePolicyNormalizer.js";

const TENANT_ID = "0931c5dc-46eb-474a-a54a-dad12733b4b2"; // VENUXX TECHNOLOGIES LTDA (PROD)
const PRODUCT_NAME = "Venuxx V2";
const SYSTEM_ID = "venuxx-v2";

type AppStatus = "accepted" | "completed";
type AppModule = "backend" | "web";

interface AppDef {
  title: string;
  type: string; // rótulo de inventário → normalizeProjectType() aplica a taxonomia canônica
  stack: string;
  desc: string;
  status: AppStatus;
  module: AppModule;
}

// §4.2 do plano — os 28 apps (16 accepted + 12 completed).
const APPS: AppDef[] = [
  { title: "logistics-ingest", type: "backend_api", stack: "Node 20 · TS · Lambda", desc: "POST /orders/ingest grava pedidos RAW no DynamoDB de forma idempotente.", status: "accepted", module: "backend" },
  { title: "logistics-admin-api", type: "backend_api", stack: "Node 20 · TS · Lambda", desc: "API /auth/*, /mgmt/* e /public/tracking/* para o Portal e a Maya.", status: "accepted", module: "backend" },
  { title: "logistics-webhook", type: "backend_api", stack: "Node 20 · TS · Lambda · RabbitMQ", desc: "Webhooks Tookan e workers de bipagem.", status: "accepted", module: "backend" },
  { title: "logistics-dlq-admin", type: "backend_api", stack: "Node 20 · TS · Lambda", desc: "API administrativa da DLQ.", status: "accepted", module: "backend" },
  { title: "logistics-test-webhook-sink", type: "backend_api", stack: "Node 20 · TS · Lambda", desc: "GET/POST /logistics/sink — sink de testes de webhook.", status: "accepted", module: "backend" },
  { title: "logistics-normalizer", type: "backend_worker", stack: "Node 20 · TS · Lambda", desc: "Normaliza RAW para MySQL e grava outbox.", status: "accepted", module: "backend" },
  { title: "logistics-dlq-consumer", type: "backend_worker", stack: "Node 20 · TS · Lambda", desc: "Consome mensagens da DLQ.", status: "accepted", module: "backend" },
  { title: "logistics-outbox-publisher", type: "backend_worker", stack: "Node 20 · TS · Lambda", desc: "Publica outbox_events no RabbitMQ.", status: "accepted", module: "backend" },
  { title: "logistics-outbound-dispatcher", type: "backend_worker", stack: "Node 20 · TS · Lambda · RabbitMQ", desc: "RabbitMQ despacha para webhooks e destinos externos.", status: "accepted", module: "backend" },
  { title: "logistics-dsl-ai-service", type: "backend_worker", stack: "Node 20 · TS · Lambda · SQS · Bedrock", desc: "Gera DSL de normalização via IA em jobs assíncronos (SQS).", status: "accepted", module: "backend" },
  { title: "logistics-infra", type: "infra_cicd", stack: "Node 20 · TS", desc: "Placeholder/noop de infra do pipeline serverless.", status: "completed", module: "backend" },
  { title: "core", type: "lib_ts", stack: "TS", desc: "HTTP helpers, logger e respostas Lambda.", status: "completed", module: "backend" },
  { title: "database-drizzle", type: "lib_ts", stack: "TS · Drizzle · MySQL", desc: "Cliente Drizzle e pool MySQL.", status: "completed", module: "backend" },
  { title: "database-logistics", type: "lib_ts", stack: "TS", desc: "Schema e repositórios de domínio logístico.", status: "completed", module: "backend" },
  { title: "dynamodb", type: "lib_ts", stack: "TS · DynamoDB", desc: "Acesso a RAW e templates no DynamoDB.", status: "completed", module: "backend" },
  { title: "logistics-raw", type: "lib_ts", stack: "TS", desc: "Modelo e operações do RAW.", status: "completed", module: "backend" },
  { title: "template-engine", type: "lib_ts", stack: "TS · JSONPath", desc: "DSL de normalização por template.", status: "completed", module: "backend" },
  { title: "rabbitmq", type: "lib_ts", stack: "TS · amqplib", desc: "Publicação e consumo AMQP.", status: "completed", module: "backend" },
  { title: "infrastructure", type: "lib_ts", stack: "TS", desc: "Utilitários de infraestrutura compartilhados.", status: "completed", module: "backend" },
  { title: "logistics-seed", type: "lib_ts", stack: "TS", desc: "Scripts de seed MySQL/Dynamo.", status: "completed", module: "backend" },
  { title: "portal", type: "frontend_dashboard", stack: "Next.js 15 · React 18", desc: "Painel de operação: pedidos, tenants, CRMs, DLQ e rastreio público.", status: "accepted", module: "web" },
  { title: "autonomy-cli", type: "lib_cli", stack: "Node · pnpm", desc: "CLI de ciclos de autonomia (analyze/evolve/loop).", status: "completed", module: "backend" },
  { title: "identity", type: "backend_api_python", stack: "Python 3.12 · FastAPI · Postgres · Celery", desc: "IdP OIDC próprio do ecossistema Venuxx.", status: "accepted", module: "backend" },
  { title: "tax", type: "backend_api_python", stack: "Python 3.12 · FastAPI · Postgres · Celery · Redis", desc: "Documentos fiscais de transporte (CT-e, CT-e OS, MDF-e).", status: "accepted", module: "backend" },
  { title: "tms", type: "backend_api_python", stack: "Python 3.12 · FastAPI · Postgres · Celery · Redis", desc: "Gestão de transporte: cotação, seleção, despacho e tracking.", status: "accepted", module: "backend" },
  { title: "maya", type: "bot_chat", stack: "Python 3.12 · FastAPI/Mangum · Lambda · Bedrock", desc: "Assistente de IA que cadastra tenants/CRMs e gera DSL por chat.", status: "accepted", module: "backend" },
  { title: "infra-terraform", type: "infra_cicd", stack: "Terraform · AWS ECS/ALB/RDS/Redis", desc: "IaC de dev, staging e prod.", status: "completed", module: "backend" },
  { title: "connect-e2e", type: "other", stack: "Playwright · TS", desc: "Suíte E2E da plataforma Connect.", status: "completed", module: "backend" },
];

// Arco canônico VERIFICADO contra runner.py (§5.0): [from_agent, to_agent, event_type].
// As colunas from/to vêm dos 2 PRIMEIROS args de _post_dialogue (não dos args de _get_summary_human).
//   cto.engineer.request  cto→engineer   (runner.py:4387)
//   engineer.cto.response engineer→cto   (runner.py:4388)
//   project.created       cto→pm         (runner.py:4538)
//   module.planned        pm→cto         (runner.py:4879)
//   task.assigned         pm→dev         (runner.py:5064)
//   task.completed        dev→qa         (runner.py:5069)
//   qa.review             dev→qa         (runner.py:5121)  ← corrigido (colunas dev/qa)
//   monitor.health        monitor→pm     (runner.py:5152)
//   devops.deploy         monitor→devops (runner.py:5200)  ← corrigido (colunas monitor/devops)
//   step (final)          system→system  (runner.py:1815)
type Turn = { from: string; to: string; event: string; text: (a: AppDef) => string };

const short = (s: string): string => (s.length > 60 ? s.slice(0, 57) + "…" : s);
const devTask = (a: AppDef): string => (a.module === "web" ? "TSK-WEB-001" : "TSK-BE-001");

const ARC: Turn[] = [
  { from: "cto", to: "engineer", event: "cto.engineer.request",
    text: (a) => `O CTO enviou a especificação de **${a.title}** ao Engineer para definir as squads técnicas.` },
  { from: "engineer", to: "cto", event: "engineer.cto.response",
    text: (a) => `O Engineer respondeu com a composição de squads para **${a.title}** (${short(a.stack)}).` },
  { from: "cto", to: "pm", event: "project.created",
    text: (a) => `O projeto **${a.title}** foi criado e entregue ao PM para planejamento.` },
  { from: "pm", to: "cto", event: "module.planned",
    text: (a) => `O PM planejou o módulo **${a.module}** de **${a.title}**: ${a.desc}` },
  { from: "pm", to: "dev", event: "task.assigned",
    text: (a) => `O PM atribuiu ao Dev a **${devTask(a)}** — implementação de ${a.title}.` },
  { from: "dev", to: "qa", event: "task.completed",
    text: (a) => `O Dev concluiu a **${devTask(a)}**: ${a.title} implementado, com testes.` },
  { from: "dev", to: "qa", event: "qa.review",
    text: (a) => `O QA revisou a entrega de **${a.title}** — contrato, casos de borda e regressão — aprovado (QA_PASS).` },
  { from: "monitor", to: "pm", event: "monitor.health",
    text: (a) => `O Monitor verificou a saúde de **${a.title}**: healthcheck OK, métricas nominais, sem alertas.` },
  { from: "monitor", to: "devops", event: "devops.deploy",
    text: (a) =>
      a.status === "accepted"
        ? `O DevOps publicou **${a.title}** no ambiente de execução, com rota exposta e observabilidade ativa.`
        : `O DevOps consolidou os artefatos de **${a.title}** (build e empacotamento) para incorporação ao produto.` },
  { from: "system", to: "system", event: "step",
    text: (a) =>
      a.status === "accepted"
        ? `✅ Projeto **${a.title}** aceito e incorporado ao produto **Venuxx V2**.`
        : `✅ Pipeline concluído — **${a.title}** incorporado ao produto **Venuxx V2**.` },
];

interface Counters { products: number; projects: number; dialogues: number; tasks: number; specs: number; }

async function main(): Promise<void> {
  const mode = process.argv.includes("--commit")
    ? "commit"
    : process.argv.includes("--rollback")
    ? "rollback"
    : "dry-run";
  console.log(`[seed-venuxx-v2] modo = ${mode}`);

  const c: Counters = { products: 0, projects: 0, dialogues: 0, tasks: 0, specs: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Confirma que o tenant existe (o seed NÃO cria tenant nem admin).
    const tenant = await client.query(
      `SELECT id, status, billing_exempt, plan_id FROM tenants WHERE id = $1`,
      [TENANT_ID]
    );
    if (tenant.rows.length === 0) {
      throw new Error(`Tenant Venuxx ${TENANT_ID} não encontrado — criar antes (o seed não cria tenant).`);
    }
    console.log(`[seed] tenant: status=${tenant.rows[0].status} billing_exempt=${tenant.rows[0].billing_exempt} plan=${tenant.rows[0].plan_id}`);

    // created_by = admin (tenant_admin) já existente.
    const admin = await client.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND role = 'tenant_admin' AND status = 'active' ORDER BY created_at LIMIT 1`,
      [TENANT_ID]
    );
    if (admin.rows.length === 0) {
      throw new Error(`Admin (tenant_admin ativo) não encontrado para o tenant Venuxx — criar antes.`);
    }
    const createdBy = admin.rows[0].id as string;

    if (mode === "rollback") {
      // DELETE REAL escopado (§8.4): cascata em dialogue/tasks/spec_files via FK ON DELETE CASCADE dos filhos de projects.
      const prod = await client.query(
        `SELECT id FROM products WHERE tenant_id = $1 AND lower(system_id) = $2`,
        [TENANT_ID, SYSTEM_ID]
      );
      if (prod.rows.length > 0) {
        const pid = prod.rows[0].id as string;
        const delProjects = await client.query(`DELETE FROM projects WHERE tenant_id = $1 AND product_id = $2`, [TENANT_ID, pid]);
        const delProduct = await client.query(`DELETE FROM products WHERE id = $1`, [pid]);
        console.log(`[rollback] projetos removidos=${delProjects.rowCount}, produto removido=${delProduct.rowCount}`);
      } else {
        console.log(`[rollback] produto 'Venuxx V2' não existe — nada a remover.`);
      }
      await client.query("COMMIT");
      return;
    }

    // ── Produto 'Venuxx V2' (find-or-create; NÃO usa ON CONFLICT em índice parcial) ──
    let productId: string;
    const existingProduct = await client.query(
      `SELECT id FROM products WHERE tenant_id = $1 AND lower(system_id) = $2`,
      [TENANT_ID, SYSTEM_ID]
    );
    if (existingProduct.rows.length > 0) {
      productId = existingProduct.rows[0].id as string;
      console.log(`[produto] 'Venuxx V2' já existe: ${productId}`);
    } else {
      const insProduct = await client.query(
        `INSERT INTO products (tenant_id, created_by, name, description, status, lifecycle_status, is_inbox, solo_app, system_id)
         VALUES ($1, $2, $3, $4, 'active', 'accepted', false, false, $5) RETURNING id`,
        [TENANT_ID, createdBy, PRODUCT_NAME, "Ecossistema Venuxx V2 — logística/TMS/rastreamento/IdP (28 apps).", SYSTEM_ID]
      );
      productId = insProduct.rows[0].id as string;
      c.products += 1;
      console.log(`[produto] 'Venuxx V2' criado: ${productId}`);
    }

    // ── Apps ──
    // Base temporal fixa (determinística): T0 e +1 min por turno; +2h por app para ordenar o grafo.
    const T0_MS = Date.UTC(2026, 2, 2, 9, 0, 0); // 2026-03-02T09:00:00Z
    for (let i = 0; i < APPS.length; i++) {
      const app = APPS[i];
      const projectType = normalizeProjectType(app.type) ?? "_default";
      const specPath = `specs/${app.title}.md`;
      const appBaseMs = T0_MS + i * 2 * 60 * 60 * 1000; // +2h por app

      // find-or-create do projeto por (tenant_id, product_id, title)
      const existing = await client.query(
        `SELECT id FROM projects WHERE tenant_id = $1 AND product_id = $2 AND title = $3`,
        [TENANT_ID, productId, app.title]
      );
      let projectId: string;
      const startedAt = new Date(appBaseMs);
      const completedAt = new Date(appBaseMs + (ARC.length - 1) * 60 * 1000);
      const charter = short(app.desc);
      const backlog = app.status === "accepted" ? "1 módulo, 3 tarefas" : "1 módulo, 2 tarefas";
      const extra = JSON.stringify({ project_type: projectType, accepted_by: "zentriz-cyborg", venuxx_stack: app.stack });

      if (existing.rows.length > 0) {
        projectId = existing.rows[0].id as string;
        await client.query(
          `UPDATE projects SET status = $2, charter_summary = $3, backlog_summary = $4, spec_ref = $5,
             started_at = $6, completed_at = $7, extra = $8::jsonb, updated_at = now() WHERE id = $1`,
          [projectId, app.status, charter, backlog, specPath, startedAt, completedAt, extra]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO projects (tenant_id, created_by, product_id, title, spec_ref, status,
             charter_summary, backlog_summary, started_at, completed_at, extra, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now()) RETURNING id`,
          [TENANT_ID, createdBy, productId, app.title, specPath, app.status, charter, backlog, startedAt, completedAt, extra]
        );
        projectId = ins.rows[0].id as string;
        c.projects += 1;
      }

      // Reexecução limpa: apaga filhos antes de reinserir.
      await client.query(`DELETE FROM project_dialogue WHERE project_id = $1`, [projectId]);
      await client.query(`DELETE FROM project_tasks WHERE project_id = $1`, [projectId]);
      await client.query(`DELETE FROM project_spec_files WHERE project_id = $1`, [projectId]);

      // Arco (created_at monotônico +1 min/turno).
      for (let t = 0; t < ARC.length; t++) {
        const turn = ARC[t];
        const ca = new Date(appBaseMs + t * 60 * 1000);
        await client.query(
          `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [projectId, turn.from, turn.to, turn.event, turn.text(app), ca]
        );
        c.dialogues += 1;
      }

      // Tarefas terminais (owner_role MAIÚSCULO; DEV_WEB/QA_WEB para portal).
      const devRole = app.module === "web" ? "DEV_WEB" : "DEV_BACKEND";
      const qaRole = app.module === "web" ? "QA_WEB" : "QA_BACKEND";
      const tasks: { taskId: string; module: string; owner: string; status: string; req: string }[] = [
        { taskId: devTask(app), module: app.module, owner: devRole, status: "DONE", req: `Implementar ${app.title}: ${short(app.desc)}` },
        { taskId: "TSK-QA-001", module: app.module, owner: qaRole, status: "QA_PASS", req: `Validar ${app.title}: contrato, casos de borda e regressão.` },
      ];
      if (app.status === "accepted") {
        tasks.push({ taskId: "TSK-DEVOPS-001", module: "infra", owner: "DEVOPS_DOCKER", status: "DONE", req: `Publicar ${app.title} com observabilidade ativa.` });
      }
      for (const tk of tasks) {
        await client.query(
          `INSERT INTO project_tasks (project_id, task_id, module, owner_role, status, requirements)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [projectId, tk.taskId, tk.module, tk.owner, tk.status, tk.req]
        );
        c.tasks += 1;
      }

      // Spec file (tabela NÃO tem coluna content — só paths).
      await client.query(
        `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type)
         VALUES ($1, $2, $3, 'text/markdown')`,
        [projectId, `${app.title}.md`, specPath]
      );
      c.specs += 1;
    }

    console.log(
      `[seed] produtos=${c.products} projetos(novos)=${c.projects} diálogos=${c.dialogues} tarefas=${c.tasks} specs=${c.specs} | total apps=${APPS.length}`
    );

    if (mode === "commit") {
      await client.query("COMMIT");
      console.log("[seed] COMMIT — persistido em PROD.");
    } else {
      await client.query("ROLLBACK");
      console.log("[seed] DRY-RUN — nada persistido (ROLLBACK). Reexecute com --commit para gravar.");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
