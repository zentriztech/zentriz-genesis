"use client";

import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import Box from "@mui/material/Box";
import FormControl from "@mui/material/FormControl";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Tooltip from "@mui/material/Tooltip";
import Chip from "@mui/material/Chip";
import BusinessIcon from "@mui/icons-material/Business";
import { authStore } from "@/stores/authStore";
import { tenantsStore } from "@/stores/tenantsStore";
import { tenantScopeStore } from "@/stores/tenantScopeStore";

/**
 * Seletor de tenant no topo (AppBar) — visível SÓ para o master (zentriz_admin).
 * Escolhe de qual tenant ver/gerenciar os dados (specs, projetos, usuários...).
 * A escolha é lembrada entre telas (tenantScopeStore → localStorage).
 * "Todos os tenants" (valor vazio) = visão global sem filtro.
 */
function TenantSelectorInner() {
  // Só o master escolhe escopo; demais papeis já são escopados pelo backend.
  const isMaster = authStore.isZentrizAdmin;

  useEffect(() => {
    if (isMaster && tenantsStore.tenants.length === 0 && !tenantsStore.loading) {
      tenantsStore.load();
    }
  }, [isMaster]);

  if (!isMaster) return null;

  const value = tenantScopeStore.selectedTenantId ?? "";
  const selected = tenantScopeStore.selectedTenantId
    ? tenantsStore.getById(tenantScopeStore.selectedTenantId)
    : null;

  return (
    <Tooltip title="Escopo de tenant — filtra specs, projetos e usuários">
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mr: { xs: 0.5, md: 1.5 } }}>
        <BusinessIcon sx={{ fontSize: 18, color: "rgba(255,255,255,0.85)", display: { xs: "none", sm: "block" } }} />
        <FormControl size="small" variant="standard" sx={{ minWidth: { xs: 120, sm: 170 } }}>
          <Select
            value={value}
            onChange={(e) => tenantScopeStore.setSelected(e.target.value || null)}
            disableUnderline
            displayEmpty
            renderValue={(v) => {
              if (!v) return "Todos os tenants";
              return tenantsStore.getById(v as string)?.name ?? "Tenant";
            }}
            sx={{
              color: "#fff",
              fontSize: "0.875rem",
              fontWeight: 600,
              "& .MuiSelect-icon": { color: "rgba(255,255,255,0.85)" },
              "& .MuiSelect-select": { py: 0.25, pr: 3 },
            }}
            MenuProps={{ PaperProps: { sx: { maxHeight: 420, mt: 0.5 } } }}
          >
            <MenuItem value="">
              <em>Todos os tenants</em>
            </MenuItem>
            {tenantsStore.tenants.map((t) => (
              <MenuItem key={t.id} value={t.id}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%" }}>
                  <span>{t.name}</span>
                  {t.status !== "active" && (
                    <Chip
                      label={t.status === "inactive" ? "inativo" : "suspenso"}
                      size="small"
                      color="warning"
                      sx={{ height: 18, fontSize: "0.65rem", ml: "auto" }}
                    />
                  )}
                </Box>
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {selected && selected.status !== "active" && (
          <Chip label="inativo" size="small" color="warning" sx={{ height: 20, fontSize: "0.65rem" }} />
        )}
      </Box>
    </Tooltip>
  );
}

export const TenantSelector = observer(TenantSelectorInner);
