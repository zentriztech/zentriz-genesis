"use client";

import { observer } from "mobx-react-lite";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { projectsStore } from "@/stores/projectsStore";
import { tenantsStore } from "@/stores/tenantsStore";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
import { ResourceBadges } from "@/components/ResourceBadges";

function ZentrizProjectsPageInner() {
  const router = useRouter();
  // Recarrega quando o tenant selecionado no topo muda (null = todos).
  const scopeTenantId = tenantScopeStore.selectedTenantId;
  // Rascunhos (inbox) são infra pré-fábrica, não Apps reais — ocultos por padrão (§5.2).
  const [hideInbox, setHideInbox] = useState(true);

  useEffect(() => {
    projectsStore.loadProjects();
    if (tenantsStore.tenants.length === 0) tenantsStore.load();
  }, [scopeTenantId]);

  const projects = hideInbox
    ? projectsStore.list.filter((p) => p.productIsInbox !== true)
    : projectsStore.list;

  const tenantName = (tenantId: string) =>
    tenantsStore.getById(tenantId)?.name ?? tenantId.slice(0, 8);

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Gestão global de Apps (todos os tenants)</Typography>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 1, mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {scopeTenantId
            ? `Filtrando por: ${tenantName(scopeTenantId)}`
            : "Exibindo Apps de todos os tenants — use o seletor no topo para filtrar."}
        </Typography>
        <FormControlLabel
          control={<Switch size="small" checked={hideInbox} onChange={(e) => setHideInbox(e.target.checked)} />}
          label={<Typography variant="body2" color="text.secondary">Ocultar rascunhos (inbox)</Typography>}
        />
      </Box>
      <TableContainer component={Paper} sx={{ mt: 1 }}>
        <Table sx={{ minWidth: 760 }}>
          <TableHead>
            <TableRow>
              <TableCell>Título</TableCell>
              <TableCell>Tenant</TableCell>
              <TableCell>Produto</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Recursos</TableCell>
              <TableCell>Atualizado</TableCell>
              <TableCell align="right">Ações</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {projects.map((p) => (
              <TableRow key={p.id} hover>
                <TableCell>{p.title}</TableCell>
                <TableCell>{tenantName(p.tenantId)}</TableCell>
                <TableCell>
                  {p.productIsInbox === true ? (
                    <Chip label="Rascunhos (inbox) — infra" size="small" color="warning" variant="outlined" />
                  ) : (
                    p.productName ?? <Typography variant="caption" color="text.disabled">—</Typography>
                  )}
                </TableCell>
                <TableCell><Chip label={p.status} size="small" /></TableCell>
                <TableCell><ResourceBadges repoUrl={p.repoUrl} repoFullName={p.repoFullName} deployUrl={p.deployUrl} deployStatus={p.deployStatus} backendDeployStatus={p.backendDeployStatus} /></TableCell>
                <TableCell>{new Date(p.updatedAt).toLocaleDateString("pt-BR")}</TableCell>
                <TableCell align="right"><Button size="small" onClick={() => router.push(`/projects/${p.id}`)}>Ver</Button></TableCell>
              </TableRow>
            ))}
            {projects.length === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
                    Nenhum App encontrado{scopeTenantId ? " para este tenant" : ""}.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export default observer(ZentrizProjectsPageInner);
