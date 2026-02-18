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

const users = [
  { id: "u1", email: "admin@zentriz.com", tenant: "—", role: "zentriz_admin", status: "active" },
  { id: "u2", email: "user@tenant.com", tenant: "Tenant Demo", role: "user", status: "active" },
];

export default function ZentrizUsersPage() {
  return (
    <Box>
      <Typography variant="h4" gutterBottom>Gestão de usuários</Typography>
      <TableContainer component={Paper} sx={{ mt: 2 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>E-mail</TableCell>
              <TableCell>Tenant</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Ações</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.email}</TableCell>
                <TableCell>{u.tenant}</TableCell>
                <TableCell><Chip label={u.role} size="small" /></TableCell>
                <TableCell><Chip label={u.status} size="small" /></TableCell>
                <TableCell align="right"><Button size="small">Editar</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
