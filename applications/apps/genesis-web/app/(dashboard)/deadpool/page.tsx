"use client";

import { useEffect } from "react";
import { observer } from "mobx-react-lite";
import { useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import HealthAndSafetyIcon from "@mui/icons-material/HealthAndSafety";
import RefreshIcon from "@mui/icons-material/Refresh";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import { deadpoolStore } from "@/stores/deadpoolStore";
import { authStore } from "@/stores/authStore";
import DeadpoolPollFlagsCard from "@/components/DeadpoolPollFlagsCard";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#EF4444",
  high:     "#F97316",
  medium:   "#F59E0B",
  low:      "#10B981",
  info:     "#3B82F6",
};

function severityColor(sev?: string): string {
  return SEVERITY_COLORS[(sev ?? "").toLowerCase()] ?? "#6B7280";
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR");
}

export default observer(function DeadpoolPage() {
  const router = useRouter();

  useEffect(() => {
    void deadpoolStore.loadOverview();
  }, []);

  const { status, projects, incidents, overviewLoading, overviewError, overviewLoaded, unavailable } =
    deadpoolStore;

  return (
    <Box sx={{ maxWidth: 960, mx: "auto", p: { xs: 2, md: 4 } }}>
      <Stack direction="row" alignItems="center" spacing={1.5} mb={3}>
        <HealthAndSafetyIcon sx={{ color: "#EF4444", fontSize: 28 }} />
        <Typography variant="h5" fontWeight={700}>Deadpool</Typography>
        <Chip label="Sustainment / Auto-Care" size="small" sx={{ bgcolor: "#EF4444", color: "#fff" }} />
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Base de conhecimento">
          <IconButton onClick={() => router.push("/deadpool/knowledge")}><MenuBookIcon /></IconButton>
        </Tooltip>
        <Tooltip title="Recarregar">
          <IconButton onClick={() => void deadpoolStore.loadOverview()}><RefreshIcon /></IconButton>
        </Tooltip>
      </Stack>

      {/* ── Banner de saúde ─────────────────────────────────────────────────── */}
      {unavailable ? (
        <Alert severity="info" sx={{ mb: 3 }}>
          Deadpool indisponível ou desconectado
          {status?.reason ? ` — ${status.reason}` : "."}
        </Alert>
      ) : status ? (
        <Alert severity={status.ready ? "success" : "warning"} sx={{ mb: 3 }}>
          Deadpool conectado
          {status.health ? ` · saúde: ${status.health}` : ""}
          {typeof status.ready === "boolean" ? ` · ${status.ready ? "pronto" : "não pronto"}` : ""}
        </Alert>
      ) : null}

      {overviewError && (
        <Alert severity="error" sx={{ mb: 3 }}>{overviewError}</Alert>
      )}

      {overviewLoading && !overviewLoaded ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Stack spacing={4}>
          {/* ── Flags de poll ativo por nuvem (toggle) — só Zentriz admin ──── */}
          {authStore.isZentrizAdmin && <DeadpoolPollFlagsCard />}

          {/* ── Projetos monitorados ──────────────────────────────────────── */}
          <Box>
            <Typography variant="h6" fontWeight={700} mb={1.5}>Projetos monitorados</Typography>
            {projects.length === 0 ? (
              <Card variant="outlined"><CardContent>
                <Typography color="text.secondary">Nenhum projeto monitorado pelo Deadpool.</Typography>
              </CardContent></Card>
            ) : (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>System ID</TableCell>
                      <TableCell>Service ID</TableCell>
                      <TableCell>Repositório</TableCell>
                      <TableCell>Installation</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {projects.map((p, i) => (
                      <TableRow key={p.system_id ?? p.service_id ?? i}>
                        <TableCell sx={{ fontFamily: "monospace" }}>{p.system_id ?? "—"}</TableCell>
                        <TableCell sx={{ fontFamily: "monospace" }}>{p.service_id ?? "—"}</TableCell>
                        <TableCell>
                          {p.repo_url ? (
                            <Link href={p.repo_url} target="_blank" rel="noopener" sx={{ fontSize: "0.85rem" }}>
                              {p.repo_url}
                            </Link>
                          ) : "—"}
                        </TableCell>
                        <TableCell>{p.installation_id ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>

          {/* ── Incidentes recentes ───────────────────────────────────────── */}
          <Box>
            <Typography variant="h6" fontWeight={700} mb={1.5}>Incidentes recentes</Typography>
            {incidents.length === 0 ? (
              <Card variant="outlined"><CardContent>
                <Typography color="text.secondary">Nenhum incidente registrado.</Typography>
              </CardContent></Card>
            ) : (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Serviço</TableCell>
                      <TableCell>Severidade</TableCell>
                      <TableCell>Categoria</TableCell>
                      <TableCell>Ambiente</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Registrado</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {incidents.map((inc, i) => (
                      <TableRow
                        key={inc.incident_id ?? i}
                        hover
                        sx={{ cursor: "pointer" }}
                        onClick={() => router.push(`/deadpool/incidents/${inc.incident_id}`)}
                      >
                        <TableCell>{inc.service_name ?? "—"}</TableCell>
                        <TableCell>
                          <Chip
                            label={inc.severity ?? "—"}
                            size="small"
                            sx={{
                              bgcolor: severityColor(inc.severity) + "22",
                              color: severityColor(inc.severity),
                              fontWeight: 600,
                            }}
                          />
                        </TableCell>
                        <TableCell>{inc.category ?? "—"}</TableCell>
                        <TableCell>{inc.environment ?? "—"}</TableCell>
                        <TableCell>{inc.status ?? "—"}</TableCell>
                        <TableCell>{fmtDate(inc.stored_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        </Stack>
      )}
    </Box>
  );
});
