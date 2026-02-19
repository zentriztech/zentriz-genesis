"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { observer } from "mobx-react-lite";
import { motion } from "framer-motion";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Typography from "@mui/material/Typography";
import Schedule from "@mui/icons-material/Schedule";
import CalendarToday from "@mui/icons-material/CalendarToday";
import ArrowBack from "@mui/icons-material/ArrowBack";
import PlayArrow from "@mui/icons-material/PlayArrow";
import Stop from "@mui/icons-material/Stop";
import Replay from "@mui/icons-material/Replay";
import CheckCircle from "@mui/icons-material/CheckCircle";
import { projectsStore } from "@/stores/projectsStore";
import { ProjectDialogue } from "@/components/ProjectDialogue";
import { apiPost } from "@/lib/api";

const STEPS = ["Spec enviada", "Engineer (proposta)", "CTO (Charter)", "PM (Backlog)", "Dev/QA/Monitor", "DevOps", "Concluído"];

const STATUSES_ALLOW_RUN = new Set([
  "draft",
  "spec_submitted",
  "pending_conversion",
  "cto_charter",
  "pm_backlog",
  "stopped",
  "failed",
]);
const STATUS_RUNNING = "running";

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const days = Math.floor((end - start) / 86400000);
  if (days === 0) {
    const hours = Math.floor((end - start) / 3600000);
    if (hours === 0) {
      const mins = Math.floor((end - start) / 60000);
      return `${mins} min`;
    }
    return `${hours} h`;
  }
  return `${days} dia${days !== 1 ? "s" : ""}`;
}

const blockMotion = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3 },
};

const MotionCard = motion(Card);

function ProjectDetailPageInner() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [triedLoad, setTriedLoad] = useState(false);
  const [runPipelineLoading, setRunPipelineLoading] = useState(false);
  const [runPipelineError, setRunPipelineError] = useState<string | null>(null);
  const [runPipelineSuccess, setRunPipelineSuccess] = useState(false);
  const [acceptLoading, setAcceptLoading] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const project = projectsStore.getById(id);

  useEffect(() => {
    if (!id) return;
    if (project) setTriedLoad(true);
    else {
      projectsStore.loadProject(id).then(() => setTriedLoad(true));
    }
  }, [id, project]);

  useEffect(() => {
    if (!id || project?.status !== "running") return;
    const t = setInterval(() => projectsStore.loadProject(id), 5000);
    return () => clearInterval(t);
  }, [id, project?.status]);

  if (!project) {
    return (
      <Box>
        {!triedLoad ? (
          <Typography color="text.secondary">Carregando…</Typography>
        ) : (
          <>
            <Typography>Projeto não encontrado.</Typography>
            <Button startIcon={<ArrowBack />} onClick={() => router.push("/projects")}>
              Voltar
            </Button>
          </>
        )}
      </Box>
    );
  }

  const stepIndex =
    project.status === "running"
      ? 1
      : project.status === "spec_submitted"
        ? 1
        : project.status === "cto_charter"
          ? 2
          : project.status === "pm_backlog"
            ? 3
            : project.status === "dev_qa"
              ? 4
              : project.status === "devops"
                ? 5
                : project.status === "completed" || project.status === "accepted"
                  ? 6
                  : 0;

  const hasProcessDates = project.startedAt || project.completedAt;
  const duration =
    project.startedAt && project.completedAt
      ? formatDuration(project.startedAt, project.completedAt)
      : null;

  return (
    <Box>
      <Button
        startIcon={<ArrowBack />}
        onClick={() => router.push("/projects")}
        sx={{ mb: 2 }}
        variant="outlined"
      >
        Voltar
      </Button>

      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }} sx={{ mb: 2 }}>
        <Typography variant="h4" fontWeight={600}>
          {project.title ?? "Spec sem título"}
        </Typography>
        <Chip
          label={
            project.status === "running"
              ? "Em execução"
              : project.status === "accepted"
                ? "Aceito"
                : project.status
          }
          color={
            project.status === "completed" || project.status === "accepted"
              ? "success"
              : project.status === "failed" || project.status === "stopped"
                ? "error"
                : project.status === "running"
                  ? "info"
                  : "default"
          }
          sx={{ alignSelf: { xs: "flex-start", sm: "center" } }}
        />
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Spec: {project.specRef} • Criado em {formatDateTime(project.createdAt)}
      </Typography>

      <Box sx={{ mb: 2, display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center" }}>
        {project.status === STATUS_RUNNING && (
          <>
            <Button
              variant="outlined"
              color="error"
              startIcon={<Stop />}
              disabled={runPipelineLoading}
              onClick={async () => {
                setRunPipelineError(null);
                setRunPipelineLoading(true);
                try {
                  await apiPost<{ ok: boolean; message?: string }>(`/api/projects/${id}/stop`, {});
                  await projectsStore.loadProject(id);
                } catch (err) {
                  setRunPipelineError(err instanceof Error ? err.message : "Falha ao parar pipeline");
                } finally {
                  setRunPipelineLoading(false);
                }
              }}
            >
              {runPipelineLoading ? "Parando…" : "Parar pipeline"}
            </Button>
            <Typography variant="body2" color="text.secondary">
              Pipeline em andamento. O log é atualizado abaixo.
            </Typography>
          </>
        )}
        {STATUSES_ALLOW_RUN.has(project.status) && project.status !== STATUS_RUNNING && (
          <>
            <Button
              variant="contained"
              color="primary"
              startIcon={project.status === "stopped" || project.status === "failed" ? <Replay /> : <PlayArrow />}
              disabled={runPipelineLoading}
              onClick={async () => {
                setRunPipelineError(null);
                setRunPipelineSuccess(false);
                setRunPipelineLoading(true);
                try {
                  await apiPost<{ ok: boolean; message?: string }>(`/api/projects/${id}/run`, {});
                  setRunPipelineSuccess(true);
                  await projectsStore.loadProject(id);
                } catch (err) {
                  setRunPipelineError(err instanceof Error ? err.message : "Falha ao iniciar pipeline");
                } finally {
                  setRunPipelineLoading(false);
                }
              }}
            >
              {runPipelineLoading
                ? "Iniciando…"
                : project.status === "stopped" || project.status === "failed"
                  ? "Reiniciar do início"
                  : "Iniciar pipeline"}
            </Button>
            {(project.status === "stopped" || project.status === "failed") && (
              <Typography variant="body2" color="text.secondary">
                Reinicia o fluxo do zero (Spec → Engineer → CTO → PM).
              </Typography>
            )}
          </>
        )}
        {(project.status === "completed" || project.status === "running") &&
          project.status !== "accepted" &&
          project.status !== "stopped" && (
            <Button
              variant="contained"
              color="success"
              startIcon={<CheckCircle />}
              disabled={acceptLoading}
              onClick={async () => {
                setAcceptError(null);
                setAcceptLoading(true);
                try {
                  await apiPost<{ ok: boolean; status?: string }>(
                    `/api/projects/${id}/accept`,
                    {}
                  );
                  await projectsStore.loadProject(id);
                } catch (err) {
                  setAcceptError(
                    err instanceof Error ? err.message : "Falha ao aceitar projeto"
                  );
                } finally {
                  setAcceptLoading(false);
                }
              }}
            >
              {acceptLoading ? "Aceitando…" : "Aceitar projeto"}
            </Button>
          )}
        {(project.status === "completed" || project.status === "running") &&
          project.status !== "accepted" && (
            <Typography variant="body2" color="text.secondary">
              Ao aceitar, o pipeline será encerrado e o projeto marcado como aceito.
            </Typography>
          )}
        {runPipelineSuccess && project.status !== STATUS_RUNNING && (
          <Typography variant="body2" color="success.main">
            Pipeline iniciado. O log será atualizado em breve.
          </Typography>
        )}
        {(runPipelineError || acceptError) && (
          <Typography variant="body2" color="error.main">
            {runPipelineError ?? acceptError}
          </Typography>
        )}
      </Box>

      {hasProcessDates && (
        <MotionCard variant="outlined" sx={{ mb: 3, p: 2 }} {...blockMotion}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Resumo do processo
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} flexWrap="wrap" useFlexGap>
            {project.startedAt && (
              <Stack direction="row" alignItems="center" spacing={1}>
                <Schedule fontSize="small" color="action" />
                <Typography variant="body2">
                  Início: {formatDateTime(project.startedAt)}
                </Typography>
              </Stack>
            )}
            {project.completedAt && (
              <Stack direction="row" alignItems="center" spacing={1}>
                <CalendarToday fontSize="small" color="action" />
                <Typography variant="body2">
                  Fim: {formatDateTime(project.completedAt)}
                </Typography>
              </Stack>
            )}
            {duration && (
              <Typography variant="body2" fontWeight={500}>
                Duração: {duration}
              </Typography>
            )}
          </Stack>
        </MotionCard>
      )}

      <MotionCard variant="outlined" sx={{ p: 2, mb: 3 }} {...blockMotion}>
        <Stepper activeStep={stepIndex} orientation="horizontal" sx={{ flexWrap: "wrap" }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>
      </MotionCard>

      {project.charterSummary && (
        <MotionCard sx={{ mt: 2 }} {...blockMotion}>
          <CardContent>
            <Typography variant="h6" gutterBottom fontWeight={600}>
              Charter (CTO)
            </Typography>
            <Typography variant="body2">{project.charterSummary}</Typography>
          </CardContent>
        </MotionCard>
      )}

      {project.backlogSummary && (
        <MotionCard sx={{ mt: 2 }} variant="outlined" {...blockMotion}>
          <CardContent>
            <Typography variant="h6" gutterBottom fontWeight={600}>
              Backlog (PM)
            </Typography>
            <Typography variant="body2">{project.backlogSummary}</Typography>
          </CardContent>
        </MotionCard>
      )}

      <MotionCard variant="outlined" sx={{ mt: 3, p: 2 }} {...blockMotion}>
        <Typography variant="h6" gutterBottom fontWeight={600}>
          Diálogo da equipe
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          O que os agentes estão fazendo (atualização automática).
        </Typography>
        <ProjectDialogue
          projectId={id}
          pollIntervalMs={project.status === STATUS_RUNNING ? 5000 : 10000}
        />
      </MotionCard>

      <Box sx={{ mt: 3 }}>
        <Button variant="outlined" disabled size="small" sx={{ mr: 1 }}>
          Exportar
        </Button>
        <Button variant="outlined" disabled size="small">
          Compartilhar
        </Button>
      </Box>
    </Box>
  );
}

export default observer(ProjectDetailPageInner);
