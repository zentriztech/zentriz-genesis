"use client";

// DecomposeDialog — RFC-0003 F1: o "Splitter" deixa de ser um MENU e vira uma AÇÃO VIVA
// dentro da Bancada. Dois modos, mesmo fluxo:
//   • spec  → decompõe uma SPEC já salva (POST /api/projects/:id/decompose) — carrega o
//             vínculo de origem (originProjectId) para o produto não nascer órfão (U#4).
//   • idea  → decompõe uma IDEIA colada (POST /api/products/propose {document}).
// Ambos fazem poll do job e, ao aprovar, chamam /ingest-proposal com **dispatch:false**
// (D1: aprovar = SALVAR rascunhos na Bancada, NUNCA disparar a fábrica). A promoção à
// fábrica é um passo humano separado (Promover à fábrica / Promover produto inteiro).

import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import { apiGet, apiPost } from "@/lib/api";

// contratos com a API (espelham products.ts / splitter)
type ProposeProject = {
  id: string; type: string; wave: number; dependsOn: string[];
  // R4 PR3 (Connect 1.3.0): racional do corte + arquivos gerados + connect.yaml
  rationale?: string | null; files?: string[]; connectDeclaration?: string | null;
};
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
  originProjectId?: string | null;
};

const POLL_MS = 8000;
const TIMEOUT_MS = 11 * 60_000; // 11min — mesmo teto do fluxo de spec
const MIN_DOC_CHARS = 40;

type Phase = "input" | "proposing" | "polling" | "review" | "saving";

export interface DecomposeSpecRef {
  id: string;
  title: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * @param spec  Quando presente, decompõe a SPEC salva (modo "spec"). Quando null/omisso,
 *              abre em modo "idea" (colar texto).
 * @param onSaved Chamado após salvar os rascunhos na Bancada (para recarregar a lista).
 */
export function DecomposeDialog({
  open,
  spec,
  onClose,
  onSaved,
}: {
  open: boolean;
  spec?: DecomposeSpecRef | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isSpecMode = !!spec;
  const [phase, setPhase] = useState<Phase>(isSpecMode ? "proposing" : "input");
  const [doc, setDoc] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [poll, setPoll] = useState<ProposePoll | null>(null);
  // originProjectId autoritativo vem do próprio job (poll.originProjectId); o spec.id é
  // apenas o gatilho. Guardamos o do poll para devolver no ingest.
  const originRef = useRef<string | null>(null);
  // Cancela qualquer polling em voo quando o diálogo fecha/desmonta (evita setState órfão
  // e poll fantasma sobre um job de uma abertura anterior).
  const runIdRef = useRef(0);

  const reset = useCallback(() => {
    setPhase(isSpecMode ? "proposing" : "input");
    setDoc("");
    setElapsed(0);
    setError(null);
    setPoll(null);
    originRef.current = null;
  }, [isSpecMode]);

  // Loop de poll compartilhado pelos dois modos.
  const pollUntilDone = useCallback(async (jobId: string, myRun: number) => {
    setPhase("polling");
    const startedAt = Date.now();
    while (Date.now() - startedAt < TIMEOUT_MS) {
      if (runIdRef.current !== myRun) return; // diálogo fechou/reabriu → aborta
      await sleep(POLL_MS);
      if (runIdRef.current !== myRun) return;
      let res: ProposePoll;
      try {
        res = await apiGet<ProposePoll>(`/api/products/propose/${jobId}`);
      } catch (e) {
        if (runIdRef.current !== myRun) return;
        setError(e instanceof Error ? e.message : "Falha ao consultar a decomposição");
        setPhase(isSpecMode ? "proposing" : "input");
        return;
      }
      if (runIdRef.current !== myRun) return;
      if (res.status === "done") {
        originRef.current = res.originProjectId ?? spec?.id ?? null;
        setPoll(res);
        setPhase("review");
        return;
      }
      if (res.status === "error") {
        setError(res.error || "A decomposição falhou.");
        setPhase(isSpecMode ? "proposing" : "input");
        return;
      }
      setElapsed(Math.round((Date.now() - startedAt) / 1000));
    }
    if (runIdRef.current === myRun) {
      setError("A decomposição excedeu o tempo limite. Tente novamente.");
      setPhase(isSpecMode ? "proposing" : "input");
    }
  }, [isSpecMode, spec?.id]);

  // Dispara a proposta (spec-origin ou ideia crua) e entra no poll.
  const startFlow = useCallback(async () => {
    const myRun = runIdRef.current;
    setError(null);
    setPhase("proposing");
    try {
      let jobId: string;
      if (isSpecMode && spec) {
        const res = await apiPost<{ jobId: string; originProjectId?: string }>(
          `/api/projects/${spec.id}/decompose`, {},
        );
        jobId = res.jobId;
        originRef.current = res.originProjectId ?? spec.id;
      } else {
        const document = doc.trim();
        if (document.length < MIN_DOC_CHARS) {
          setError(`Descreva a ideia com pelo menos ${MIN_DOC_CHARS} caracteres.`);
          setPhase("input");
          return;
        }
        const res = await apiPost<{ jobId: string }>("/api/products/propose", { document });
        jobId = res.jobId;
        originRef.current = null;
      }
      if (runIdRef.current !== myRun) return;
      await pollUntilDone(jobId, myRun);
    } catch (e) {
      if (runIdRef.current !== myRun) return;
      setError(e instanceof Error ? e.message : "Falha ao iniciar a decomposição");
      setPhase(isSpecMode ? "proposing" : "input");
    }
  }, [isSpecMode, spec, doc, pollUntilDone]);

  // Ao abrir: reseta e, no modo spec, dispara automaticamente. runIdRef++ invalida polls
  // de uma abertura anterior. Ao fechar, também incrementa (cancela polls em voo).
  useEffect(() => {
    runIdRef.current += 1;
    if (open) {
      reset();
      if (isSpecMode) {
        const myRun = runIdRef.current;
        // pequeno defer para o reset assentar antes de disparar
        void (async () => {
          if (runIdRef.current !== myRun) return;
          await startFlow();
        })();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = useCallback(async () => {
    if (!poll?.manifest || !poll?.specs) return;
    const myRun = runIdRef.current;
    setPhase("saving");
    setError(null);
    try {
      await apiPost("/api/products/ingest-proposal", {
        // T1.6b: proposalId (= jobId da linha persistida) faz o servidor usar o manifest/specs
        // AUTORITATIVOS que ele gravou — o body abaixo vira apenas fallback (compat).
        proposalId: poll.jobId,
        manifest: poll.manifest,
        specs: poll.specs,
        specApproved: true,
        dispatch: false, // D1: só SALVA na Bancada — nunca dispara a fábrica
        originProjectId: originRef.current ?? undefined,
      });
      if (runIdRef.current !== myRun) return;
      onSaved();
      onClose();
    } catch (e) {
      if (runIdRef.current !== myRun) return;
      setError(e instanceof Error ? e.message : "Falha ao salvar na Bancada");
      setPhase("review");
    }
  }, [poll, onSaved, onClose]);

  const busy = phase === "proposing" || phase === "polling" || phase === "saving";
  const projects = poll?.projects ?? [];
  const productName = poll?.manifest?.product?.name;
  const wavesCount = poll?.waves?.length ?? 0;
  const specsCount = poll?.specs ? Object.keys(poll.specs).length : 0;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: "1.05rem" }}>
        <CallSplitIcon sx={{ color: "#6366F1" }} />
        {isSpecMode ? (
          <>Decompor SPEC <b>{spec?.title}</b></>
        ) : (
          <>Decompor uma ideia em vários projetos</>
        )}
      </DialogTitle>

      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

        {/* Entrada (só modo ideia) */}
        {phase === "input" && !isSpecMode && (
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Descreva o produto em prosa. O Product Architect vai propor a divisão em
              projetos com o grafo de dependências. Nada é executado — os rascunhos ficam
              na Bancada para você revisar e promover quando quiser.
            </Typography>
            <TextField
              autoFocus fullWidth multiline minRows={8}
              placeholder="Ex.: Uma plataforma de agendamento com portal do cliente, painel do profissional, cobrança recorrente e notificações por e-mail/WhatsApp…"
              value={doc}
              onChange={(e) => setDoc(e.target.value)}
            />
            <Typography variant="caption" color={doc.trim().length < MIN_DOC_CHARS ? "error" : "text.secondary"}>
              {doc.trim().length}/{MIN_DOC_CHARS} caracteres mínimos
            </Typography>
          </Box>
        )}

        {/* Trabalhando */}
        {(phase === "proposing" || phase === "polling") && (
          <Box sx={{ py: 4, textAlign: "center" }}>
            <CircularProgress size={30} sx={{ mb: 2 }} />
            <Typography variant="body2" color="text.secondary">
              {phase === "proposing"
                ? "Enviando ao Product Architect…"
                : `Decompondo… (${elapsed}s) — isto pode levar alguns minutos.`}
            </Typography>
            <LinearProgress sx={{ mt: 2, borderRadius: 1 }} />
          </Box>
        )}

        {/* Revisão da proposta */}
        {phase === "review" && poll && (
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5, flexWrap: "wrap", gap: 1 }}>
              <CheckCircleIcon sx={{ color: "#10B981" }} fontSize="small" />
              <Typography variant="subtitle1" fontWeight={700}>
                {productName ?? "Produto proposto"}
              </Typography>
              <Chip size="small" label={`${projects.length} projeto(s)`} color="primary" variant="outlined" />
              <Chip size="small" label={`${wavesCount} onda(s)`} variant="outlined" />
              <Chip size="small" label={`${specsCount} spec(s)`} variant="outlined" />
            </Stack>

            {poll.warnings && poll.warnings.length > 0 && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                <Typography variant="caption" component="div" fontWeight={600}>Avisos da decomposição:</Typography>
                <ul style={{ margin: "4px 0 0 0", paddingLeft: 18 }}>
                  {poll.warnings.map((w, i) => <li key={i}><Typography variant="caption">{w}</Typography></li>)}
                </ul>
              </Alert>
            )}

            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
              Projetos por onda de execução (dependências resolvidas topologicamente):
            </Typography>
            <Stack spacing={0.75} sx={{ mb: 2 }}>
              {projects
                .slice()
                .sort((a, b) => a.wave - b.wave)
                .map((p) => (
                  <Box key={p.id} sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <Chip size="small" label={`onda ${p.wave}`} sx={{ height: 18, fontSize: "0.6rem" }} />
                    <Typography variant="body2" fontWeight={600}>{p.id}</Typography>
                    <Typography variant="caption" color="text.secondary">{p.type}</Typography>
                    {p.dependsOn.length > 0 && (
                      <Typography variant="caption" color="text.disabled">
                        ← depende de {p.dependsOn.join(", ")}
                      </Typography>
                    )}
                    {(p.files?.length ?? 0) > 0 && (
                      <Chip size="small" variant="outlined" label={`${p.files!.length} arquivo(s)${p.connectDeclaration ? " · connect.yaml" : ""}`} sx={{ height: 18, fontSize: "0.6rem" }} />
                    )}
                    {p.rationale && (
                      <Typography variant="caption" color="text.secondary" sx={{ flexBasis: "100%", pl: 1, borderLeft: "2px solid", borderColor: "divider" }}>
                        {p.rationale}
                      </Typography>
                    )}
                  </Box>
                ))}
            </Stack>

            {poll.specs && Object.keys(poll.specs).length > 0 && (
              <Accordion disableGutters sx={{ bgcolor: "transparent" }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="caption" fontWeight={600}>Ver specs geradas ({specsCount})</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={1}>
                    {Object.entries(poll.specs).map(([path, content]) => (
                      <Box key={path}>
                        <Typography variant="caption" fontWeight={700} sx={{ display: "block" }}>{path}</Typography>
                        <Box component="pre" sx={{
                          m: 0, p: 1, bgcolor: "action.hover", borderRadius: 1, fontSize: "0.7rem",
                          whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto",
                        }}>
                          {content.slice(0, 1200)}{content.length > 1200 ? "\n…" : ""}
                        </Box>
                      </Box>
                    ))}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            )}

            <Alert severity="info" sx={{ mt: 1 }}>
              Ao salvar, os projetos entram na Bancada como <b>rascunhos</b> — nada é executado.
              Você promove à fábrica quando quiser.
            </Alert>
          </Box>
        )}

        {phase === "saving" && (
          <Box sx={{ py: 4, textAlign: "center" }}>
            <CircularProgress size={30} sx={{ mb: 2 }} />
            <Typography variant="body2" color="text.secondary">Salvando rascunhos na Bancada…</Typography>
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {phase === "review" ? "Descartar" : "Cancelar"}
        </Button>
        {phase === "input" && !isSpecMode && (
          <Button variant="contained" onClick={startFlow} disabled={doc.trim().length < MIN_DOC_CHARS}>
            Decompor
          </Button>
        )}
        {phase === "review" && (
          <Button variant="contained" color="success" onClick={save}>
            Salvar rascunhos na Bancada
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
