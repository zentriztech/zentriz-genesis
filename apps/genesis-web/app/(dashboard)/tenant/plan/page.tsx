"use client";

import { observer } from "mobx-react-lite";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import { authStore } from "@/stores/authStore";
import { projectsStore } from "@/stores/projectsStore";

function TenantPlanPageInner() {
  const tenant = authStore.tenant;
  const plan = tenant?.plan;
  const projects = projectsStore.list;
  const activeCount = projects.filter((p) => p.status !== "completed" && p.status !== "failed").length;
  const maxProjects = plan?.maxProjects ?? 0;
  const usage = maxProjects ? Math.min(100, (activeCount / maxProjects) * 100) : 0;

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Plano e uso</Typography>
      <Card sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="h6">Plano atual: {plan?.name ?? "—"}</Typography>
          <Typography variant="body2" color="text.secondary">Projetos ativos: {activeCount} / {maxProjects}</Typography>
          <LinearProgress variant="determinate" value={usage} sx={{ mt: 1, height: 8, borderRadius: 1 }} />
        </CardContent>
      </Card>
    </Box>
  );
}

export default observer(TenantPlanPageInner);
