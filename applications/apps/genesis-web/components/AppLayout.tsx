"use client";

import { observer } from "mobx-react-lite";
import { usePathname, useRouter } from "next/navigation";
import AppBar from "@mui/material/AppBar";
import Avatar from "@mui/material/Avatar";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DashboardIcon from "@mui/icons-material/Dashboard";
import FolderIcon from "@mui/icons-material/Folder";
import NotificationsIcon from "@mui/icons-material/Notifications";
import PeopleIcon from "@mui/icons-material/People";
import SendIcon from "@mui/icons-material/Send";
import SettingsIcon from "@mui/icons-material/Settings";
import BusinessIcon from "@mui/icons-material/Business";
import GitHubIcon from "@mui/icons-material/GitHub";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CloudIcon from "@mui/icons-material/Cloud";
import { useState } from "react";
import { authStore } from "@/stores/authStore";
import { notificationsStore } from "@/stores/notificationsStore";
import { themeStore } from "@/stores/themeStore";

const DRAWER_WIDTH = 240;
const PRIMARY = "#6366F1";

// ── Cor de destaque por seção ────────────────────────────────────────────────
const navUser = [
  { label: "Dashboard",     href: "/dashboard",      icon: <DashboardIcon />,    color: "#6366F1" },
  { label: "Enviar spec",   href: "/spec",            icon: <SendIcon />,         color: "#10B981" },
  { label: "Meus projetos", href: "/projects",        icon: <FolderIcon />,       color: "#F59E0B" },
  { label: "Notificações",  href: "/notifications",   icon: <NotificationsIcon />,color: "#EF4444" },
];

const navTenantAdmin = [
  ...navUser,
  { label: "Usuários",      href: "/tenant/users",    icon: <PeopleIcon />,       color: "#8B5CF6" },
  { label: "Projetos",      href: "/tenant/projects", icon: <FolderIcon />,       color: "#F59E0B" },
  { label: "Plano e uso",   href: "/tenant/plan",     icon: <SettingsIcon />,     color: "#64748B" },
  { label: "GitHub",        href: "/settings/github", icon: <GitHubIcon />,       color: "#E2E8F0" },
  { label: "Cloud Deploy",  href: "/settings/cloud",  icon: <CloudIcon />,        color: "#10B981" },
];

const navZentriz = [
  { label: "Dashboard",     href: "/dashboard",         icon: <DashboardIcon />,  color: "#6366F1" },
  { label: "Tenants",       href: "/zentriz/tenants",   icon: <BusinessIcon />,   color: "#10B981" },
  { label: "Usuários",      href: "/zentriz/users",     icon: <PeopleIcon />,     color: "#8B5CF6" },
  { label: "Projetos",      href: "/zentriz/projects",  icon: <FolderIcon />,     color: "#F59E0B" },
  { label: "Planos",        href: "/zentriz/plans",     icon: <SettingsIcon />,   color: "#64748B" },
  { label: "GitHub",        href: "/settings/github",   icon: <GitHubIcon />,     color: "#E2E8F0" },
];

function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname  = usePathname();
  const router    = useRouter();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const nav = authStore.isZentrizAdmin ? navZentriz : authStore.isTenantAdmin ? navTenantAdmin : navUser;

  const handleMenu   = (e: React.MouseEvent<HTMLElement>) => setAnchorEl(e.currentTarget);
  const handleClose  = () => setAnchorEl(null);
  const handleLogout = () => { authStore.logout(); handleClose(); router.push("/login"); };

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      {/* ── AppBar ─────────────────────────────────────────────────────────── */}
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar sx={{ gap: 1 }}>
          {/* Logo */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mr: 2 }}>
            <Box
              sx={{
                width: 28, height: 28, borderRadius: "8px",
                background: `linear-gradient(135deg, ${PRIMARY} 0%, #4F46E5 100%)`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <AutoAwesomeIcon sx={{ fontSize: 16, color: "#fff" }} />
            </Box>
            <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: "-0.02em", flexGrow: 1 }}>
              Genesis
            </Typography>
          </Box>

          <Box sx={{ flexGrow: 1 }} />

          {/* Theme toggle */}
          <Tooltip title={themeStore.isDark ? "Tema claro" : "Tema escuro"}>
            <IconButton size="small" onClick={() => themeStore.toggle()} color="inherit">
              {themeStore.isDark ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
            </IconButton>
          </Tooltip>

          {/* Notifications */}
          <Tooltip title="Notificações">
            <IconButton size="small" color="inherit" onClick={() => router.push("/notifications")}>
              <Badge
                badgeContent={notificationsStore.unreadCount}
                color="error"
                sx={{ "& .MuiBadge-badge": { fontSize: 9, minWidth: 14, height: 14 } }}
              >
                <NotificationsIcon fontSize="small" />
              </Badge>
            </IconButton>
          </Tooltip>

          {/* User menu */}
          <Tooltip title={authStore.user?.email ?? "Conta"}>
            <IconButton size="small" onClick={handleMenu} sx={{ p: 0.5 }}>
              <Avatar
                sx={{
                  width: 28, height: 28, fontSize: "0.75rem", fontWeight: 700,
                  background: `linear-gradient(135deg, ${PRIMARY} 0%, #4F46E5 100%)`,
                }}
              >
                {(authStore.user?.name?.[0] ?? authStore.user?.email?.[0] ?? "U").toUpperCase()}
              </Avatar>
            </IconButton>
          </Tooltip>
          <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleClose}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <MenuItem disabled sx={{ opacity: "1 !important" }}>
              <Box>
                <Typography variant="body2" fontWeight={600}>{authStore.user?.name}</Typography>
                <Typography variant="caption" color="text.secondary">{authStore.user?.email}</Typography>
              </Box>
            </MenuItem>
            <Divider />
            <MenuItem onClick={handleLogout} sx={{ color: "error.main" }}>Sair</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box", top: 56 },
        }}
      >
        {/* User info */}
        <Box sx={{ px: 2, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {authStore.isZentrizAdmin ? "Zentriz Admin" : authStore.tenant?.name ?? "Workspace"}
          </Typography>
          {authStore.tenant && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              Plano {authStore.tenant.plan.name}
            </Typography>
          )}
        </Box>

        {/* Nav items */}
        <List sx={{ px: 1, py: 1, flexGrow: 1 }}>
          {nav.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <ListItemButton
                key={item.href}
                selected={active}
                onClick={() => router.push(item.href)}
                sx={{ mb: 0.25, px: 1.5, py: 0.75 }}
              >
                <ListItemIcon
                  sx={{
                    minWidth: 32,
                    "& svg": {
                      fontSize: "1.1rem",
                      color: active ? item.color : "text.secondary",
                      transition: "color 0.15s",
                    },
                  }}
                >
                  {item.icon}
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  primaryTypographyProps={{ variant: "body2", fontWeight: active ? 600 : 400 }}
                />
                {/* Indicador ativo */}
                {active && (
                  <Box
                    sx={{
                      width: 3, height: 16, borderRadius: 2,
                      background: item.color,
                      ml: 0.5, flexShrink: 0,
                    }}
                  />
                )}
              </ListItemButton>
            );
          })}
        </List>

        {/* Rodapé */}
        <Box sx={{ px: 2, py: 1.5, borderTop: "1px solid", borderColor: "divider" }}>
          <Typography variant="caption" color="text.secondary">
            genesis.zentriz.com.br
          </Typography>
        </Box>
      </Drawer>

      {/* ── Main ───────────────────────────────────────────────────────────── */}
      <Box
        component="main"
        sx={{ flexGrow: 1, p: { xs: 2, md: 3 }, mt: "56px", minHeight: "calc(100vh - 56px)", overflow: "auto" }}
      >
        {children}
      </Box>
    </Box>
  );
}

export const AppLayout = observer(AppLayoutInner);
