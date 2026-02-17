"use client";

import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid";
import Typography from "@mui/material/Typography";
import { PLANS } from "@/stores/authStore";

export default function ZentrizPlansPage() {
  return (
    <Box>
      <Typography variant="h4" gutterBottom>Controle por plano</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Prata, Ouro e Diamante — limites e benefícios por plano.
      </Typography>
      <Grid container spacing={2}>
        {PLANS.map((plan) => (
          <Grid size={{ xs: 12, md: 4 }} key={plan.id}>
            <Card>
              <CardContent>
                <Typography variant="h6">{plan.name}</Typography>
                <Typography variant="body2">Projetos máx.: {plan.maxProjects}</Typography>
                <Typography variant="body2">Usuários por tenant: {plan.maxUsersPerTenant}</Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
