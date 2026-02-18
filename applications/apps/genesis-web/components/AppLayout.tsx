"use client";

import { observer } from "mobx-react-lite";
import { usePathname, useRouter } from "next/navigation";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import AccountCircle from "@mui/icons-material/AccountCircle";
import Dashboard from "@mui/icons-material/Dashboard";
import Folder from "@mui/icons-material/Folder";
import Notifications from "@mui/icons-material/Notifications";
import People from "@mui/icons-material/People";
import Send from "@mui/icons-material/Send";
import Settings from "@mui/icons-material/Settings";
import Business from "@mui/icons-material/Business";
import { useState } from "react";
import { authStore } from "@/stores/authStore";
import { notificationsStore } from "@/stores/notificationsStore";

const DRAWER_WIDTH = 260;

const navUser = [
  { label: "Dashboard", href: "/dashboard", icon: <Dashboard /> },
  { label: "Enviar spec", href: "/spec", icon: <Send /> },
  { label: "Meus projetos", href: "/projects", icon: <Folder /> },
  { label: "Notificações", href: "/notifications", icon: <Notifications /> },
];

const navTenantAdmin = [
  ...navUser,
  { label: "Usuários do tenant", href: "/tenant/users", icon: <People /> },
  { label: "Projetos do tenant", href: "/tenant/projects", icon: <Folder /> },
  { label: "Plano e uso", href: "/tenant/plan", icon: <Settings /> },
];

const navZentriz = [
  { label: "Dashboard", href: "/dashboard", icon: <Dashboard /> },
  { label: "Tenants", href: "/zentriz/tenants", icon: <Business /> },
  { label: "Usuários", href: "/zentriz/users", icon: <People /> },
  { label: "Projetos", href: "/zentriz/projects", icon: <Folder /> },
  { label: "Controle por plano", href: "/zentriz/plans", icon: <Settings /> },
];

function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const nav =
    authStore.isZentrizAdmin ? navZentriz : authStore.isTenantAdmin ? navTenantAdmin : navUser;

  const handleMenu = (event: React.MouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget);
  const handleClose = () => setAnchorEl(null);
  const handleLogout = () => {
    authStore.logout();
    handleClose();
    router.push("/login");
  };

  return (
    <Box sx={{ display: "flex" }}>
      <AppBar
        position="fixed"
        sx={{
          zIndex: (theme) => theme.zIndex.drawer + 1,
          backgroundColor: "#0d47a1",
        }}
      >
        <Toolbar>
          <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1, fontWeight: 600 }}>
            Genesis
          </Typography>
          <Typography variant="body2" sx={{ opacity: 0.9, mr: 1 }}>
            genesis.zentriz.com.br
          </Typography>
          <IconButton
            size="large"
            aria-label="notifications"
            color="inherit"
            onClick={() => router.push("/notifications")}
          >
            <Box sx={{ position: "relative" }}>
              <Notifications />
              {notificationsStore.unreadCount > 0 && (
                <Box
                  sx={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    fontSize: 10,
                    background: "red",
                    color: "white",
                    borderRadius: 1,
                    minWidth: 16,
                    textAlign: "center",
                  }}
                >
                  {notificationsStore.unreadCount}
                </Box>
              )}
            </Box>
          </IconButton>
          <IconButton size="large" onClick={handleMenu} color="inherit">
            <AccountCircle />
          </IconButton>
          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleClose}
            anchorOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <MenuItem disabled>{authStore.user?.email}</MenuItem>
            <MenuItem onClick={handleLogout}>Sair</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          "& .MuiDrawer-paper": {
            width: DRAWER_WIDTH,
            boxSizing: "border-box",
            top: 64,
          },
        }}
      >
        <List sx={{ "& .MuiListItemButton-root": { borderRadius: 1, mx: 1, "&:hover": { bgcolor: "action.hover" } } }}>
          {nav.map((item) => (
            <ListItemButton
              key={item.href}
              selected={pathname === item.href}
              onClick={() => router.push(item.href)}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: 3,
          mt: 8,
          ml: `10px`,
          minHeight: "100vh",
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

export const AppLayout = observer(AppLayoutInner);
