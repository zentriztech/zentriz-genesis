import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { getInstallationInfo } from "../services/github.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

type ConnectBody = { installationId?: number };

export async function githubRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  /** GET /api/github/installation — retorna instalação ativa do tenant */
  app.get("/api/github/installation", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Usuário sem tenant associado" });
    }

    const result = await pool.query(
      `SELECT installation_id, github_login, installation_type, repos_authorized,
              selected_repos, scope_genesis, scope_deadpool, installed_at, revoked_at
       FROM tenant_github_installations WHERE tenant_id = $1`,
      [user.tenantId]
    );

    if (result.rows.length === 0) {
      return reply.send({ connected: false });
    }

    const row = result.rows[0];
    return reply.send({
      connected: !row.revoked_at,
      installationId: row.installation_id,
      githubLogin: row.github_login,
      installationType: row.installation_type,
      reposAuthorized: row.repos_authorized,
      selectedRepos: row.selected_repos,
      scopeGenesis: row.scope_genesis,
      scopeDeadpool: row.scope_deadpool,
      installedAt: (row.installed_at as Date)?.toISOString(),
      revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null,
    });
  });

  /** POST /api/github/installation — conecta GitHub App ao tenant */
  app.post<{ Body: ConnectBody }>("/api/github/installation", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Usuário sem tenant associado" });
    }

    const { installationId } = request.body ?? {};
    if (!installationId || typeof installationId !== "number") {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "installationId é obrigatório" });
    }

    // Validate installation against GitHub (when App is configured)
    let info = {
      githubLogin: "",
      installationType: "Organization" as "Organization" | "User",
      reposAuthorized: "all" as "all" | "selected",
      selectedRepos: [] as string[],
    };

    try {
      const fetched = await getInstallationInfo(installationId);
      info = {
        githubLogin: fetched.githubLogin,
        installationType: fetched.installationType,
        reposAuthorized: fetched.reposAuthorized,
        selectedRepos: fetched.selectedRepos,
      };
    } catch {
      // GitHub App not configured — accept with empty info (PAT fallback mode)
    }

    await pool.query(
      `INSERT INTO tenant_github_installations
         (tenant_id, installation_id, github_login, installation_type, repos_authorized, selected_repos, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (tenant_id) DO UPDATE SET
         installation_id   = EXCLUDED.installation_id,
         github_login      = EXCLUDED.github_login,
         installation_type = EXCLUDED.installation_type,
         repos_authorized  = EXCLUDED.repos_authorized,
         selected_repos    = EXCLUDED.selected_repos,
         revoked_at        = NULL,
         installed_at      = now()`,
      [
        user.tenantId,
        installationId,
        info.githubLogin || `installation-${installationId}`,
        info.installationType,
        info.reposAuthorized,
        info.selectedRepos,
      ]
    );

    return reply.status(201).send({
      connected: true,
      installationId,
      githubLogin: info.githubLogin,
    });
  });

  /** DELETE /api/github/installation — revoga acesso GitHub do tenant */
  app.delete("/api/github/installation", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Usuário sem tenant associado" });
    }

    const result = await pool.query(
      `UPDATE tenant_github_installations SET revoked_at = now()
       WHERE tenant_id = $1 AND revoked_at IS NULL
       RETURNING installation_id`,
      [user.tenantId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Nenhuma instalação ativa encontrada" });
    }

    return reply.send({ revoked: true, installationId: result.rows[0].installation_id });
  });
}
