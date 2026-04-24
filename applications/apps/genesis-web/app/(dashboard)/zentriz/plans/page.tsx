"use client";

import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActions from "@mui/material/CardActions";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Grid from "@mui/material/Grid";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { Plan } from "@/types";
import { plansStore, type UpdatePlanPayload } from "@/stores/plansStore";
import { authStore } from "@/stores/authStore";

function EditPlanDialog({ plan, open, onClose }: { plan: Plan; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(plan.name);
  const [maxProjects, setMaxProjects] = useState(String(plan.maxProjects));
  const [maxUsers, setMaxUsers] = useState(String(plan.maxUsersPerTenant));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload: UpdatePlanPayload = {};
      if (name !== plan.name) payload.name = name;
      const mp = parseInt(maxProjects, 10);
      const mu = parseInt(maxUsers, 10);
      if (!isNaN(mp) && mp !== plan.maxProjects) payload.maxProjects = mp;
      if (!isNaN(mu) && mu !== plan.maxUsersPerTenant) payload.maxUsersPerTenant = mu;
      await plansStore.update(plan.id, payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Editar plano — {plan.name}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField label="Nome" value={name} onChange={(e) => setName(e.target.value)} fullWidth />
        <TextField label="Máx. projetos" type="number" value={maxProjects} onChange={(e) => setMaxProjects(e.target.value)} fullWidth />
        <TextField label="Máx. usuários por tenant" type="number" value={maxUsers} onChange={(e) => setMaxUsers(e.target.value)} fullWidth />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? <CircularProgress size={18} /> : "Salvar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const ZentrizPlansPage = observer(function ZentrizPlansPage() {
  const [editTarget, setEditTarget] = useState<Plan | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    plansStore.load();
  }, []);

  const isAdmin = authStore.user?.role === "zentriz_admin";

  async function handleDelete(id: string) {
    setDeleteError(null);
    try {
      await plansStore.remove(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Erro ao remover plano");
    }
  }

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Controle por plano</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Limites e benefícios por plano.
      </Typography>

      {plansStore.error && <Alert severity="error" sx={{ mb: 2 }}>{plansStore.error}</Alert>}
      {deleteError && <Alert severity="error" sx={{ mb: 2 }}>{deleteError}</Alert>}

      {plansStore.loading && plansStore.plans.length === 0 ? (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Grid container spacing={2}>
          {plansStore.plans.map((plan) => (
            <Grid size={{ xs: 12, md: 4 }} key={plan.id}>
              <Card>
                <CardContent>
                  <Typography variant="h6">{plan.name}</Typography>
                  <Typography variant="body2" color="text.secondary">slug: {plan.slug}</Typography>
                  <Typography variant="body2">Projetos máx.: {plan.maxProjects}</Typography>
                  <Typography variant="body2">Usuários por tenant: {plan.maxUsersPerTenant}</Typography>
                </CardContent>
                {isAdmin && (
                  <CardActions>
                    <Button size="small" onClick={() => setEditTarget(plan)}>Editar</Button>
                    <Button size="small" color="error" onClick={() => handleDelete(plan.id)}>Remover</Button>
                  </CardActions>
                )}
              </Card>
            </Grid>
          ))}
        </Grid>
      )}

      {editTarget && (
        <EditPlanDialog plan={editTarget} open onClose={() => setEditTarget(null)} />
      )}
    </Box>
  );
});

export default ZentrizPlansPage;
