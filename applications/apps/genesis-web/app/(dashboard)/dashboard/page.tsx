"use client";

import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { motion } from "framer-motion";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid";
import Typography from "@mui/material/Typography";
import { authStore } from "@/stores/authStore";
import { projectsStore } from "@/stores/projectsStore";

const cardMotion = (i: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { delay: i * 0.08 } },
});

const MotionCard = motion(Card);

function DashboardPageInner() {
  const projects = projectsStore.list;
  const completed = projects.filter((p) => p.status === "completed").length;
  const active = projects.filter((p) => p.status !== "completed" && p.status !== "failed").length;

  useEffect(() => {
    projectsStore.loadProjects();
  }, []);

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Dashboard</Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Olá, {authStore.user?.name}. {authStore.tenant && `Tenant: ${authStore.tenant.name} (${authStore.tenant.plan.name})`}
      </Typography>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <MotionCard
            initial="initial"
            animate="animate"
            variants={cardMotion(0)}
            whileHover={{ y: -2 }}
            sx={{ transition: "box-shadow 0.2s" }}
          >
            <CardContent><Typography color="text.secondary">Projetos ativos</Typography><Typography variant="h4">{active}</Typography></CardContent>
          </MotionCard>
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <MotionCard
            initial="initial"
            animate="animate"
            variants={cardMotion(1)}
            whileHover={{ y: -2 }}
            sx={{ transition: "box-shadow 0.2s" }}
          >
            <CardContent><Typography color="text.secondary">Projetos concluídos</Typography><Typography variant="h4">{completed}</Typography></CardContent>
          </MotionCard>
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <MotionCard
            initial="initial"
            animate="animate"
            variants={cardMotion(2)}
            whileHover={{ y: -2 }}
            sx={{ transition: "box-shadow 0.2s" }}
          >
            <CardContent><Typography color="text.secondary">Plano</Typography><Typography variant="h6">{authStore.tenant?.plan.name ?? "—"}</Typography></CardContent>
          </MotionCard>
        </Grid>
      </Grid>
    </Box>
  );
}

export default observer(DashboardPageInner);
