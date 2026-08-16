"use client";

import { useEffect, useState } from "react";
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
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select, { type SelectChangeEvent } from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ChipProps } from "@mui/material/Chip";
import type { Tenant, TenantStatus } from "@/types";
import {
  tenantsStore,
  type CreateTenantPayload,
  type UpdateTenantPayload,
} from "@/stores/tenantsStore";
import { plansStore } from "@/stores/plansStore";

const STATUS_OPTIONS: TenantStatus[] = ["active", "suspended", "inactive"];

const STATUS_LABEL: Record<TenantStatus, string> = {
  active: "Ativo",
  suspended: "Suspenso",
  inactive: "Inativo",
};

const STATUS_COLOR: Record<TenantStatus, ChipProps["color"]> = {
  active: "success",
  suspended: "warning",
  inactive: "default",
};

function isTenantStatus(value: string): value is TenantStatus {
  return (STATUS_OPTIONS as string[]).includes(value);
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return isNaN(date.getTime()) ? "—" : date.toLocaleDateString("pt-BR");
}

type DialogMode =
  | { kind: "create" }
  | { kind: "edit"; tenant: Tenant };

function TenantDialog({
  mode,
  open,
  onClose,
}: {
  mode: DialogMode;
  open: boolean;
  onClose: () => void;
}) {
  const editing = mode.kind === "edit" ? mode.tenant : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [planId, setPlanId] = useState(editing?.planId ?? "");
  const [status, setStatus] = useState<TenantStatus>(editing?.status ?? "active");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= 2;
  const planValid = planId.length > 0;
  const canSubmit = nameValid && planValid && !saving;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      if (mode.kind === "create") {
        const payload: CreateTenantPayload = { name: trimmedName, planId, status };
        await tenantsStore.create(payload);
      } else {
        const payload: UpdateTenantPayload = {};
        if (trimmedName !== mode.tenant.name) payload.name = trimmedName;
        if (planId !== mode.tenant.planId) payload.planId = planId;
        if (status !== mode.tenant.status) payload.status = status;
        await tenantsStore.update(mode.tenant.id, payload);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar tenant");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {mode.kind === "create" ? "Novo tenant" : `Editar tenant — ${mode.tenant.name}`}
      </DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={name.length > 0 && !nameValid}
          helperText={name.length > 0 && !nameValid ? "Informe ao menos 2 caracteres." : " "}
          fullWidth
          required
          autoFocus
        />
        <FormControl fullWidth required>
          <InputLabel id="tenant-plan-label">Plano</InputLabel>
          <Select
            labelId="tenant-plan-label"
            label="Plano"
            value={planId}
            onChange={(e: SelectChangeEvent) => setPlanId(e.target.value)}
          >
            {plansStore.plans.length === 0 && (
              <MenuItem value="" disabled>
                Nenhum plano disponível
              </MenuItem>
            )}
            {plansStore.plans.map((plan) => (
              <MenuItem key={plan.id} value={plan.id}>
                {plan.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel id="tenant-status-label">Status</InputLabel>
          <Select
            labelId="tenant-status-label"
            label="Status"
            value={status}
            onChange={(e: SelectChangeEvent) => {
              if (isTenantStatus(e.target.value)) setStatus(e.target.value);
            }}
          >
            {STATUS_OPTIONS.map((option) => (
              <MenuItem key={option} value={option}>
                {STATUS_LABEL[option]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancelar
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={!canSubmit}>
          {saving ? <CircularProgress size={18} color="inherit" /> : "Salvar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function TenantStatusSelect({ tenant }: { tenant: Tenant }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(event: SelectChangeEvent) {
    const next = event.target.value;
    if (!isTenantStatus(next) || next === tenant.status) return;
    setBusy(true);
    setError(null);
    try {
      await tenantsStore.setStatus(tenant.id, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao alterar status");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Chip
        label={STATUS_LABEL[tenant.status]}
        color={STATUS_COLOR[tenant.status]}
        size="small"
        variant={tenant.status === "inactive" ? "outlined" : "filled"}
      />
      <FormControl size="small" sx={{ minWidth: 130 }}>
        <Select
          value={tenant.status}
          onChange={handleChange}
          disabled={busy}
          aria-label={`Alterar status de ${tenant.name}`}
        >
          {STATUS_OPTIONS.map((option) => (
            <MenuItem key={option} value={option}>
              {STATUS_LABEL[option]}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      {busy && <CircularProgress size={16} />}
      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
    </Stack>
  );
}

const COLSPAN = 7;

const ZentrizTenantsPage = observer(function ZentrizTenantsPage() {
  const [dialog, setDialog] = useState<DialogMode | null>(null);

  useEffect(() => {
    tenantsStore.load();
    if (plansStore.plans.length === 0) plansStore.load();
  }, []);

  const { tenants, loading, error } = tenantsStore;
  const showInitialLoading = loading && tenants.length === 0;

  return (
    <Box>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        alignItems={{ xs: "stretch", sm: "center" }}
        justifyContent="space-between"
        sx={{ mb: 1 }}
      >
        <Typography variant="h4">Gestão de tenants</Typography>
        <Button
          variant="contained"
          onClick={() => setDialog({ kind: "create" })}
          sx={{ width: { xs: "100%", sm: "auto" } }}
        >
          Novo tenant
        </Button>
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>
        Desativar um tenant (status diferente de Ativo) bloqueia o login de todos os seus usuários.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TableContainer component={Paper}>
        <Table sx={{ minWidth: 860 }}>
          <TableHead>
            <TableRow>
              <TableCell>Nome</TableCell>
              <TableCell>Plano</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Usuários</TableCell>
              <TableCell align="right">Projetos</TableCell>
              <TableCell>Criado em</TableCell>
              <TableCell align="right">Ações</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {showInitialLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  {Array.from({ length: COLSPAN }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton variant="text" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}

            {!showInitialLoading && tenants.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLSPAN} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">
                    Nenhum tenant cadastrado ainda.
                  </Typography>
                </TableCell>
              </TableRow>
            )}

            {!showInitialLoading &&
              tenants.map((tenant) => (
                <TableRow key={tenant.id} hover>
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>
                      {tenant.name}
                    </Typography>
                  </TableCell>
                  <TableCell>{tenant.plan?.name ?? "—"}</TableCell>
                  <TableCell>
                    <TenantStatusSelect tenant={tenant} />
                  </TableCell>
                  <TableCell align="right">{tenant.usersCount ?? "—"}</TableCell>
                  <TableCell align="right">{tenant.projectsCount ?? "—"}</TableCell>
                  <TableCell>{formatDate(tenant.createdAt)}</TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => setDialog({ kind: "edit", tenant })}
                    >
                      Editar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableContainer>

      {dialog && (
        <TenantDialog
          key={dialog.kind === "edit" ? dialog.tenant.id : "create"}
          mode={dialog}
          open
          onClose={() => setDialog(null)}
        />
      )}
    </Box>
  );
});

export default ZentrizTenantsPage;
