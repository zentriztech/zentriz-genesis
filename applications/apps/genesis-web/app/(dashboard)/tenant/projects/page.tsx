"use client";

import { observer } from "mobx-react-lite";
import { useRouter } from "next/navigation";
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

function TenantProjectsPageInner() {
  const router = useRouter();
  const projects = projectsStore.list;

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Projetos do tenant</Typography>
      <TableContainer component={Paper} sx={{ mt: 2 }}>
        <Table>
          <TableHead><TableRow><TableCell>Título</TableCell><TableCell>Status</TableCell><TableCell>Atualizado</TableCell><TableCell align="right">Ações</TableCell></TableRow></TableHead>
          <TableBody>
            {projects.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.title}</TableCell>
                <TableCell><Chip label={p.status} size="small" /></TableCell>
                <TableCell>{new Date(p.updatedAt).toLocaleDateString("pt-BR")}</TableCell>
                <TableCell align="right"><Button size="small" onClick={() => router.push(`/projects/${p.id}`)}>Ver</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export default observer(TenantProjectsPageInner);
