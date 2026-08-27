"use client";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import GitHubIcon from "@mui/icons-material/GitHub";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import CloudDoneIcon from "@mui/icons-material/CloudDone";

/**
 * Ícones-link de recursos de um projeto: GitHub (se tem repo), S3 (se tem deploy efêmero ativo)
 * e "deployado e running" (se tem backend durável no ar).
 * Renderiza nada quando o projeto não tem nenhum recurso.
 * Usado em todas as listas de projetos (cards, tabelas, dashboard).
 *
 * `e.stopPropagation()` evita que o clique no ícone dispare o onClick do card/linha pai.
 */
export function ResourceBadges({
  repoUrl,
  repoFullName,
  deployUrl,
  deployStatus,
  backendDeployStatus,
  size = "small",
}: {
  repoUrl?: string | null;
  repoFullName?: string | null;
  deployUrl?: string | null;
  deployStatus?: string | null;
  backendDeployStatus?: string | null;
  size?: "small" | "medium";
}) {
  if (!repoUrl && !deployUrl && !backendDeployStatus) return null;
  const iconSize = size === "small" ? "1rem" : "1.25rem";
  const degraded = backendDeployStatus === "running_degraded";

  return (
    <Stack direction="row" spacing={0.25} alignItems="center">
      {repoUrl && (
        <Tooltip title={repoFullName ? `Repositório: ${repoFullName}` : "Ver no GitHub"}>
          <IconButton
            size={size}
            component="a"
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            sx={{ p: 0.4, color: "text.secondary", "&:hover": { color: "text.primary" } }}
          >
            <GitHubIcon sx={{ fontSize: iconSize }} />
          </IconButton>
        </Tooltip>
      )}
      {deployUrl && (
        <Tooltip title={`Deploy S3 ativo${deployStatus ? ` (${deployStatus})` : ""} — abrir`}>
          <IconButton
            size={size}
            component="a"
            href={deployUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            sx={{ p: 0.4, color: "#0EA5E9", "&:hover": { color: "#0284C7" } }}
          >
            <RocketLaunchIcon sx={{ fontSize: iconSize }} />
          </IconButton>
        </Tooltip>
      )}
      {backendDeployStatus && (
        <Tooltip title={degraded ? "Deployado — running (degradado)" : "Deployado e running"}>
          <Box
            component="span"
            aria-label={degraded ? "Deployado (degradado)" : "Deployado e running"}
            sx={{ display: "inline-flex", alignItems: "center", p: 0.4, color: degraded ? "#F59E0B" : "#10B981" }}
          >
            <CloudDoneIcon sx={{ fontSize: iconSize }} />
          </Box>
        </Tooltip>
      )}
    </Stack>
  );
}
