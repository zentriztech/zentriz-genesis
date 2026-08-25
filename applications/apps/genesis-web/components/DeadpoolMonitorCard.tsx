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
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import HealthAndSafetyIcon from "@mui/icons-material/HealthAndSafety";
import { apiGet, apiPost } from "@/lib/api";
import { authStore } from "@/stores/authStore";

type MonitorProvider = "cloudwatch" | "azure" | "gcp";

type MonitoringState = {
  entitled: boolean;
  active: boolean;
  systemId: string | null;
  serviceId: string | null;
  activatedAt: string | null;
  deactivatedAt: string | null;
  lastRegisteredAt: string | null;
  lastError: string | null;
  // Multi-cloud (M1/M2): nuvem monitorada + ponteiros (null = CloudWatch/nunca ativado).
  monitorProvider: MonitorProvider | null;
  azureWorkspaceId: string | null;
  azureTable: string | null;
  azureMessageColumn: string | null;
  gcpProjectId: string | null;
  gcpLogFilter: string | null;
};

const PROVIDER_LABELS: Record<MonitorProvider, string> = {
  cloudwatch: "AWS CloudWatch",
  azure: "Azure Monitor (Log Analytics)",
  gcp: "GCP Cloud Logging",
};

/** Mensagem amigável para os códigos de pré-condição do endpoint activate. */
function friendlyError(msg: string): string {
  if (/NO_DEADPOOL_ENTITLEMENT/.test(msg)) return "Este tenant não possui licença Auto Care.";
  if (/PROJECT_NOT_ACCEPTED/.test(msg)) return "O projeto precisa estar aceito antes de ativar o monitoramento.";
  if (/NO_REPOSITORY/.test(msg)) return "O projeto ainda não tem repositório GitHub publicado.";
  if (/NO_GITHUB_INSTALLATION/.test(msg)) return "O tenant precisa instalar o GitHub App da Zentriz.";
  if (/DEADPOOL_NOT_CONFIGURED/.test(msg)) return "Integração com o Auto Care não está configurada neste ambiente.";
  if (/DEADPOOL_REGISTER_FAILED/.test(msg)) return "Falha ao registrar o projeto no Auto Care. Tente novamente.";
  if (/AZURE_TABLE_REQUIRED/.test(msg)) return "Para Azure, informe a tabela do Log Analytics (ex.: AppTraces).";
  if (/GCP_LOG_FILTER_REQUIRED/.test(msg)) return "Para GCP, informe o filtro de logs do Cloud Logging.";
  if (/UNKNOWN_MONITOR_PROVIDER/.test(msg)) return "Nuvem de monitoramento inválida.";
  return msg;
}

export default function DeadpoolMonitorCard({
  projectId,
  onState,
  readOnly = false,
}: {
  projectId: string;
  /** Reporta ao pai o estado (entitled/active) após cada refresh — usado pela barra de entrega
   *  para decidir se mostra o botão "Monitorar" e refletir se está ativo. null = indisponível. */
  onState?: (s: { entitled: boolean; active: boolean } | null) => void;
  /** Conta Master de Gestão (zentriz_admin) atuando dentro de um tenant: só visualiza — o
   *  botão Ativar/Desativar some e o toggle é bloqueado. O estado segue sendo reportado ao pai. */
  readOnly?: boolean;
}) {
  const [state, setState] = useState<MonitoringState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Config multi-cloud escolhida ANTES de ativar (default = CloudWatch, sem campos → comportamento #1).
  const [provider, setProvider] = useState<MonitorProvider>("cloudwatch");
  const [azureWorkspaceId, setAzureWorkspaceId] = useState("");
  const [azureTable, setAzureTable] = useState("");
  const [azureMessageColumn, setAzureMessageColumn] = useState("");
  const [gcpProjectId, setGcpProjectId] = useState("");
  const [gcpLogFilter, setGcpLogFilter] = useState("");

  const isAdmin = authStore.isTenantAdmin; // inclui zentriz_admin

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet<MonitoringState>(`/api/deadpool/projects/${projectId}/monitoring`);
      setState(data);
      onState?.({ entitled: data.entitled, active: data.active });
    } catch {
      // Degrada limpo: sem estado, o card não renderiza (não polui a página do projeto).
      setState(null);
      onState?.(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, onState]);

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return; }
    void refresh();
  }, [isAdmin, refresh]);

  const toggle = useCallback(
    async (activate: boolean) => {
      if (readOnly) return;
      setBusy(true);
      setError(null);
      try {
        // Ao ativar, envia a nuvem escolhida + ponteiros. Ao desativar, corpo vazio.
        const body: Record<string, unknown> = {};
        if (activate) {
          body.monitorProvider = provider;
          if (provider === "azure") {
            body.azureWorkspaceId = azureWorkspaceId.trim() || null;
            body.azureTable = azureTable.trim() || null;
            body.azureMessageColumn = azureMessageColumn.trim() || null;
          } else if (provider === "gcp") {
            body.gcpProjectId = gcpProjectId.trim() || null;
            body.gcpLogFilter = gcpLogFilter.trim() || null;
          }
        }
        await apiPost(`/api/deadpool/projects/${projectId}/${activate ? "activate" : "deactivate"}`, body);
        await refresh();
      } catch (e) {
        setError(friendlyError(e instanceof Error ? e.message : String(e)));
      } finally {
        setBusy(false);
      }
    },
    [readOnly, projectId, refresh, provider, azureWorkspaceId, azureTable, azureMessageColumn, gcpProjectId, gcpLogFilter],
  );

  // Só admin, só se o tenant tem licença Deadpool. Enquanto carrega, nada.
  if (!isAdmin || loading) return null;
  if (!state || !state.entitled) return null;

  const active = state.active;
  // Client-side guard: Azure exige tabela, GCP exige filtro (o servidor também valida com 400).
  const canActivate =
    provider === "cloudwatch" ||
    (provider === "azure" && azureTable.trim().length > 0) ||
    (provider === "gcp" && gcpLogFilter.trim().length > 0);

  return (
    <Alert
      severity={active ? "success" : "info"}
      icon={<HealthAndSafetyIcon />}
      sx={{ mb: 2 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="body2" fontWeight={600}>
          Monitoramento Auto Care
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
          ? `O Auto Care monitora os logs deste projeto (${PROVIDER_LABELS[state.monitorProvider ?? "cloudwatch"]}) e recebe chamados de erro em tempo real, atuando em correções no repositório.`
          : "Escolha a nuvem onde o app está deployado e ative — o Auto Care passa a monitorar os logs e a receber chamados de erro, atuando em correções no repositório."}
      </Typography>
      {/* Seletor de nuvem + ponteiros de escopo (só ao ATIVAR). CloudWatch não pede campos: o
          log group vem do deployment. Azure/GCP precisam do escopo de logs para o poll ativo. */}
      {!active && !readOnly && (
        <Box sx={{ mt: 1.25 }}>
          <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 260 }, width: { xs: "100%", sm: "auto" } }}>
            <InputLabel id="deadpool-provider-label">Nuvem monitorada</InputLabel>
            <Select
              labelId="deadpool-provider-label"
              label="Nuvem monitorada"
              value={provider}
              onChange={(e) => setProvider(e.target.value as MonitorProvider)}
              disabled={busy}
            >
              <MenuItem value="cloudwatch">{PROVIDER_LABELS.cloudwatch}</MenuItem>
              <MenuItem value="azure">{PROVIDER_LABELS.azure}</MenuItem>
              <MenuItem value="gcp">{PROVIDER_LABELS.gcp}</MenuItem>
            </Select>
          </FormControl>
          {provider === "azure" && (
            <Stack spacing={1} sx={{ mt: 1 }}>
              <TextField
                fullWidth
                size="small" label="Tabela do Log Analytics (obrigatório)" placeholder="AppTraces"
                value={azureTable} onChange={(e) => setAzureTable(e.target.value)} disabled={busy} required
              />
              <TextField
                fullWidth
                size="small" label="Workspace ID (opcional)"
                value={azureWorkspaceId} onChange={(e) => setAzureWorkspaceId(e.target.value)} disabled={busy}
              />
              <TextField
                fullWidth
                size="small" label="Coluna da mensagem (opcional)" placeholder="Message"
                value={azureMessageColumn} onChange={(e) => setAzureMessageColumn(e.target.value)} disabled={busy}
              />
            </Stack>
          )}
          {provider === "gcp" && (
            <Stack spacing={1} sx={{ mt: 1 }}>
              <TextField
                fullWidth
                size="small" label="Filtro de logs (obrigatório)"
                placeholder='resource.type="cloud_run_revision"'
                value={gcpLogFilter} onChange={(e) => setGcpLogFilter(e.target.value)} disabled={busy} required
              />
              <TextField
                fullWidth
                size="small" label="Project ID (opcional)"
                value={gcpProjectId} onChange={(e) => setGcpProjectId(e.target.value)} disabled={busy}
              />
            </Stack>
          )}
        </Box>
      )}
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
      {readOnly ? (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1, fontStyle: "italic" }}>
          Conta de gestão — somente leitura. A ativação/desativação do monitoramento é feita pelo tenant.
        </Typography>
      ) : (
      <Box sx={{ mt: 1 }}>
        <Button
          size="small"
          variant={active ? "outlined" : "contained"}
          color={active ? "inherit" : "primary"}
          disabled={busy || (!active && !canActivate)}
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <HealthAndSafetyIcon />}
          onClick={() => void toggle(!active)}
          sx={{ width: { xs: "100%", sm: "auto" } }}
        >
          {busy
            ? "Processando..."
            : active
              ? "Desativar Monitoramento"
              : "Ativar Monitoramento Auto Care"}
        </Button>
      </Box>
      )}
    </Alert>
  );
}
