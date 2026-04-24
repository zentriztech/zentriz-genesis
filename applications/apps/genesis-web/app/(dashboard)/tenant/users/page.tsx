"use client";

import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import type { User } from "@/types";
import { usersStore } from "@/stores/usersStore";
import { authStore } from "@/stores/authStore";

const ROLES = ["user", "tenant_admin", "zentriz_admin"] as const;

function EditUserDialog({
  user,
  open,
  onClose,
}: {
  user: User;
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState(user.role);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, string> = {};
      if (name !== user.name) payload.name = name;
      if (email !== user.email) payload.email = email;
      if (role !== user.role) payload.role = role;
      if (password) payload.password = password;
      await usersStore.updateUser(user.id, payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Editar usuário</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField label="Nome" value={name} onChange={(e) => setName(e.target.value)} fullWidth />
        <TextField label="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} fullWidth />
        <TextField
          label="Nova senha (deixe em branco para não alterar)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          fullWidth
        />
        <Select value={role} onChange={(e) => setRole(e.target.value as User["role"])} fullWidth>
          {ROLES.map((r) => (
            <MenuItem key={r} value={r}>
              {r}
            </MenuItem>
          ))}
        </Select>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancelar
        </Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? <CircularProgress size={18} /> : "Salvar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DeleteUserDialog({
  user,
  open,
  onClose,
}: {
  user: User;
  open: boolean;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await usersStore.deleteUser(user.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao remover");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Remover usuário</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        <Typography>
          Tem certeza que deseja remover <strong>{user.name}</strong> ({user.email})?
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={deleting}>
          Cancelar
        </Button>
        <Button onClick={handleDelete} color="error" variant="contained" disabled={deleting}>
          {deleting ? <CircularProgress size={18} /> : "Remover"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const TenantUsersPage = observer(function TenantUsersPage() {
  const [editTarget, setEditTarget] = useState<User | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);

  useEffect(() => {
    usersStore.loadUsers();
  }, []);

  const canManage =
    authStore.user?.role === "tenant_admin" ||
    authStore.user?.role === "zentriz_admin";

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Usuários do tenant
      </Typography>

      {usersStore.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {usersStore.error}
        </Alert>
      )}

      {usersStore.loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <TableContainer component={Paper} sx={{ mt: 2 }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Nome</TableCell>
                <TableCell>E-mail</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Status</TableCell>
                {canManage && <TableCell align="right">Ações</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {usersStore.users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.name}</TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>{u.role}</TableCell>
                  <TableCell>{u.status}</TableCell>
                  {canManage && (
                    <TableCell align="right">
                      <Tooltip title="Editar">
                        <IconButton size="small" onClick={() => setEditTarget(u)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Remover">
                        <span>
                          <IconButton
                            size="small"
                            color="error"
                            disabled={u.id === authStore.user?.id}
                            onClick={() => setDeleteTarget(u)}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {usersStore.users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canManage ? 5 : 4} align="center">
                    Nenhum usuário encontrado.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {editTarget && (
        <EditUserDialog
          user={editTarget}
          open
          onClose={() => setEditTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteUserDialog
          user={deleteTarget}
          open
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </Box>
  );
});

export default TenantUsersPage;
