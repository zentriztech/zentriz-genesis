"use client";
/**
 * /settings/audit — item 2 (extras de UI): trilha de auditoria de governança (D4).
 * Lê GET /api/governance-audit (tenant-scoped no servidor; zentriz_admin vê tudo): quem promoveu/aprovou
 * o quê, com que papel, incluindo `spec_self_approved` (autor aprovou a própria spec — bypass mantido por
 * decisão, mas SEMPRE auditado). Só leitura.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import RefreshIcon from "@mui/icons-material/Refresh";
import { apiGet } from "@/lib/api";

interface AuditRow {
  id: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  projectId: string | null;
  productId: string | null;
  specHash: string | null;
  snapshot: Record<string, unknown> | null;
  createdAt: string;
}

const ACTION_LABEL: Record<string, string> = {
  spec_self_approved: "Spec aprovada pelo próprio autor",
  spec_promoted: "Spec promovida à fábrica",
  product_promoted: "Produto promovido",
  evolution_promoted: "Evolução promovida",
  ack_findings: "Avisos reconhecidos (ack por run)",
  force_promote: "Promoção forçada com blockers (admin)",
  // RFC-0005 — triagem de GAPs blocker (só tenant_admin, com motivo)
  gap_ignored_blocker: "GAP blocker IGNORADO",
  gap_refuted_blocker: "GAP blocker REFUTADO",
  gap_reactivated: "GAP blocker reativado",
};

function actionChip(action: string) {
  const self = action === "spec_self_approved";
  const gapBlocker = action.startsWith("gap_") || action === "force_promote";
  return <Chip size="small" color={self || gapBlocker ? "warning" : "default"} variant={self || gapBlocker ? "filled" : "outlined"} label={ACTION_LABEL[action] ?? action} sx={{ fontSize: "0.7rem" }} />;
}

export default function GovernanceAuditPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string>("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: "200" });
      if (action) qs.set("action", action);
      setRows(await apiGet<AuditRow[]>(`/api/governance-audit?${qs.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar a auditoria");
      setRows([]);
    }
  }, [action]);
  useEffect(() => { void load(); }, [load]);

  const actions = useMemo(() => Array.from(new Set((rows ?? []).map((r) => r.action))).sort(), [rows]);
  const selfApproved = (rows ?? []).filter((r) => r.action === "spec_self_approved").length;

  return (
    <Box sx={{ p: { xs: 1.5, md: 3 }, maxWidth: 1200 }}>
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} spacing={1} sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Auditoria de governança</Typography>
          <Typography variant="body2" color="text.secondary">
            Quem promoveu ou aprovou specs e produtos, com que papel. Aprovações do próprio autor são permitidas, mas ficam marcadas.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField select size="small" label="Ação" value={action} onChange={(e) => setAction(e.target.value)} sx={{ minWidth: 220 }}>
            <MenuItem value="">Todas</MenuItem>
            {(actions.length ? actions : Object.keys(ACTION_LABEL)).map((a) => <MenuItem key={a} value={a}>{ACTION_LABEL[a] ?? a}</MenuItem>)}
          </TextField>
          <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => void load()}>Atualizar</Button>
        </Stack>
      </Stack>

      {selfApproved > 0 && !action && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {selfApproved} promoção{selfApproved > 1 ? "ões" : ""} em que o autor aprovou a própria spec (sem revisor). Considere segregar autoria e aprovação.
        </Alert>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Paper variant="outlined">
        {rows === null ? (
          <Box sx={{ p: 4, textAlign: "center" }}><CircularProgress size={22} /></Box>
        ) : rows.length === 0 ? (
          <Box sx={{ p: 4, textAlign: "center" }}><Typography color="text.secondary">Nenhum evento de auditoria.</Typography></Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Quando</TableCell>
                <TableCell>Ação</TableCell>
                <TableCell>Papel</TableCell>
                <TableCell>Projeto / Produto</TableCell>
                <TableCell>Spec hash</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <TableRow hover>
                    <TableCell sx={{ whiteSpace: "nowrap", fontSize: "0.75rem" }}>{new Date(r.createdAt).toLocaleString("pt-BR")}</TableCell>
                    <TableCell>{actionChip(r.action)}</TableCell>
                    <TableCell sx={{ fontSize: "0.75rem" }}>{r.actorRole ?? "—"}</TableCell>
                    <TableCell sx={{ fontSize: "0.75rem" }}>
                      {r.projectId && <Link href={`/projects/${r.projectId}`}>projeto {r.projectId.slice(0, 8)}</Link>}
                      {r.projectId && r.productId && " · "}
                      {r.productId && <Link href={`/products/${r.productId}`}>produto {r.productId.slice(0, 8)}</Link>}
                      {!r.projectId && !r.productId && "—"}
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}>{r.specHash ? r.specHash.slice(0, 12) : "—"}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => setOpen(open === r.id ? null : r.id)} sx={{ textTransform: "none", fontSize: "0.7rem" }}>
                        {open === r.id ? "ocultar" : "detalhes"}
                      </Button>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={6} sx={{ p: 0, border: 0 }}>
                      <Collapse in={open === r.id} unmountOnExit>
                        <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: "action.hover", fontSize: "0.7rem", overflowX: "auto" }}>
                          {JSON.stringify(r.snapshot ?? {}, null, 2)}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>
    </Box>
  );
}
