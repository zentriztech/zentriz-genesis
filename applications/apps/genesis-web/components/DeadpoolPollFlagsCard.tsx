"use client";

/**
 * DeadpoolPollFlagsCard — controle das flags de POLL ATIVO por nuvem do Deadpool.
 *
 * Liga/desliga em runtime (sem redeploy) `allow_{cloudwatch,azure,gcp}_poll` via
 * /api/deadpool/monitoring/flags. Por padrão TODAS ficam desligadas — o card deixa isso
 * explícito com um badge "Desligado" por nuvem e mostra a origem do valor (env vs. override).
 *
 * Aviso importante para o operador: ligar uma nuvem aqui só tem efeito se o LOOP de
 * monitoramento (monitor_enabled) estiver ligado — esse gate é READ-ONLY (só muda por
 * ambiente/restart). Se estiver off, o card mostra um alerta de que nada será pollado.
 *
 * Visibilidade: ligar poll ativo bate no SDK de nuvem do cliente → é decisão operacional
 * global da Zentriz. O gateway exige zentriz_admin; a página só monta este card para ele.
 */

import { useEffect } from "react";
import { observer } from "mobx-react-lite";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import Link from "@mui/material/Link";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import { deadpoolStore, POLL_FLAG_META, type PollFlagState } from "@/stores/deadpoolStore";

function FlagRow({ flag, cloud }: { flag: string; cloud: string }) {
  const state: PollFlagState | undefined = deadpoolStore.flags[flag];
  const on = state?.value === true;
  const isOverride = state?.source === "override";
  const saving = deadpoolStore.flagSaving === flag;
  const disabled = saving || deadpoolStore.flagSaving !== null || !deadpoolStore.flagsAvailable;

  return (
    <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ py: 1 }}>
      <CloudQueueIcon sx={{ color: on ? "#10B981" : "#6B7280", fontSize: 20 }} />
      <Box sx={{ minWidth: 150 }}>
        <Typography fontWeight={600}>{cloud}</Typography>
        <Typography variant="caption" sx={{ color: "text.secondary", fontFamily: "monospace" }}>
          {flag}
        </Typography>
      </Box>

      {/* Badge de estado — "Desligado" em destaque quando off (requisito explícito). */}
      <Chip
        label={on ? "Ligado" : "Desligado"}
        size="small"
        sx={{
          fontWeight: 700,
          bgcolor: on ? "#10B98122" : "#6B728022",
          color: on ? "#059669" : "#4B5563",
        }}
      />

      {/* Origem do valor: env (default) ou override (fixado no Portal). */}
      <Chip
        label={isOverride ? "override" : "env"}
        size="small"
        variant="outlined"
        sx={{ color: "text.secondary", borderColor: "divider" }}
      />
      {isOverride && (
        <Link
          component="button"
          type="button"
          underline="hover"
          disabled={disabled}
          onClick={() => void deadpoolStore.setPollFlag(flag, null)}
          sx={{ fontSize: "0.75rem", color: "text.secondary" }}
        >
          voltar ao padrão
        </Link>
      )}

      <Box sx={{ flexGrow: 1 }} />
      {saving ? (
        <CircularProgress size={18} />
      ) : (
        <Switch
          checked={on}
          disabled={disabled}
          onChange={(e) => void deadpoolStore.setPollFlag(flag, e.target.checked)}
          color="success"
          inputProps={{ "aria-label": `poll ${cloud}` }}
        />
      )}
    </Stack>
  );
}

export default observer(function DeadpoolPollFlagsCard() {
  useEffect(() => {
    void deadpoolStore.loadMonitoringFlags();
  }, []);

  const { flagsLoading, flagsLoaded, flagsAvailable, flagsReason, flagsError, monitorEnabled, anyPollOn } =
    deadpoolStore;

  return (
    <Box>
      <Typography variant="h6" fontWeight={700} mb={1.5}>
        Monitoramento ativo por nuvem
      </Typography>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
            Liga/desliga o <strong>poll ativo de logs</strong> por nuvem em runtime (sem redeploy).
            Por padrão tudo fica desligado. Ligar uma nuvem faz o Auto Care consultar o SDK dela
            periodicamente à procura de sinais de incidente.
          </Typography>

          {flagsLoading && !flagsLoaded ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : !flagsAvailable ? (
            <Alert severity="info">
              Flags de monitoramento indisponíveis
              {flagsReason ? ` — ${flagsReason}` : "."}
            </Alert>
          ) : (
            <>
              {/* Gate do loop — READ-ONLY. Sem ele, ligar uma nuvem não polla nada. */}
              {monitorEnabled ? (
                <Alert severity="success" sx={{ mb: 2 }}>
                  Loop de monitoramento <strong>ligado</strong>. As nuvens marcadas abaixo são consultadas periodicamente.
                </Alert>
              ) : (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  Loop de monitoramento <strong>desligado</strong> (<code>monitor_enabled=off</code>).
                  Mesmo ligando uma nuvem abaixo, nada é pollado até o loop ser habilitado por ambiente.
                </Alert>
              )}

              {flagsError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {flagsError}
                </Alert>
              )}

              <Divider sx={{ mb: 1 }} />
              {POLL_FLAG_META.map(({ flag, cloud }, i) => (
                <Box key={flag}>
                  {i > 0 && <Divider />}
                  <FlagRow flag={flag} cloud={cloud} />
                </Box>
              ))}

              {!anyPollOn && (
                <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 1.5 }}>
                  Nenhuma nuvem com poll ativo — o Auto Care segue reativo (webhooks) apenas.
                </Typography>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </Box>
  );
});
