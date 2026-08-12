"use client";

// ── Splitter (D-1b) — doc → N projetos + grafo de dependências ─────────────────
// Cola/anexa UM documento em prosa → chama POST /api/products/propose (Product
// Architect em modo SPLITTER), faz poll do job, e mostra a PROPOSTA: manifest,
// grafo de dependências (React Flow), ondas e specs geradas. O humano REVISA e só
// então aprova → POST /api/products/ingest-proposal (guardrail ADR-018/Cenário A:
// o splitter PROPÕE, nunca executa — needs_human sempre true).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Container from "@mui/material/Container";
import Alert from "@mui/material/Alert";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Position,
  MarkerType,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { apiPost, apiGet } from "@/lib/api";

// ── contratos com a API (espelham products.ts) ────────────────────────────────
type ProposeProject = { id: string; type: string; wave: number; dependsOn: string[] };
type ProductManifest = {
  schemaVersion?: string;
  product?: { name?: string; systemId?: string; specApproved?: boolean; deliveryDefault?: string };
  projects?: Array<{ id: string; spec: string; type: string; dependsOn?: string[] }>;
};
type ProposePoll = {
  jobId: string;
  status: "pending" | "running" | "done" | "error";
  needsHuman?: boolean;
  manifest?: ProductManifest;
  specs?: Record<string, string>;
  waves?: string[][];
  projects?: ProposeProject[];
  warnings?: string[];
  error?: string;
  elapsed?: number;
};

const POLL_MS = 8000;
const TIMEOUT_MS = 11 * 60_000; // 11min — mesmo teto do fluxo de spec
const MIN_DOC_CHARS = 40;

// Paleta consistente com components/graph/* (tema escuro do genesis-web).
const BG = "#0D0F14";
const BORDER = "#30363D";
const ACCENT = "#6366F1";
const WAVE_COLORS = ["#6366F1", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#A855F7"];

// Layout em camadas: x pela onda (wave), y pela posição dentro da onda.
function buildProposalGraph(projects: ProposeProject[]): { nodes: Node[]; edges: Edge[] } {
  const COL_W = 240;
  const ROW_H = 96;
  // posição vertical de cada projeto = quantos já vieram na mesma onda (sem iterar Map).
  const rowByWave: Record<number, number> = {};
  const nodes: Node[] = projects.map((p) => {
    const row = rowByWave[p.wave] ?? 0;
    rowByWave[p.wave] = row + 1;
    const color = WAVE_COLORS[p.wave % WAVE_COLORS.length];
    return {
      id: p.id,
      position: { x: p.wave * COL_W, y: row * ROW_H },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: (
          <Box sx={{ px: 0.5 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 700, color: "#E6EDF3", lineHeight: 1.2 }}>
              {p.id}
            </Typography>
            <Typography sx={{ fontSize: 10.5, color: "#8B949E", mt: 0.25 }}>{p.type}</Typography>
            <Typography sx={{ fontSize: 9.5, color, mt: 0.25, fontWeight: 600 }}>
              onda {p.wave}
            </Typography>
          </Box>
        ),
      },
      style: {
        background: "#161B22",
        border: `1.5px solid ${color}`,
        borderRadius: 10,
        padding: 8,
        width: 170,
      },
    };
  });
  const edges: Edge[] = [];
  for (const p of projects) {
    for (const dep of p.dependsOn ?? []) {
      edges.push({
        id: `${dep}->${p.id}`,
        source: dep,
        target: p.id,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#6E7681" },
        style: { stroke: "#6E7681", strokeWidth: 1.5 },
      });
    }
  }
  return { nodes, edges };
}

export default function SplitterPage() {
  const router = useRouter();
  const [tab, setTab] = useState(0);
  const [document, setDocument] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);

  const [phase, setPhase] = useState<"idle" | "submitting" | "running" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposePoll | null>(null);

  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approvedProductId, setApprovedProductId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const running = phase === "submitting" || phase === "running";
  const canSubmit = document.trim().length >= MIN_DOC_CHARS && !running;

  const handleFile = useCallback(async (file: File) => {
    const text = await file.text();
    setDocument(text);
    setFileName(file.name);
  }, []);

  const handlePropose = useCallback(async () => {
    setError(null);
    setProposal(null);
    setApprovedProductId(null);
    setApproveError(null);
    setPhase("submitting");
    try {
      const res = await apiPost<{ jobId: string }>("/api/products/propose", {
        document: document.trim(),
      });
      const jobId = res.jobId;
      setPhase("running");
      const startTs = Date.now();
      stopPolling();
      pollRef.current = setInterval(async () => {
        if (Date.now() - startTs > TIMEOUT_MS) {
          stopPolling();
          setPhase("error");
          setError("Tempo esgotado aguardando a proposta do Product Architect.");
          return;
        }
        try {
          const poll = await apiGet<ProposePoll>(`/api/products/propose/${jobId}`);
          if (poll.status === "done") {
            stopPolling();
            setProposal(poll);
            setPhase("done");
          } else if (poll.status === "error") {
            stopPolling();
            setPhase("error");
            setError(poll.error ?? "A proposta falhou nos gates determinísticos.");
          }
          // pending/running → continua o poll
        } catch (e) {
          // erro transitório de rede não aborta o poll; erro persistente estoura no timeout
          console.warn("[Splitter] erro no poll:", e);
        }
      }, POLL_MS);
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Falha ao enviar o documento.");
    }
  }, [document, stopPolling]);

  const handleApprove = useCallback(async () => {
    if (!proposal?.manifest || !proposal.specs) return;
    setApproving(true);
    setApproveError(null);
    try {
      const res = await apiPost<{ productId: string }>("/api/products/ingest-proposal", {
        manifest: proposal.manifest,
        specs: proposal.specs,
        specApproved: true,
      });
      setApprovedProductId(res.productId);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Falha ao aprovar a proposta.");
    } finally {
      setApproving(false);
    }
  }, [proposal]);

  const graph = useMemo(
    () => (proposal?.projects ? buildProposalGraph(proposal.projects) : { nodes: [], edges: [] }),
    [proposal?.projects],
  );

  const specEntries = useMemo(
    () => (proposal?.specs ? Object.entries(proposal.specs) : []),
    [proposal?.specs],
  );

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
        <CallSplitIcon sx={{ color: ACCENT }} />
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          Splitter
        </Typography>
      </Stack>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Cole (ou anexe) UM documento descrevendo o produto por inteiro. O Product Architect
        decompõe em N projetos interdependentes, gera a spec de cada um e o grafo de
        dependências. <strong>É só uma proposta</strong> — você revisa e aprova antes de criar
        qualquer coisa.
      </Typography>

      {/* ── Entrada do documento ──────────────────────────────────────────── */}
      <Card variant="outlined" sx={{ mb: 3 }}>
        <CardContent>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
            <Tab label="Colar texto" />
            <Tab label="Anexar arquivo" icon={<UploadFileIcon fontSize="small" />} iconPosition="start" />
          </Tabs>

          {tab === 0 ? (
            <TextField
              multiline
              minRows={10}
              maxRows={22}
              fullWidth
              placeholder="# Meu produto&#10;&#10;Descreva sistemas, módulos, integrações e jornadas em prosa..."
              value={document}
              onChange={(e) => setDocument(e.target.value)}
              disabled={running}
            />
          ) : (
            <Box
              sx={{
                border: `1.5px dashed ${BORDER}`,
                borderRadius: 2,
                p: 4,
                textAlign: "center",
              }}
            >
              <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} disabled={running}>
                Escolher arquivo (.md / .txt)
                <input
                  hidden
                  type="file"
                  accept=".md,.markdown,.txt,text/plain,text/markdown"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                  }}
                />
              </Button>
              {fileName && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                  {fileName} — {document.length.toLocaleString("pt-BR")} caracteres carregados
                </Typography>
              )}
            </Box>
          )}

          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }}>
            <Button
              variant="contained"
              startIcon={running ? <CircularProgress size={18} color="inherit" /> : <CallSplitIcon />}
              onClick={handlePropose}
              disabled={!canSubmit}
            >
              {running ? "Analisando..." : "Propor decomposição"}
            </Button>
            <Typography variant="caption" color="text.secondary">
              {document.trim().length < MIN_DOC_CHARS
                ? `Mínimo ${MIN_DOC_CHARS} caracteres (${document.trim().length}).`
                : `${document.trim().length.toLocaleString("pt-BR")} caracteres.`}
            </Typography>
          </Stack>

          {running && (
            <Box sx={{ mt: 2 }}>
              <LinearProgress />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
                {phase === "submitting"
                  ? "Enviando documento ao Product Architect..."
                  : "Decompondo produto e gerando specs (pode levar alguns minutos)..."}
              </Typography>
            </Box>
          )}
        </CardContent>
      </Card>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* ── Proposta ──────────────────────────────────────────────────────── */}
      {proposal?.status === "done" && proposal.manifest && (
        <Stack spacing={3}>
          <Alert severity="info" icon={false}>
            <Typography sx={{ fontWeight: 700 }}>
              Proposta gerada — {proposal.manifest.product?.name ?? "produto"} ·{" "}
              {proposal.projects?.length ?? 0} projetos · {proposal.waves?.length ?? 0} ondas
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              Nada foi criado ainda. Revise o grafo, as ondas e as specs abaixo. Ao aprovar, o
              produto é criado e a <strong>onda 0</strong> é disparada para a fábrica.
            </Typography>
          </Alert>

          {(proposal.warnings?.length ?? 0) > 0 && (
            <Alert severity="warning">
              <Stack spacing={0.5}>
                {proposal.warnings!.map((w, i) => (
                  <Typography key={i} variant="body2">
                    {w}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}

          {/* Grafo de dependências */}
          <Card variant="outlined">
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1.5, fontWeight: 700 }}>
                Grafo de dependências
              </Typography>
              <Box sx={{ height: 440, borderRadius: 2, overflow: "hidden", border: `1px solid ${BORDER}`, background: BG }}>
                <ReactFlow nodes={graph.nodes} edges={graph.edges} fitView proOptions={{ hideAttribution: true }}>
                  <Background color="#21262D" gap={20} />
                  <Controls showInteractive={false} />
                  <MiniMap pannable zoomable style={{ background: "#161B22" }} />
                </ReactFlow>
              </Box>
            </CardContent>
          </Card>

          {/* Ondas */}
          <Card variant="outlined">
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1.5, fontWeight: 700 }}>
                Ondas de execução
              </Typography>
              <Stack spacing={1.5}>
                {(proposal.waves ?? []).map((wave, wi) => {
                  const color = WAVE_COLORS[wi % WAVE_COLORS.length];
                  return (
                    <Box
                      key={wi}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1.5,
                        p: 1.5,
                        borderRadius: 2,
                        border: `1px solid ${BORDER}`,
                        borderLeft: `4px solid ${color}`,
                      }}
                    >
                      <Chip label={`Onda ${wi}`} size="small" sx={{ bgcolor: color, color: "#fff", fontWeight: 700 }} />
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        {wave.map((id) => {
                          const proj = proposal.projects?.find((p) => p.id === id);
                          return (
                            <Chip
                              key={id}
                              label={`${id}${proj ? ` · ${proj.type}` : ""}`}
                              size="small"
                              variant="outlined"
                            />
                          );
                        })}
                      </Stack>
                    </Box>
                  );
                })}
              </Stack>
            </CardContent>
          </Card>

          {/* Specs geradas */}
          <Card variant="outlined">
            <CardContent>
              <Typography variant="h6" sx={{ mb: 1.5, fontWeight: 700 }}>
                Specs geradas ({specEntries.length})
              </Typography>
              {specEntries.map(([path, content]) => (
                <Accordion key={path} disableGutters>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography sx={{ fontFamily: "monospace", fontSize: 13 }}>{path}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5, alignSelf: "center" }}>
                      {content.length.toLocaleString("pt-BR")} caracteres
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        p: 2,
                        borderRadius: 1,
                        bgcolor: "action.hover",
                        fontSize: 12.5,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 400,
                        overflow: "auto",
                      }}
                    >
                      {content}
                    </Box>
                  </AccordionDetails>
                </Accordion>
              ))}
            </CardContent>
          </Card>

          {/* Aprovação */}
          {approvedProductId ? (
            <Alert
              severity="success"
              icon={<CheckCircleIcon />}
              action={
                <Button color="inherit" size="small" onClick={() => router.push("/projects")}>
                  Ver projetos
                </Button>
              }
            >
              Proposta aprovada e ingerida. Produto criado ({approvedProductId}) e onda 0 disparada
              para a fábrica.
            </Alert>
          ) : (
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>
                  Aprovar e criar
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  Ao aprovar, o produto e os {proposal.projects?.length ?? 0} projetos são criados a
                  partir desta proposta e a onda 0 (contracts/libs) é enviada à fábrica. As specs
                  ainda passam pelo CTO/pipeline normalmente.
                </Typography>
                {approveError && (
                  <Alert severity="error" sx={{ mb: 2 }} onClose={() => setApproveError(null)}>
                    {approveError}
                  </Alert>
                )}
                <Button
                  variant="contained"
                  color="success"
                  startIcon={approving ? <CircularProgress size={18} color="inherit" /> : <CheckCircleIcon />}
                  onClick={handleApprove}
                  disabled={approving}
                >
                  {approving ? "Criando..." : "Aprovar proposta e criar produto"}
                </Button>
              </CardContent>
            </Card>
          )}
        </Stack>
      )}
    </Container>
  );
}
