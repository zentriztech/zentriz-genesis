"use client";

import { useParams, useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Typography from "@mui/material/Typography";
import { projectsStore } from "@/stores/projectsStore";

const STEPS = ["Spec enviada", "CTO (Charter)", "PM (Backlog)", "Dev/QA/Monitor", "DevOps", "Concluído"];

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const project = projectsStore.getById(id);

  if (!project) {
    return (
      <Box>
        <Typography>Projeto não encontrado.</Typography>
        <Button onClick={() => router.push("/projects")}>Voltar</Button>
      </Box>
    );
  }

  const stepIndex =
    project.status === "spec_submitted"
      ? 1
      : project.status === "cto_charter"
        ? 2
        : project.status === "pm_backlog"
          ? 3
          : project.status === "dev_qa"
            ? 4
            : project.status === "devops"
              ? 5
              : project.status === "completed"
                ? 6
                : 0;

  return (
    <Box>
      <Button onClick={() => router.push("/projects")} sx={{ mb: 2 }}>
        ← Voltar
      </Button>
      <Typography variant="h4" gutterBottom>
        {project.title}
      </Typography>
      <Chip label={project.status} color={project.status === "completed" ? "success" : "default"} sx={{ mb: 2 }} />
      <Typography variant="body2" color="text.secondary">
        Spec: {project.specRef} • Criado em {new Date(project.createdAt).toLocaleString("pt-BR")}
      </Typography>
      <Stepper activeStep={stepIndex} sx={{ mt: 3, mb: 3 }}>
        {STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>
      {project.charterSummary && (
        <Card sx={{ mt: 2 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Charter (CTO)
            </Typography>
            <Typography variant="body2">{project.charterSummary}</Typography>
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
