"use client";

import { useEffect } from "react";
import { observer } from "mobx-react-lite";
import { useParams, useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { deadpoolStore } from "@/stores/deadpoolStore";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#EF4444",
  high:     "#F97316",
  medium:   "#F59E0B",
  low:      "#10B981",
  info:     "#3B82F6",
};

function chipColor(v?: string): string {
  return SEVERITY_COLORS[(v ?? "").toLowerCase()] ?? "#6B7280";
}

function asString(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Linha rótulo/valor. */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 0.5 }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 160, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ minWidth: 0, wordBreak: "break-word" }}>
        {typeof value === "string" || typeof value === "number" ? (
          <Typography variant="body2">{value}</Typography>
        ) : (
          value
        )}
      </Box>
    </Stack>
  );
}

export default observer(function DeadpoolIncidentPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  useEffect(() => {
    if (id) void deadpoolStore.loadIncident(id);
  }, [id]);

  const { incidentDetail, incidentLoading, incidentError } = deadpoolStore;

  const norm = (incidentDetail?.normalized_incident ?? {}) as Record<string, unknown>;
  const plan = incidentDetail?.patch_plan;
  const exec = incidentDetail?.runtime_execution_report;
  const violations = Array.isArray(exec?.guardrail_violations) ? exec!.guardrail_violations : [];

  return (
    <Box sx={{ maxWidth: 960, mx: "auto", p: { xs: 2, md: 4 } }}>
      <Stack direction="row" alignItems="center" spacing={1.5} mb={3}>
        <Button startIcon={<ArrowBackIcon />} onClick={() => router.push("/deadpool")} size="small">
          Voltar
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
          {id}
        </Typography>
      </Stack>

      {incidentLoading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
          <CircularProgress />
        </Box>
      ) : incidentError ? (
        <Alert severity="error">{incidentError}</Alert>
      ) : !incidentDetail ? (
        <Card variant="outlined"><CardContent>
          <Typography color="text.secondary">Incidente não encontrado.</Typography>
        </CardContent></Card>
      ) : (
        <Stack spacing={3}>
          {/* ── Incidente normalizado ─────────────────────────────────────── */}
          <Card variant="outlined">
            <CardContent>
              <Typography variant="h6" fontWeight={700} mb={1.5}>Incidente</Typography>
              <Field label="Serviço" value={asString(norm.service_name ?? norm.service ?? incidentDetail.incident_id)} />
              <Field
                label="Severidade"
                value={
                  <Chip
                    label={asString(norm.severity ?? incidentDetail.risk_level)}
                    size="small"
                    sx={{
                      bgcolor: chipColor(asString(norm.severity)) + "22",
                      color: chipColor(asString(norm.severity)),
                      fontWeight: 600,
                    }}
                  />
                }
              />
              <Field label="Categoria" value={asString(norm.category)} />
              <Field label="Ambiente" value={asString(norm.environment)} />
              {norm.summary != null && <Field label="Resumo" value={asString(norm.summary)} />}
              {norm.description != null && <Field label="Descrição" value={asString(norm.description)} />}
            </CardContent>
          </Card>

          {/* ── Proposta / Patch plan ─────────────────────────────────────── */}
          {plan && (
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" fontWeight={700} mb={1.5}>Proposta de correção</Typography>
                {plan.issue_title && <Field label="Título" value={asString(plan.issue_title)} />}
                <Field label="Branch" value={<Typography variant="body2" sx={{ fontFamily: "monospace" }}>{asString(plan.branch_name)}</Typography>} />
                <Field label="Commit" value={asString(plan.commit_message)} />
                <Field
                  label="Risco"
                  value={
                    <Chip
                      label={asString(plan.risk_level ?? incidentDetail.risk_level)}
                      size="small"
                      sx={{ bgcolor: chipColor(asString(plan.risk_level)) + "22", color: chipColor(asString(plan.risk_level)), fontWeight: 600 }}
                    />
                  }
                />
                <Field label="Blast radius" value={asString(plan.blast_radius_level ?? incidentDetail.blast_radius_level)} />
                {Array.isArray(plan.candidate_files) && plan.candidate_files.length > 0 && (
                  <>
                    <Divider sx={{ my: 1.5 }} />
                    <Typography variant="body2" color="text.secondary" mb={0.5}>Arquivos candidatos</Typography>
                    <Stack spacing={0.5}>
                      {plan.candidate_files.map((f, i) => (
                        <Typography key={i} variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.8rem" }}>
                          {f}
                        </Typography>
                      ))}
                    </Stack>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Execução ──────────────────────────────────────────────────── */}
          {exec && (
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" fontWeight={700} mb={1.5}>Execução</Typography>
                <Field
                  label="Status"
                  value={
                    <Chip
                      label={asString(exec.status)}
                      size="small"
                      sx={{ bgcolor: chipColor(asString(exec.status)) + "22", color: chipColor(asString(exec.status)), fontWeight: 600 }}
                    />
                  }
                />
                <Field label="Modo" value={asString(exec.execution_mode)} />
                {exec.pr_url && (
                  <Field
                    label="Pull Request"
                    value={
                      <Link href={exec.pr_url} target="_blank" rel="noopener" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "0.85rem" }}>
                        {exec.pr_url} <OpenInNewIcon sx={{ fontSize: "0.85rem" }} />
                      </Link>
                    }
                  />
                )}
                <Field label="Alterações aplicadas" value={String(Array.isArray(exec.applied_changes) ? exec.applied_changes.length : 0)} />
                {violations.length > 0 && (
                  <>
                    <Divider sx={{ my: 1.5 }} />
                    <Alert severity="warning" sx={{ mb: 1 }}>
                      {violations.length} violação(ões) de guardrail
                    </Alert>
                    <Stack spacing={0.5}>
                      {violations.map((v, i) => (
                        <Typography key={i} variant="body2" sx={{ fontSize: "0.8rem" }}>
                          {asString(v)}
                        </Typography>
                      ))}
                    </Stack>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Learning / Dossiê executivo ───────────────────────────────── */}
          {incidentDetail.executive_dossier != null && (
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" fontWeight={700} mb={1.5}>Aprendizado / Dossiê executivo</Typography>
                <Box
                  component="pre"
                  sx={{
                    m: 0, p: 1.5, borderRadius: 1, bgcolor: "action.hover",
                    fontSize: "0.75rem", overflow: "auto", maxHeight: 320, whiteSpace: "pre-wrap", wordBreak: "break-word",
                  }}
                >
                  {typeof incidentDetail.executive_dossier === "string"
                    ? incidentDetail.executive_dossier
                    : JSON.stringify(incidentDetail.executive_dossier, null, 2)}
                </Box>
              </CardContent>
            </Card>
          )}
        </Stack>
      )}
    </Box>
  );
});
