"use client";

/**
 * DeadpoolPromotionApprovals — gate de APROVAÇÃO de promoção do Deadpool (RFC-028 / ADR-024 Fase C).
 *
 * Sob autonomia por ambiente (flag do Deadpool), `dev` libera merge+deploy sob gates verdes, mas
 * `staging`/`prod` exigem um REGISTRO DE APROVAÇÃO humano emitido por este portal. Este card lista os
 * pedidos do projeto, permite SOLICITAR uma promoção (decision=pending) e DECIDIR (approve/reject).
 * O guardrail R7/R9 do Deadpool é fail-closed: sem registro válido, a promoção fica bloqueada.
 *
 * RBAC (espelha o backend): ler/criar = tenant_admin | zentriz_admin; DECIDIR produção = só zentriz_admin.
 * Toda a comunicação é server-side via o gateway /api/deadpool/* (o browser nunca fala com o Deadpool).
 * Degrada limpo: se a listagem falhar (sem acesso/indisponível), o card não renderiza.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import GavelIcon from "@mui/icons-material/Gavel";
import { apiGet, apiPost } from "@/lib/api";
import { authStore } from "@/stores/authStore";

/** Ambientes que aceitam pedido de promoção (espelha _APPROVAL_REQUIRED do Deadpool). */
const ENV_OPTIONS = ["staging", "homolog", "prod"] as const;
/** Ambientes de produção — decidir exige zentriz_admin (backend também enforça). */
const PROD_ENVIRONMENTS = new Set(["prod", "production"]);
/** Ações que um registro pode autorizar. 'promote' cobre merge+deploy. */
const ACTION_OPTIONS = ["promote", "merge", "deploy"] as const;

type Approval = {
  id: string;
  projectId: string;
  incidentId: string | null;
  repoUrl: string | null;
  targetEnvironment: string;
  actions: string[];
  decision: string;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedByRole: string | null;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Mensagem amigável para os códigos de pré-condição dos endpoints de approval. */
function friendlyError(msg: string): string {
  if (/NO_DEADPOOL_ENTITLEMENT/.test(msg)) return "Este tenant não possui licença Auto Care.";
  if (/INVALID_TARGET_ENVIRONMENT/.test(msg)) return "Ambiente-alvo inválido (use staging/homolog/prod).";
  if (/INVALID_EXPIRES_AT/.test(msg)) return "Data de expiração inválida.";
  if (/PROD_REQUIRES_ZENTRIZ_ADMIN/.test(msg)) return "Decidir promoções de produção exige um zentriz_admin.";
  if (/ALREADY_DECIDED/.test(msg)) return "Este pedido já foi decidido por outra pessoa.";
  if (/PROJECT_NOT_FOUND/.test(msg)) return "Projeto não encontrado.";
  if (/FORBIDDEN/.test(msg)) return "Você não tem permissão para esta ação.";
  return msg;
}

function decisionChip(decision: string) {
  const map: Record<string, { label: string; color: "success" | "error" | "warning" | "default" }> = {
    approved: { label: "Aprovada", color: "success" },
    rejected: { label: "Rejeitada", color: "error" },
    pending: { label: "Pendente", color: "warning" },
  };
  const it = map[decision] ?? { label: decision, color: "default" as const };
  return <Chip size="small" label={it.label} color={it.color} sx={{ height: 20, fontSize: "0.68rem" }} />;
}

function DeadpoolPromotionApprovals({ projectId }: { projectId: string }) {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Diálogo de solicitação.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [targetEnvironment, setTargetEnvironment] = useState<string>("staging");
  const [action, setAction] = useState<string>("promote");
  const [incidentId, setIncidentId] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const isAdmin = authStore.isTenantAdmin; // inclui zentriz_admin
  const isZentrizAdmin = authStore.isZentrizAdmin;

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet<{ approvals: Approval[] }>(`/api/deadpool/projects/${projectId}/approvals`);
      setApprovals(data.approvals ?? []);
      setAvailable(true);
    } catch {
      // Degrada limpo: sem acesso/indisponível, o card não renderiza.
      setApprovals(null);
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return; }
    void refresh();
  }, [isAdmin, refresh]);

  const submitRequest = useCallback(async () => {
    setCreating(true);
    setFormError(null);
    try {
      // `datetime-local` produz uma string SEM offset ("2026-08-20T20:00"). `new Date(v)` a interpreta
      // no fuso do BROWSER (a intenção do operador); `.toISOString()` converte para UTC correto —
      // evita o servidor reinterpretá-la no fuso dele e ESTENDER a janela (achado adversarial MEDIUM-1).
      let expiresAtIso: string | undefined;
      const raw = expiresAt.trim();
      if (raw) {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) expiresAtIso = d.toISOString();
      }
      await apiPost(`/api/deadpool/projects/${projectId}/approvals`, {
        targetEnvironment,
        actions: [action],
        incidentId: incidentId.trim() || undefined,
        repoUrl: repoUrl.trim() || undefined,
        expiresAt: expiresAtIso,
      });
      setDialogOpen(false);
      setIncidentId("");
      setRepoUrl("");
      setExpiresAt("");
      await refresh();
    } catch (e) {
      setFormError(friendlyError(e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  }, [projectId, targetEnvironment, action, incidentId, repoUrl, expiresAt, refresh]);

  const decide = useCallback(
    async (approvalId: string, decision: "approved" | "rejected") => {
      setBusyId(approvalId);
      setError(null);
      try {
        await apiPost(`/api/deadpool/approvals/${approvalId}/decide`, { decision });
        await refresh();
      } catch (e) {
        setError(friendlyError(e instanceof Error ? e.message : String(e)));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  // Só admin. Enquanto carrega, nada. Se o gateway degradou, não renderiza.
  if (!isAdmin || loading) return null;
  if (!available || approvals === null) return null;

  return (
    <Box sx={{ mb: 2 }}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
          <GavelIcon fontSize="small" sx={{ color: "#EF4444" }} />
          <Typography variant="body2" fontWeight={700} sx={{ flexGrow: 1 }}>
            Aprovações de promoção (Auto Care)
          </Typography>
          <Button
            size="small"
            variant="contained"
            startIcon={<GavelIcon />}
            onClick={() => { setFormError(null); setDialogOpen(true); }}
          >
            Solicitar promoção
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1.5 }}>
          Sob autonomia por ambiente, o Auto Care corrige e promove em <strong>dev</strong> sozinho; promoções
          para <strong>staging</strong>/<strong>prod</strong> exigem uma aprovação humana registrada aqui
          (produção só por zentriz_admin). Sem registro válido, a promoção fica bloqueada (fail-closed).
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}

        {approvals.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            Nenhum pedido de promoção registrado para este projeto.
          </Typography>
        ) : (
          <TableContainer component={Paper} variant="outlined" sx={{ overflowX: "auto" }}>
            <Table size="small" sx={{ minWidth: 640 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Ambiente</TableCell>
                  <TableCell>Ações</TableCell>
                  <TableCell>Estado</TableCell>
                  <TableCell>Incidente</TableCell>
                  <TableCell>Expira</TableCell>
                  <TableCell align="right">Decisão</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {approvals.map((a) => {
                  const isProd = PROD_ENVIRONMENTS.has(a.targetEnvironment);
                  const canDecide = a.decision === "pending" && (!isProd || isZentrizAdmin);
                  return (
                    <TableRow key={a.id} hover>
                      <TableCell>{a.targetEnvironment}</TableCell>
                      <TableCell>{a.actions.join(", ")}</TableCell>
                      <TableCell>{decisionChip(a.decision)}</TableCell>
                      <TableCell>{a.incidentId ?? "—"}</TableCell>
                      <TableCell>
                        {a.expiresAt ? new Date(a.expiresAt).toLocaleString("pt-BR") : "—"}
                      </TableCell>
                      <TableCell align="right">
                        {a.decision === "pending" ? (
                          canDecide ? (
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button
                                size="small"
                                variant="contained"
                                color="success"
                                disabled={busyId === a.id}
                                startIcon={busyId === a.id ? <CircularProgress size={14} color="inherit" /> : undefined}
                                onClick={() => void decide(a.id, "approved")}
                              >
                                Aprovar
                              </Button>
                              <Button
                                size="small"
                                variant="outlined"
                                color="error"
                                disabled={busyId === a.id}
                                onClick={() => void decide(a.id, "rejected")}
                              >
                                Rejeitar
                              </Button>
                            </Stack>
                          ) : (
                            <Typography variant="caption" color="text.secondary">
                              Requer zentriz_admin
                            </Typography>
                          )
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            {a.decidedByRole ?? "—"}
                          </Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Solicitar promoção</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
          {formError && <Alert severity="error">{formError}</Alert>}
          <Box>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
              Ambiente-alvo
            </Typography>
            <Select value={targetEnvironment} onChange={(e) => setTargetEnvironment(e.target.value)} fullWidth size="small">
              {ENV_OPTIONS.map((env) => (
                <MenuItem key={env} value={env}>{env}</MenuItem>
              ))}
            </Select>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
              Ação autorizada
            </Typography>
            <Select value={action} onChange={(e) => setAction(e.target.value)} fullWidth size="small">
              {ACTION_OPTIONS.map((act) => (
                <MenuItem key={act} value={act}>{act}</MenuItem>
              ))}
            </Select>
          </Box>
          <TextField
            label="Incidente (opcional)"
            helperText="Vincula a aprovação a um incidente específico (anti-replay)."
            value={incidentId}
            onChange={(e) => setIncidentId(e.target.value)}
            size="small"
            fullWidth
          />
          <TextField
            label="Repositório (opcional)"
            helperText="Vincula a aprovação a um repositório (repo_url)."
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            size="small"
            fullWidth
          />
          <TextField
            label="Expira em (opcional)"
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            size="small"
            fullWidth
            InputLabelProps={{ shrink: true }}
          />
          {!incidentId.trim() && !repoUrl.trim() && (
            <Alert severity="warning" sx={{ py: 0.5 }}>
              Sem incidente/repositório, esta aprovação é um <strong>consentimento amplo</strong> —
              vale para qualquer promoção deste projeto ao ambiente escolhido. Sem data de expiração,
              o portal aplica um teto de 7 dias.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={creating}>Cancelar</Button>
          <Button
            variant="contained"
            disabled={creating}
            startIcon={creating ? <CircularProgress size={18} color="inherit" /> : undefined}
            onClick={() => void submitRequest()}
          >
            Solicitar
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default observer(DeadpoolPromotionApprovals);
