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
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputAdornment from "@mui/material/InputAdornment";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select, { type SelectChangeEvent } from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import SearchIcon from "@mui/icons-material/Search";
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
import { maskCnpj, normalizeCnpjInput, maskCep, maskPhone } from "@/lib/masks";

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
  const [email, setEmail] = useState(editing?.email ?? "");
  const [emailConfirmed, setEmailConfirmed] = useState(editing?.emailConfirmed ?? false);
  const [cnpj, setCnpj] = useState(maskCnpj(editing?.cnpj ?? ""));
  const [responsibleName, setResponsibleName] = useState(editing?.responsibleName ?? "");
  const [responsibleEmail, setResponsibleEmail] = useState(editing?.responsibleEmail ?? "");
  const [responsiblePhone, setResponsiblePhone] = useState(maskPhone(editing?.responsiblePhone ?? ""));
  const [addressCep, setAddressCep] = useState(maskCep(editing?.addressCep ?? ""));
  const [addressStreet, setAddressStreet] = useState(editing?.addressStreet ?? "");
  const [addressNumber, setAddressNumber] = useState(editing?.addressNumber ?? "");
  const [addressComplement, setAddressComplement] = useState(editing?.addressComplement ?? "");
  const [addressDistrict, setAddressDistrict] = useState(editing?.addressDistrict ?? "");
  const [addressCity, setAddressCity] = useState(editing?.addressCity ?? "");
  const [addressState, setAddressState] = useState(editing?.addressState ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cnpjBusy, setCnpjBusy] = useState(false);
  const [cnpjMsg, setCnpjMsg] = useState<{ severity: "success" | "error"; text: string } | null>(null);

  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= 2;
  const planValid = planId.length > 0;
  const emailValid = email.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const cnpjNorm = normalizeCnpjInput(cnpj);
  const cnpjValid = cnpjNorm.length === 0 || cnpjNorm.length === 14;
  const canSubmit = nameValid && planValid && emailValid && cnpjValid && !saving;

  async function handleCnpjLookup() {
    if (cnpjNorm.length !== 14 || cnpjBusy) return;
    setCnpjBusy(true);
    setCnpjMsg(null);
    try {
      const data = await tenantsStore.lookupCnpj(cnpjNorm);
      // Preenche só o que veio (sem sobrescrever com vazio).
      if (data.name && !name.trim()) setName(data.name);
      if (data.email && !email.trim()) setEmail(data.email);
      if (data.phone && !responsiblePhone.trim()) setResponsiblePhone(maskPhone(data.phone));
      const a = data.address ?? {};
      if (a.cep) setAddressCep(maskCep(a.cep));
      if (a.street) setAddressStreet(a.street);
      if (a.number) setAddressNumber(a.number);
      if (a.complement) setAddressComplement(a.complement);
      if (a.district) setAddressDistrict(a.district);
      if (a.city) setAddressCity(a.city);
      if (a.state) setAddressState(a.state);
      setCnpjMsg({ severity: "success", text: `Dados de ${data.name || "CNPJ"} carregados.` });
    } catch (err) {
      setCnpjMsg({ severity: "error", text: err instanceof Error ? err.message : "Falha ao consultar CNPJ" });
    } finally {
      setCnpjBusy(false);
    }
  }

  /** Diff camelCase: envia campo só quando mudou (null quando limpo). */
  function contactPayload(): UpdateTenantPayload {
    const p: UpdateTenantPayload = {};
    const pairs: [keyof UpdateTenantPayload, string, string | null][] = [
      ["email", email.trim().toLowerCase(), editing?.email ?? null],
      ["cnpj", cnpjNorm, editing?.cnpj ?? null],
      ["responsibleName", responsibleName.trim(), editing?.responsibleName ?? null],
      ["responsibleEmail", responsibleEmail.trim().toLowerCase(), editing?.responsibleEmail ?? null],
      ["responsiblePhone", responsiblePhone.trim(), editing?.responsiblePhone ?? null],
      ["addressCep", addressCep.trim(), editing?.addressCep ?? null],
      ["addressStreet", addressStreet.trim(), editing?.addressStreet ?? null],
      ["addressNumber", addressNumber.trim(), editing?.addressNumber ?? null],
      ["addressComplement", addressComplement.trim(), editing?.addressComplement ?? null],
      ["addressDistrict", addressDistrict.trim(), editing?.addressDistrict ?? null],
      ["addressCity", addressCity.trim(), editing?.addressCity ?? null],
      ["addressState", addressState.trim().toUpperCase(), editing?.addressState ?? null],
    ];
    for (const [key, value, original] of pairs) {
      const normalizedOriginal = original ?? "";
      if (value !== normalizedOriginal) {
        (p as Record<string, unknown>)[key] = value === "" ? null : value;
      }
    }
    if (emailConfirmed !== (editing?.emailConfirmed ?? false)) p.emailConfirmed = emailConfirmed;
    return p;
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      if (mode.kind === "create") {
        const payload: CreateTenantPayload = { name: trimmedName, planId, status, ...contactPayload() };
        await tenantsStore.create(payload);
      } else {
        const payload: UpdateTenantPayload = contactPayload();
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
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>
        {mode.kind === "create" ? "Novo tenant" : `Editar tenant — ${mode.tenant.name}`}
      </DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}

        <Typography variant="overline" color="text.secondary">Dados da empresa</Typography>
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
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
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
        </Stack>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
          <TextField
            label="E-mail de contato"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={!emailValid}
            helperText={!emailValid ? "E-mail inválido." : " "}
            fullWidth
          />
          <FormControlLabel
            control={<Switch checked={emailConfirmed} onChange={(e) => setEmailConfirmed(e.target.checked)} />}
            label="E-mail confirmado"
            sx={{ whiteSpace: "nowrap" }}
          />
        </Stack>

        <Divider textAlign="left">
          <Typography variant="overline" color="text.secondary">CNPJ</Typography>
        </Divider>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "flex-start" }}>
          <TextField
            label="CNPJ"
            value={cnpj}
            onChange={(e) => setCnpj(maskCnpj(e.target.value))}
            error={!cnpjValid}
            helperText={!cnpjValid ? "CNPJ deve ter 14 caracteres." : "Aceita o novo formato alfanumérico da SEFAZ."}
            fullWidth
            inputProps={{ maxLength: 18, autoCapitalize: "characters", style: { textTransform: "uppercase" } }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title="Consultar dados na Receita">
                    <span>
                      <Button
                        size="small"
                        onClick={handleCnpjLookup}
                        disabled={cnpjNorm.length !== 14 || cnpjBusy}
                        startIcon={cnpjBusy ? <CircularProgress size={14} /> : <SearchIcon />}
                      >
                        Consultar
                      </Button>
                    </span>
                  </Tooltip>
                </InputAdornment>
              ),
            }}
          />
        </Stack>
        {cnpjMsg && <Alert severity={cnpjMsg.severity}>{cnpjMsg.text}</Alert>}

        <Divider textAlign="left">
          <Typography variant="overline" color="text.secondary">Responsável</Typography>
        </Divider>
        <TextField label="Nome do responsável" value={responsibleName} onChange={(e) => setResponsibleName(e.target.value)} fullWidth />
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <TextField label="E-mail do responsável" type="email" value={responsibleEmail} onChange={(e) => setResponsibleEmail(e.target.value)} fullWidth />
          <TextField label="Telefone" value={responsiblePhone} onChange={(e) => setResponsiblePhone(maskPhone(e.target.value))} placeholder="(11) 99999-9999" inputProps={{ inputMode: "tel", maxLength: 15 }} fullWidth />
        </Stack>

        <Divider textAlign="left">
          <Typography variant="overline" color="text.secondary">Endereço</Typography>
        </Divider>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <TextField label="CEP" value={addressCep} onChange={(e) => setAddressCep(maskCep(e.target.value))} placeholder="00000-000" inputProps={{ inputMode: "numeric", maxLength: 9 }} sx={{ width: { sm: 160 } }} fullWidth />
          <TextField label="Logradouro" value={addressStreet} onChange={(e) => setAddressStreet(e.target.value)} fullWidth />
          <TextField label="Número" value={addressNumber} onChange={(e) => setAddressNumber(e.target.value)} sx={{ width: { sm: 120 } }} fullWidth />
        </Stack>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <TextField label="Complemento" value={addressComplement} onChange={(e) => setAddressComplement(e.target.value)} fullWidth />
          <TextField label="Bairro" value={addressDistrict} onChange={(e) => setAddressDistrict(e.target.value)} fullWidth />
        </Stack>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <TextField label="Cidade" value={addressCity} onChange={(e) => setAddressCity(e.target.value)} fullWidth />
          <TextField label="UF" value={addressState} onChange={(e) => setAddressState(e.target.value)} inputProps={{ maxLength: 2 }} sx={{ width: { sm: 100 } }} fullWidth />
        </Stack>
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

const COLSPAN = 8;

/** Célula de e-mail com selo de confirmação. */
function TenantEmailCell({ tenant }: { tenant: Tenant }) {
  if (!tenant.email) {
    return <Typography variant="body2" color="text.disabled">—</Typography>;
  }
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Typography variant="body2" sx={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
        {tenant.email}
      </Typography>
      <Tooltip title={tenant.emailConfirmed ? "E-mail confirmado" : "E-mail não confirmado"}>
        {tenant.emailConfirmed ? (
          <CheckCircleIcon color="success" sx={{ fontSize: 18 }} />
        ) : (
          <ErrorOutlineIcon color="warning" sx={{ fontSize: 18 }} />
        )}
      </Tooltip>
    </Stack>
  );
}

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
              <TableCell>E-mail</TableCell>
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
                  <TableCell>
                    <TenantEmailCell tenant={tenant} />
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
