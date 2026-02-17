"use client";

import { observer } from "mobx-react-lite";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid";
import Typography from "@mui/material/Typography";
import { authStore } from "@/stores/authStore";
import { projectsStore } from "@/stores/projectsStore";

function DashboardPageInner() {
  const projects = projectsStore.list;
  const completed = projects.filter((p) => p.status === "completed").length;
  const active = projects.filter((p) => p.status !== "completed" && p.status !== "failed").length;

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Dashboard</Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Olá, {authStore.user?.name}. {authStore.tenant && `Tenant: ${authStore.tenant.name} (${authStore.tenant.plan.name})`}
      </Typography>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Card><CardContent><Typography color="text.secondary">Projetos ativos</Typography><Typography variant="h4">{active}</Typography></CardContent></Card>
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Card><CardContent><Typography color="text.secondary">Projetos concluídos</Typography><Typography variant="h4">{completed}</Typography></CardContent></Card>
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Card><CardContent><Typography color="text.secondary">Plano</Typography><Typography variant="h6">{authStore.tenant?.plan.name ?? "—"}</Typography></CardContent></Card>
        </Grid>
      </Grid>
    </Box>
  );
}

export default observer(DashboardPageInner);
