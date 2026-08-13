"use client";

/**
 * DeadpoolMonitorCard — botão [Ativar Monitoramento Deadpool] na página do projeto (feature #1).
 *
 * Ativar dá ao Deadpool o vínculo runtime do projeto (appUrl/healthUrl/logGroup) + monitoring=true:
 * ele passa a MONITORAR logs ativamente (CloudWatch) e a receber chamados REATIVOS via API, atuando
 * em correções (commits/deploys) no repo GitHub do projeto.
 *
 * Só aparece para tenants COM licença Deadpool (tenant_entitlements). Toda a comunicação é
 * server-side via o gateway /api/deadpool/* — o browser nunca fala com o Deadpool direto.
 * Gate de UI: apenas admin (tenant_admin | zentriz_admin) e projeto aceito com repositório.
 */

import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import HealthAndSafetyIcon from "@mui/icons-material/HealthAndSafety";
import { apiGet, apiPost } from "@/lib/api";
import { authStore } from "@/stores/authStore";

type MonitoringState = {
  entitled: boolean;
  active: boolean;
  systemId: string | null;
  serviceId: string | null;
  activatedAt: string | null;
  deactivatedAt: string | null;
  lastRegisteredAt: string | null;
  lastError: string | null;
};

/** Mensagem amigável para os códigos de pré-condição do endpoint activate. */
function friendlyError(msg: string): string {
  if (/NO_DEADPOOL_ENTITLEMENT/.test(msg)) return "Este tenant não possui licença Deadpool.";
  if (/PROJECT_NOT_ACCEPTED/.test(msg)) return "O projeto precisa estar aceito antes de ativar o monitoramento.";
  if (/NO_REPOSITORY/.test(msg)) return "O projeto ainda não tem repositório GitHub publicado.";
  if (/NO_GITHUB_INSTALLATION/.test(msg)) return "O tenant precisa instalar o GitHub App da Zentriz.";
  if (/DEADPOOL_NOT_CONFIGURED/.test(msg)) return "Integração com o Deadpool não está configurada neste ambiente.";
  if (/DEADPOOL_REGISTER_FAILED/.test(msg)) return "Falha ao registrar o projeto no Deadpool. Tente novamente.";
  return msg;
}

export default function DeadpoolMonitorCard({ projectId }: { projectId: string }) {
  const [state, setState] = useState<MonitoringState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = authStore.isTenantAdmin; // inclui zentriz_admin

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet<MonitoringState>(`/api/deadpool/projects/${projectId}/monitoring`);
      setState(data);
    } catch {
      // Degrada limpo: sem estado, o card não renderiza (não polui a página do projeto).
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return; }
    void refresh();
  }, [isAdmin, refresh]);

  const toggle = useCallback(
    async (activate: boolean) => {
      setBusy(true);
      setError(null);
      try {
        await apiPost(`/api/deadpool/projects/${projectId}/${activate ? "activate" : "deactivate"}`, {});
        await refresh();
      } catch (e) {
        setError(friendlyError(e instanceof Error ? e.message : String(e)));
      } finally {
        setBusy(false);
      }
    },
    [projectId, refresh],
  );

  // Só admin, só se o tenant tem licença Deadpool. Enquanto carrega, nada.
  if (!isAdmin || loading) return null;
  if (!state || !state.entitled) return null;

  const active = state.active;

  return (
    <Alert
      severity={active ? "success" : "info"}
      icon={<HealthAndSafetyIcon />}
      sx={{ mb: 2 }}
      action={
        <Button
          size="small"
          variant={active ? "outlined" : "contained"}
          color={active ? "inherit" : "primary"}
          disabled={busy}
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <HealthAndSafetyIcon />}
          onClick={() => void toggle(!active)}
        >
          {busy
            ? "Processando..."
            : active
              ? "Desativar Monitoramento"
              : "Ativar Monitoramento Deadpool"}
        </Button>
      }
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="body2" fontWeight={600}>
          Monitoramento Deadpool
        </Typography>
        <Chip
          size="small"
          label={active ? "Ativo" : "Inativo"}
          color={active ? "success" : "default"}
          sx={{ height: 20, fontSize: "0.68rem" }}
        />
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div">
        {active
          ? "O Deadpool monitora os logs deste projeto (CloudWatch) e recebe chamados de erro em tempo real, atuando em correções no repositório."
          : "Ative para o Deadpool passar a monitorar os logs e receber chamados de erro deste projeto, atuando em correções no repositório."}
      </Typography>
      {state.lastError && !active && (
        <Typography variant="caption" color="error" component="div" sx={{ mt: 0.5 }}>
          Último erro de registro: {String(state.lastError).slice(0, 300)}
        </Typography>
      )}
      {error && (
        <Box sx={{ mt: 0.75 }}>
          <Typography variant="caption" color="error">{error}</Typography>
        </Box>
      )}
    </Alert>
  );
}
