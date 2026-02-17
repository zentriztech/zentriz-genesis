"use client";

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

const tenants = [
  { id: "t1", name: "Tenant Demo", plan: "Ouro", status: "active" },
  { id: "t2", name: "Acme Corp", plan: "Diamante", status: "active" },
];

export default function ZentrizTenantsPage() {
  return (
    <Box>
      <Typography variant="h4" gutterBottom>Gestão de tenants</Typography>
      <TableContainer component={Paper} sx={{ mt: 2 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Nome</TableCell>
              <TableCell>Plano</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Ações</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {tenants.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.name}</TableCell>
                <TableCell>{t.plan}</TableCell>
                <TableCell><Chip label={t.status} size="small" color="success" /></TableCell>
                <TableCell align="right"><Button size="small">Editar</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
