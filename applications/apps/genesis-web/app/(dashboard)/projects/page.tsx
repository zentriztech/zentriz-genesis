"use client";

import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { projectsStore } from "@/stores/projectsStore";

const rowMotion = {
  initial: { opacity: 0 },
  animate: (i: number) => ({ opacity: 1, transition: { delay: i * 0.05 } }),
};

const MotionTableRow = motion(TableRow);

function ProjectsPageInner() {
  const router = useRouter();
  const projects = projectsStore.list;

  useEffect(() => {
    projectsStore.loadProjects();
  }, []);

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Meus projetos
      </Typography>
      {projectsStore.loading && <Typography color="text.secondary">Carregando…</Typography>}
      {projectsStore.error && <Typography color="error">{projectsStore.error}</Typography>}
      <TableContainer component={Paper} sx={{ mt: 2 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Título</TableCell>
              <TableCell>Spec</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Atualizado</TableCell>
              <TableCell align="right">Ações</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {projects.map((p, i) => (
              <MotionTableRow
                key={p.id}
                initial="initial"
                animate="animate"
                variants={rowMotion}
                custom={i}
                sx={{ "&:hover": { bgcolor: "action.hover" } }}
              >
                <TableCell>{p.title ?? "Spec sem título"}</TableCell>
                <TableCell>{p.specRef}</TableCell>
                <TableCell>
                  <Chip
                  label={
                    p.status === "running"
                      ? "Em execução"
                      : p.status === "stopped"
                        ? "Parado"
                        : p.status === "failed"
                          ? "Falhou"
                          : p.status
                  }
                  size="small"
                  color={
                    p.status === "completed"
                      ? "success"
                      : p.status === "failed" || p.status === "stopped"
                        ? "error"
                        : p.status === "running"
                          ? "info"
                          : "default"
                  }
                />
                </TableCell>
                <TableCell>{new Date(p.updatedAt).toLocaleDateString("pt-BR")}</TableCell>
                <TableCell align="right">
                  <Button size="small" onClick={() => router.push(`/projects/${p.id}`)}>
                    Ver
                  </Button>
                </TableCell>
              </MotionTableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export default observer(ProjectsPageInner);
