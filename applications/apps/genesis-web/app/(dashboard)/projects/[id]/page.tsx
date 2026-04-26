"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { observer } from "mobx-react-lite";
import { motion } from "framer-motion";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import Schedule from "@mui/icons-material/Schedule";
import CalendarToday from "@mui/icons-material/CalendarToday";
import ArrowBack from "@mui/icons-material/ArrowBack";
import PlayArrow from "@mui/icons-material/PlayArrow";
import Stop from "@mui/icons-material/Stop";
import Replay from "@mui/icons-material/Replay";
import CheckCircle from "@mui/icons-material/CheckCircle";
import OpenInNew from "@mui/icons-material/OpenInNew";
import ContentCopy from "@mui/icons-material/ContentCopy";
import Tooltip from "@mui/material/Tooltip";
import Snackbar from "@mui/material/Snackbar";
import { projectsStore } from "@/stores/projectsStore";
import { ProjectDialogue, type DialogueEntry } from "@/components/ProjectDialogue";
import { apiGet, apiPost } from "@/lib/api";

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

type ArtifactsResponse = { docs: Array<{ filename: string; creator?: string; title?: string; created_at?: string }>; projectDocsRoot: string | null; projectArtifactsRoot: string | null };
type CodeFilesResponse = { files: Array<{ path: string; sizeBytes: number; ext: string }>; appsRoot: string | null; totalFiles: number };
type RunInfoResponse = { runCommand: string | null; appUrl: string | null; startShPath: string | null };
type MetricsResponse = { by_agent: Array<{ agent: string; calls: number; input_tokens: number; output_tokens: number }>; totals: { calls: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number } };
type TaskItem = { id: string; taskId: string; module?: string; ownerRole?: string; requirements?: string; status?: string; createdAt?: string; updatedAt?: string };

/** Mapeia from_agent do evento agent_working para o índice do passo no Stepper (0=Spec, 1=Engineer, ..., 6=Concluído). */
function agentToStepIndex(fromAgent: string): number {
  const a = (fromAgent || "").toLowerCase();
  if (a === "engineer") return 1;
  if (a === "cto") return 2;
  if (a === "pm") return 3;
  if (a === "dev" || a === "qa" || a === "monitor") return 4;
  if (a === "devops") return 5;
  return -1;
}

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
  const [workingStepIndex, setWorkingStepIndex] = useState<number | null>(null);
  const [workingMessage, setWorkingMessage] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactsResponse | null>(null);
  const [codeFiles, setCodeFiles] = useState<CodeFilesResponse | null>(null);
  const [runInfo, setRunInfo] = useState<RunInfoResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const project = projectsStore.getById(id);

  const handleDialogueEntriesLoaded = useCallback((entries: DialogueEntry[]) => {
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    if (last?.eventType === "agent_working") {
      const step = agentToStepIndex(last.fromAgent);
      setWorkingStepIndex(step >= 0 ? step : null);
      setWorkingMessage(last.summaryHuman || null);
    } else {
      setWorkingStepIndex(null);
      setWorkingMessage(null);
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    if (project) setTriedLoad(true);
    else {
      projectsStore.loadProject(id).then(() => setTriedLoad(true));
    }
  }, [id, project]);

  useEffect(() => {
    if (!id || project?.status !== "running") return;
    const t = setInterval(() => projectsStore.loadProject(id), 10000);
    return () => clearInterval(t);
  }, [id, project?.status]);

  // Artefatos — carrega uma vez e atualiza quando projeto muda de status
  useEffect(() => {
    if (!id) return;
    apiGet<ArtifactsResponse>(`/api/projects/${id}/artifacts`).then(setArtifacts).catch(() => setArtifacts(null));
    apiGet<CodeFilesResponse>(`/api/projects/${id}/code-files`).then(setCodeFiles).catch(() => setCodeFiles(null));
    if (project?.status === "completed" || project?.status === "accepted") {
      apiGet<RunInfoResponse>(`/api/projects/${id}/run-info`).then(setRunInfo).catch(() => setRunInfo(null));
      apiGet<MetricsResponse>(`/api/projects/${id}/metrics`).then(setMetrics).catch(() => setMetrics(null));
    }
  }, [id, project?.status]);

  // Tasks — polling automático a cada 8s enquanto rodando
  useEffect(() => {
    if (!id || !project) return;
    const isActive = project.status === "running" || project.status === "completed" || project.status === "accepted";
    if (!isActive) return;

    const loadTasks = () =>
      apiGet<TaskItem[]>(`/api/projects/${id}/tasks`)
        .then((data) => setTasks(Array.isArray(data) ? data : []))
        .catch(() => {});

    loadTasks(); // imediato

    if (project.status !== "running") return;
    const interval = setInterval(loadTasks, 8000);
    return () => clearInterval(interval);
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

  const stepIndexFromStatus =
    project.status === "spec_submitted"
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
  const stepIndex =
    project.status === "running" && workingStepIndex !== null && workingStepIndex >= 0
      ? workingStepIndex
      : stepIndexFromStatus;

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

      {runPipelineError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setRunPipelineError(null)}>
          {runPipelineError}
        </Alert>
      )}

      <Box sx={{ mb: 2, display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center" }}>
        {project.status === STATUS_RUNNING && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ flexBasis: "100%", mb: 0.5 }}>
              O pipeline está em execução. Se o log abaixo não atualizar em 1–2 min, verifique os logs do runner:{" "}
              <Box component="code" sx={{ fontSize: "0.85em", bgcolor: "action.hover", px: 0.5, borderRadius: 0.5 }}>
                docker compose logs runner --tail=100
              </Box>
            </Typography>
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
                  const data = await apiPost<{ ok: boolean; message?: string; status?: string }>(`/api/projects/${id}/run`, {});
                  setRunPipelineSuccess(true);
                  if (data?.status === "running") projectsStore.setProjectStatus(id, "running");
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
                Reinicia o fluxo do zero (Spec → CTO → Engineer → PM → Dev/QA/DevOps).
              </Typography>
            )}
          </>
        )}
        {(project.status === "completed" || project.status === "running") && (
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
        {(project.status === "completed" || project.status === "running") && (
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

      {/* Banner pós-aceite / conclusão */}
      {(project.status === "accepted" || project.status === "completed") && runInfo?.runCommand && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          icon={<CheckCircle />}
          action={
            runInfo.appUrl ? (
              <Button
                size="small"
                color="success"
                endIcon={<OpenInNew />}
                href={runInfo.appUrl}
                target="_blank"
                rel="noopener noreferrer"
                component="a"
              >
                Abrir app
              </Button>
            ) : undefined
          }
        >
          <Typography variant="body2" fontWeight={500}>
            {project.status === "accepted" ? "Projeto aceito — pronto para executar!" : "Pipeline concluído — pronto para executar!"}
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75 }}>
            <Box
              component="code"
              sx={{ bgcolor: "action.hover", px: 1, py: 0.4, borderRadius: 0.5, fontSize: "0.8em", flexGrow: 1, wordBreak: "break-all" }}
            >
              {runInfo.runCommand}
            </Box>
            <Tooltip title="Copiar comando">
              <Button
                size="small"
                startIcon={<ContentCopy sx={{ fontSize: "0.9rem !important" }} />}
                onClick={() => {
                  navigator.clipboard.writeText(runInfo.runCommand!).then(() => setCopiedCmd(true));
                }}
                sx={{ minWidth: "auto", px: 1, flexShrink: 0 }}
              >
                Copiar
              </Button>
            </Tooltip>
          </Stack>
        </Alert>
      )}

      <Snackbar
        open={copiedCmd}
        autoHideDuration={2000}
        onClose={() => setCopiedCmd(false)}
        message="Comando copiado!"
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />

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
          {STEPS.map((label, idx) => (
            <Step key={label}>
              <StepLabel>
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  <span>{label}</span>
                  {workingStepIndex === idx && (
                    <CircularProgress size={16} color="primary" sx={{ flexShrink: 0 }} />
                  )}
                </Stack>
              </StepLabel>
            </Step>
          ))}
        </Stepper>
        {workingMessage && workingStepIndex !== null && (
          <Typography variant="body2" color="primary" sx={{ mt: 1.5, display: "flex", alignItems: "center", gap: 1 }}>
            <CircularProgress size={16} color="primary" />
            {workingMessage}
          </Typography>
        )}
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

      {/* ── Tabs: Diálogo | Tasks | Artefatos ── */}
      <MotionCard variant="outlined" sx={{ mt: 3 }} {...blockMotion}>
        {/* Live status do agente ativo */}
        {project.status === STATUS_RUNNING && workingMessage && (
          <Box sx={{ px: 2, pt: 1.5, pb: 0, display: "flex", alignItems: "center", gap: 1 }}>
            <CircularProgress size={14} color="primary" />
            <Typography variant="body2" color="primary" sx={{ fontWeight: 500 }}>
              {workingMessage}
            </Typography>
          </Box>
        )}

        {/* Barra de progresso de tasks */}
        {tasks && tasks.length > 0 && (
          <Box sx={{ px: 2, pt: workingMessage ? 0.75 : 1.5, pb: 0 }}>
            {(() => {
              const done = tasks.filter((t) => t.status === "DONE" || t.status === "QA_PASS").length;
              const pct = Math.round((done / tasks.length) * 100);
              return (
                <Stack direction="row" spacing={1} alignItems="center">
                  <LinearProgress
                    variant="determinate"
                    value={pct}
                    sx={{ flex: 1, height: 6, borderRadius: 3 }}
                    color={pct === 100 ? "success" : "primary"}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                    {done}/{tasks.length} tasks
                  </Typography>
                </Stack>
              );
            })()}
          </Box>
        )}

        <Tabs
          value={activeTab}
          onChange={(_e, v) => setActiveTab(v as number)}
          sx={{ px: 2, borderBottom: "1px solid", borderColor: "divider" }}
        >
          <Tab label="Diálogo da Equipe" />
          <Tab
            label={
              tasks && tasks.length > 0
                ? `Tasks (${tasks.filter((t) => t.status === "DONE" || t.status === "QA_PASS").length}/${tasks.length})`
                : "Tasks"
            }
          />
          <Tab
            label={
              artifacts?.docs && artifacts.docs.length > 0
                ? `Artefatos (${artifacts.docs.length})`
                : "Artefatos"
            }
          />
          <Tab
            label={
              codeFiles && codeFiles.totalFiles > 0
                ? `Código Gerado (${codeFiles.totalFiles})`
                : "Código Gerado"
            }
          />
        </Tabs>

        {/* Aba 0 — Diálogo */}
        {activeTab === 0 && (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              O que os agentes estão fazendo (atualização automática).
            </Typography>
            <ProjectDialogue
              projectId={id}
              pollIntervalMs={project.status === STATUS_RUNNING ? 5000 : 10000}
              onEntriesLoaded={handleDialogueEntriesLoaded}
            />
          </Box>
        )}

        {/* Aba 1 — Tasks */}
        {activeTab === 1 && (
          <Box sx={{ p: 2 }}>
            {project.status === STATUS_RUNNING && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
                Atualização automática a cada 8 segundos.
              </Typography>
            )}
            {!tasks || tasks.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {project.status === STATUS_RUNNING
                  ? "Aguardando início do Monitor Loop (CTO → Engineer → PM devem concluir primeiro)..."
                  : "Nenhuma task encontrada para este projeto."}
              </Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600, width: 120 }}>Task ID</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Descrição</TableCell>
                    <TableCell sx={{ fontWeight: 600, width: 130 }}>Status</TableCell>
                    <TableCell sx={{ fontWeight: 600, width: 100 }}>Módulo</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tasks.map((t) => {
                    const isDone = t.status === "DONE" || t.status === "QA_PASS";
                    const isActive = t.status === "IN_PROGRESS" || t.status === "WAITING_REVIEW";
                    const isBlocked = t.status === "BLOCKED" || t.status === "QA_FAIL";
                    return (
                      <TableRow
                        key={t.id}
                        sx={{
                          bgcolor: isActive ? "primary.50" : isDone ? "success.50" : "transparent",
                          "& td": { py: 0.75 },
                        }}
                      >
                        <TableCell>
                          <Typography variant="caption" fontFamily="monospace">
                            {t.taskId ?? t.id}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.75} alignItems="center">
                            {isActive && <CircularProgress size={12} color="primary" />}
                            <Typography variant="body2">
                              {t.requirements ?? "—"}
                            </Typography>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={t.status ?? "—"}
                            color={
                              isDone ? "success" :
                              isActive ? "info" :
                              isBlocked ? "error" : "default"
                            }
                            sx={{ fontFamily: "monospace", fontSize: "0.65rem" }}
                          />
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary">
                            {t.module ?? t.ownerRole ?? "—"}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Box>
        )}

        {/* Aba 2 — Artefatos */}
        {activeTab === 2 && (
          <Box sx={{ p: 2 }}>
            {!artifacts || (!artifacts.docs?.length && !artifacts.projectDocsRoot) ? (
              <Typography variant="body2" color="text.secondary">
                Nenhum artefato gerado ainda. Os documentos aparecerão aqui conforme os agentes trabalham.
              </Typography>
            ) : (
              <>
                {artifacts.projectDocsRoot && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
                    Raiz: <Box component="code" sx={{ bgcolor: "action.hover", px: 0.5, borderRadius: 0.5, fontSize: "0.8em" }}>{artifacts.projectDocsRoot}</Box>
                  </Typography>
                )}
                {artifacts.docs?.length > 0 ? (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 600 }}>Arquivo</TableCell>
                        <TableCell sx={{ fontWeight: 600, width: 110 }}>Criado por</TableCell>
                        <TableCell sx={{ fontWeight: 600, width: 140 }}>Data</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {artifacts.docs.map((d, i) => (
                        <TableRow key={i} sx={{ "& td": { py: 0.5 } }}>
                          <TableCell>
                            <Typography variant="body2">{d.title ?? d.filename}</Typography>
                            {d.title && d.filename !== d.title && (
                              <Typography variant="caption" color="text.secondary" fontFamily="monospace">
                                {d.filename}
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell>
                            <Chip size="small" label={d.creator ?? "—"} variant="outlined" sx={{ fontSize: "0.65rem" }} />
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" color="text.secondary">
                              {d.created_at ? new Date(d.created_at).toLocaleString("pt-BR") : "—"}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Manifest sem documentos listados. Os artefatos estão sendo gerados.
                  </Typography>
                )}
              </>
            )}
          </Box>
        )}
        {/* Aba 3 — Código Gerado */}
        {activeTab === 3 && (
          <Box sx={{ p: 2 }}>
            {!codeFiles || codeFiles.totalFiles === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nenhum arquivo de código gerado ainda. Os arquivos aparecerão aqui após o Dev concluir as tasks.
              </Typography>
            ) : (
              <>
                {codeFiles.appsRoot && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
                    Raiz:{" "}
                    <Box component="code" sx={{ bgcolor: "action.hover", px: 0.5, borderRadius: 0.5, fontSize: "0.8em" }}>
                      {codeFiles.appsRoot}
                    </Box>
                  </Typography>
                )}
                {(() => {
                  // Group by extension for summary
                  const byExt: Record<string, number> = {};
                  for (const f of codeFiles.files) {
                    const k = f.ext || "outros";
                    byExt[k] = (byExt[k] ?? 0) + 1;
                  }
                  return (
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
                      {Object.entries(byExt).map(([ext, count]) => (
                        <Chip key={ext} size="small" label={`.${ext} (${count})`} variant="outlined" />
                      ))}
                    </Stack>
                  );
                })()}
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 600 }}>Arquivo</TableCell>
                      <TableCell sx={{ fontWeight: 600, width: 90, textAlign: "right" }}>Tamanho</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {codeFiles.files.map((f, i) => (
                      <TableRow key={i} sx={{ "& td": { py: 0.4 } }}>
                        <TableCell>
                          <Typography variant="body2" fontFamily="monospace" sx={{ fontSize: "0.78rem" }}>
                            {f.path}
                          </Typography>
                        </TableCell>
                        <TableCell sx={{ textAlign: "right" }}>
                          <Typography variant="caption" color="text.secondary">
                            {f.sizeBytes >= 1024 ? `${(f.sizeBytes / 1024).toFixed(1)} KB` : `${f.sizeBytes} B`}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </Box>
        )}
      </MotionCard>

      {/* Métricas do projeto */}
      {(project.status === "completed" || project.status === "accepted") && (
        <MotionCard variant="outlined" sx={{ mt: 3, p: 2 }} {...blockMotion}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom fontWeight={600}>
            Métricas do Pipeline
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={3} flexWrap="wrap" useFlexGap>
            {tasks && tasks.length > 0 && (
              <Box>
                <Typography variant="caption" color="text.secondary">Tasks executadas</Typography>
                <Typography variant="h6" fontWeight={600}>
                  {tasks.filter((t) => t.status === "DONE" || t.status === "QA_PASS").length}/{tasks.length}
                </Typography>
              </Box>
            )}
            {codeFiles && codeFiles.totalFiles > 0 && (
              <Box>
                <Typography variant="caption" color="text.secondary">Arquivos gerados</Typography>
                <Typography variant="h6" fontWeight={600}>{codeFiles.totalFiles}</Typography>
              </Box>
            )}
            {duration && (
              <Box>
                <Typography variant="caption" color="text.secondary">Duração total</Typography>
                <Typography variant="h6" fontWeight={600}>{duration}</Typography>
              </Box>
            )}
            {metrics && metrics.totals.calls > 0 && (
              <>
                <Box>
                  <Typography variant="caption" color="text.secondary">Tokens totais</Typography>
                  <Typography variant="h6" fontWeight={600}>
                    {(metrics.totals.input_tokens + metrics.totals.output_tokens).toLocaleString("pt-BR")}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {metrics.totals.input_tokens.toLocaleString("pt-BR")} entrada · {metrics.totals.output_tokens.toLocaleString("pt-BR")} saída
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">Custo estimado</Typography>
                  <Typography variant="h6" fontWeight={600} color="success.main">
                    ~${metrics.totals.estimated_cost_usd.toFixed(2)} USD
                  </Typography>
                </Box>
              </>
            )}
          </Stack>
        </MotionCard>
      )}

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
