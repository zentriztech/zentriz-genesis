"use client";

import { useEffect, useMemo, useState } from "react";
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
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { usersStore } from "@/stores/usersStore";
import { tenantsStore } from "@/stores/tenantsStore";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
import type { User, UserRole } from "@/types";

const ROLE_LABELS: Record<UserRole, string> = {
  user: "Usuário",
  tenant_admin: "Admin do tenant",
  zentriz_admin: "Zentriz (master)",
};

type RoleChipColor = "default" | "primary" | "secondary";
const ROLE_CHIP_COLOR: Record<UserRole, RoleChipColor> = {
  user: "default",
  tenant_admin: "primary",
  zentriz_admin: "secondary",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

function tenantLabel(tenantId: string | null): string {
  if (!tenantId) return "— (Zentriz)";
  return tenantsStore.getById(tenantId)?.name ?? "— (tenant desconhecido)";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR");
}

// ---------------------------------------------------------------------------
// Dialog: criar usuário
// ---------------------------------------------------------------------------
type CreateDialogProps = {
  open: boolean;
  defaultTenantId: string | null;
  onClose: () => void;
  onCreated: () => void;
};

function CreateUserDialog({ open, defaultTenantId, onClose, onCreated }: CreateDialogProps) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [tenantId, setTenantId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isMaster = role === "zentriz_admin";

  // Reinicia o formulário toda vez que o diálogo abre.
  useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setPassword("");
      setRole("user");
      setTenantId(defaultTenantId ?? "");
      setSubmitting(false);
      setFormError(null);
    }
  }, [open, defaultTenantId]);

  const emailInvalid = email.length > 0 && !EMAIL_RE.test(email);
  const passwordInvalid = password.length > 0 && password.length < MIN_PASSWORD;
  const tenantMissing = !isMaster && !tenantId;

  const canSubmit =
    EMAIL_RE.test(email) &&
    name.trim().length > 0 &&
    password.length >= MIN_PASSWORD &&
    !tenantMissing &&
    !submitting;

  function handleRoleChange(e: SelectChangeEvent) {
    const next = e.target.value as UserRole;
    setRole(next);
    if (next === "zentriz_admin") setTenantId("");
  }

  function handleTenantChange(e: SelectChangeEvent) {
    setTenantId(e.target.value);
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await usersStore.createUser({
        email: email.trim(),
        name: name.trim(),
        password,
        role,
        tenant_id: isMaster ? null : tenantId,
      });
      onCreated();
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Erro ao criar usuário");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Novo usuário</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {formError && <Alert severity="error">{formError}</Alert>}
          <TextField
            label="E-mail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailInvalid}
            helperText={emailInvalid ? "Informe um e-mail válido." : " "}
            required
            fullWidth
            autoFocus
          />
          <TextField
            label="Nome"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            fullWidth
          />
          <TextField
            label="Senha"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={passwordInvalid}
            helperText={passwordInvalid ? `Mínimo de ${MIN_PASSWORD} caracteres.` : " "}
            required
            fullWidth
          />
          <FormControl fullWidth>
            <InputLabel id="create-role-label">Papel</InputLabel>
            <Select
              labelId="create-role-label"
              label="Papel"
              value={role}
              onChange={handleRoleChange}
            >
              <MenuItem value="user">{ROLE_LABELS.user}</MenuItem>
              <MenuItem value="tenant_admin">{ROLE_LABELS.tenant_admin}</MenuItem>
              <MenuItem value="zentriz_admin">{ROLE_LABELS.zentriz_admin}</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth disabled={isMaster} error={tenantMissing}>
            <InputLabel id="create-tenant-label">Tenant</InputLabel>
            <Select
              labelId="create-tenant-label"
              label="Tenant"
              value={tenantId}
              onChange={handleTenantChange}
              displayEmpty
            >
              {isMaster ? (
                <MenuItem value="">— (Zentriz)</MenuItem>
              ) : (
                <MenuItem value="" disabled>
                  Selecione um tenant
                </MenuItem>
              )}
              {tenantsStore.tenants.map((t) => (
                <MenuItem key={t.id} value={t.id}>
                  {t.name}
                </MenuItem>
              ))}
            </Select>
            <Typography variant="caption" color={tenantMissing ? "error" : "text.secondary"} sx={{ mt: 0.5, ml: 1.75 }}>
              {isMaster
                ? "Master Zentriz não pertence a nenhum tenant."
                : tenantMissing
                  ? "Obrigatório para este papel."
                  : " "}
            </Typography>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancelar
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={!canSubmit}>
          {submitting ? "Criando…" : "Criar usuário"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dialog: editar usuário
// ---------------------------------------------------------------------------
type EditDialogProps = {
  user: User | null;
  onClose: () => void;
  onUpdated: () => void;
};

function EditUserDialog({ user, onClose, onUpdated }: EditDialogProps) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setEmail(user.email);
      setName(user.name);
      setPassword("");
      setRole(user.role);
      setSubmitting(false);
      setFormError(null);
    }
  }, [user]);

  const emailInvalid = email.length > 0 && !EMAIL_RE.test(email);
  const passwordInvalid = password.length > 0 && password.length < MIN_PASSWORD;

  const canSubmit =
    !!user &&
    EMAIL_RE.test(email) &&
    name.trim().length > 0 &&
    !passwordInvalid &&
    !submitting;

  function handleRoleChange(e: SelectChangeEvent) {
    setRole(e.target.value as UserRole);
  }

  async function handleSubmit() {
    if (!user || !canSubmit) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await usersStore.updateUser(user.id, {
        name: name.trim(),
        email: email.trim(),
        role,
        ...(password.length >= MIN_PASSWORD ? { password } : {}),
      });
      onUpdated();
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Erro ao atualizar usuário");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!user} onClose={submitting ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Editar usuário</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {formError && <Alert severity="error">{formError}</Alert>}
          <TextField
            label="Nome"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            fullWidth
            autoFocus
          />
          <TextField
            label="E-mail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailInvalid}
            helperText={emailInvalid ? "Informe um e-mail válido." : " "}
            required
            fullWidth
          />
          <TextField
            label="Senha"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={passwordInvalid}
            helperText={
              passwordInvalid
                ? `Mínimo de ${MIN_PASSWORD} caracteres.`
                : "Deixe em branco para manter a senha atual."
            }
            fullWidth
          />
          <FormControl fullWidth>
            <InputLabel id="edit-role-label">Papel</InputLabel>
            <Select
              labelId="edit-role-label"
              label="Papel"
              value={role}
              onChange={handleRoleChange}
            >
              <MenuItem value="user">{ROLE_LABELS.user}</MenuItem>
              <MenuItem value="tenant_admin">{ROLE_LABELS.tenant_admin}</MenuItem>
              <MenuItem value="zentriz_admin">{ROLE_LABELS.zentriz_admin}</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancelar
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={!canSubmit}>
          {submitting ? "Salvando…" : "Salvar alterações"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dialog: excluir usuário
// ---------------------------------------------------------------------------
type DeleteDialogProps = {
  user: User | null;
  onClose: () => void;
  onDeleted: (message: string) => void;
  onError: (message: string) => void;
};

function DeleteUserDialog({ user, onClose, onDeleted, onError }: DeleteDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    if (!user) return;
    setSubmitting(true);
    try {
      await usersStore.deleteUser(user.id);
      onDeleted(`Usuário “${user.email}” excluído.`);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Erro ao excluir usuário");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!user} onClose={submitting ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Excluir usuário</DialogTitle>
      <DialogContent>
        <Typography>
          Tem certeza de que deseja excluir o usuário{" "}
          <strong>{user?.email}</strong>? Esta ação não pode ser desfeita.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancelar
        </Button>
        <Button onClick={handleConfirm} variant="contained" color="error" disabled={submitting}>
          {submitting ? "Excluindo…" : "Excluir"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
function ZentrizUsersPageInner() {
  const scopeTenantId = tenantScopeStore.selectedTenantId;

  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [snackbar, setSnackbar] = useState<{ severity: "success" | "error"; message: string } | null>(null);

  // Carrega tenants uma vez; recarrega usuários quando o escopo de tenant do topo muda.
  useEffect(() => {
    if (tenantsStore.tenants.length === 0) {
      void tenantsStore.load();
    }
    void usersStore.loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeTenantId]);

  const scopeName = useMemo(
    () => (scopeTenantId ? tenantsStore.getById(scopeTenantId)?.name ?? null : null),
    [scopeTenantId, tenantsStore.tenants.length],
  );

  const { users, loading, error } = usersStore;

  return (
    <Box>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ xs: "stretch", sm: "center" }}
        sx={{ mb: 2 }}
      >
        <Typography variant="h4">Gestão de usuários</Typography>
        <Button variant="contained" onClick={() => setCreateOpen(true)}>
          Novo usuário
        </Button>
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>
        Como master Zentriz você gerencia todos os usuários de todos os tenants. Use o seletor de
        tenant no topo para filtrar.
        {scopeName && (
          <>
            {" "}
            <strong>Filtrando por: {scopeName}</strong>
          </>
        )}
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TableContainer component={Paper}>
        <Table sx={{ minWidth: 820 }}>
          <TableHead>
            <TableRow>
              <TableCell>E-mail</TableCell>
              <TableCell>Nome</TableCell>
              <TableCell>Tenant</TableCell>
              <TableCell>Papel</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Criado</TableCell>
              <TableCell align="right">Ações</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            )}

            {!loading && users.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">Nenhum usuário encontrado.</Typography>
                </TableCell>
              </TableRow>
            )}

            {!loading &&
              users.map((u) => (
                <TableRow key={u.id} hover>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>{u.name}</TableCell>
                  <TableCell>{tenantLabel(u.tenantId)}</TableCell>
                  <TableCell>
                    <Chip label={ROLE_LABELS[u.role]} size="small" color={ROLE_CHIP_COLOR[u.role]} />
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={u.status === "active" ? "Ativo" : "Inativo"}
                      size="small"
                      color={u.status === "active" ? "success" : "default"}
                    />
                  </TableCell>
                  <TableCell>{formatDate(u.createdAt)}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} justifyContent="flex-end">
                      <Button size="small" onClick={() => setEditingUser(u)}>
                        Editar
                      </Button>
                      <Button size="small" color="error" onClick={() => setDeletingUser(u)}>
                        Excluir
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableContainer>

      <CreateUserDialog
        open={createOpen}
        defaultTenantId={scopeTenantId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => setSnackbar({ severity: "success", message: "Usuário criado com sucesso." })}
      />
      <EditUserDialog
        user={editingUser}
        onClose={() => setEditingUser(null)}
        onUpdated={() => setSnackbar({ severity: "success", message: "Usuário atualizado com sucesso." })}
      />
      <DeleteUserDialog
        user={deletingUser}
        onClose={() => setDeletingUser(null)}
        onDeleted={(message) => setSnackbar({ severity: "success", message })}
        onError={(message) => setSnackbar({ severity: "error", message })}
      />

      <Snackbar
        open={!!snackbar}
        autoHideDuration={6000}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {snackbar ? (
          <Alert severity={snackbar.severity} onClose={() => setSnackbar(null)} sx={{ width: "100%" }}>
            {snackbar.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

export default observer(ZentrizUsersPageInner);
