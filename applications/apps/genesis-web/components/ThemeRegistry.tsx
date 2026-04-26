"use client";

import * as React from "react";
import { observer } from "mobx-react-lite";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { themeStore } from "@/stores/themeStore";

// ── Paleta comum ────────────────────────────────────────────────────────────
const PRIMARY   = "#6366F1"; // indigo
const PRIMARY_D = "#4F46E5";
const SUCCESS   = "#10B981"; // emerald
const WARNING   = "#F59E0B";
const ERROR_C   = "#EF4444";
const FONT      = '"Inter", "Roboto", "Helvetica", "Arial", sans-serif';

// ── Dark theme ───────────────────────────────────────────────────────────────
const darkTheme = createTheme({
  palette: {
    mode: "dark",
    primary:    { main: PRIMARY, dark: PRIMARY_D, contrastText: "#fff" },
    secondary:  { main: SUCCESS },
    success:    { main: SUCCESS },
    warning:    { main: WARNING },
    error:      { main: ERROR_C },
    background: { default: "#0D0F14", paper: "#161B22" },
    divider:    "#30363D",
    text: {
      primary:   "#E6EDF3",
      secondary: "#8B949E",
    },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: FONT,
    h4: { fontWeight: 700, letterSpacing: "-0.02em" },
    h5: { fontWeight: 700, letterSpacing: "-0.01em" },
    h6: { fontWeight: 600 },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 600, fontSize: "0.8rem" },
    caption:   { fontSize: "0.72rem" },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { scrollbarColor: "#30363D #161B22", scrollbarWidth: "thin" },
        "*::-webkit-scrollbar":       { width: 6, height: 6 },
        "*::-webkit-scrollbar-track": { background: "#161B22" },
        "*::-webkit-scrollbar-thumb": { background: "#30363D", borderRadius: 3 },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          border: "1px solid #30363D",
          boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        },
      },
    },
    MuiPaper: {
      styleOverrides: { root: { backgroundImage: "none" } },
    },
    MuiButton: {
      styleOverrides: {
        root: { textTransform: "none", borderRadius: 6, fontWeight: 500 },
        containedPrimary: {
          background: `linear-gradient(135deg, ${PRIMARY} 0%, ${PRIMARY_D} 100%)`,
          boxShadow: `0 0 0 0 ${PRIMARY}40`,
          "&:hover": { boxShadow: `0 4px 16px ${PRIMARY}60` },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 6 },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: { fontWeight: 600, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "#8B949E" },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          "&.Mui-selected": {
            background: `${PRIMARY}22`,
            color: PRIMARY,
            "& .MuiListItemIcon-root": { color: PRIMARY },
          },
          "&:hover": { background: "#21262D" },
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: { background: "#0D1117", borderRight: "1px solid #21262D" },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: { background: "#0D1117", borderBottom: "1px solid #21262D", boxShadow: "none" },
      },
    },
    MuiDivider: {
      styleOverrides: { root: { borderColor: "#21262D" } },
    },
    MuiInputBase: {
      styleOverrides: {
        root: {
          "& fieldset": { borderColor: "#30363D !important" },
          "&:hover fieldset": { borderColor: `${PRIMARY} !important` },
        },
      },
    },
  },
});

// ── Light theme ──────────────────────────────────────────────────────────────
const lightTheme = createTheme({
  palette: {
    mode: "light",
    primary:    { main: PRIMARY, dark: PRIMARY_D, contrastText: "#fff" },
    secondary:  { main: SUCCESS },
    success:    { main: SUCCESS },
    warning:    { main: WARNING },
    error:      { main: ERROR_C },
    background: { default: "#F8FAFC", paper: "#FFFFFF" },
    divider:    "#E2E8F0",
    text: {
      primary:   "#0F172A",
      secondary: "#64748B",
    },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: FONT,
    h4: { fontWeight: 700, letterSpacing: "-0.02em" },
    h5: { fontWeight: 700, letterSpacing: "-0.01em" },
    h6: { fontWeight: 600 },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 600, fontSize: "0.8rem" },
    caption:   { fontSize: "0.72rem" },
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          border: "1px solid #E2E8F0",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { textTransform: "none", borderRadius: 6, fontWeight: 500 },
        containedPrimary: {
          background: `linear-gradient(135deg, ${PRIMARY} 0%, ${PRIMARY_D} 100%)`,
          "&:hover": { boxShadow: `0 4px 16px ${PRIMARY}40` },
        },
      },
    },
    MuiChip: {
      styleOverrides: { root: { borderRadius: 6 } },
    },
    MuiTableCell: {
      styleOverrides: {
        head: { fontWeight: 600, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748B" },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          "&.Mui-selected": {
            background: `${PRIMARY}12`,
            color: PRIMARY_D,
            "& .MuiListItemIcon-root": { color: PRIMARY_D },
          },
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: { background: "#FFFFFF", borderRight: "1px solid #E2E8F0" },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: { background: "#FFFFFF", borderBottom: "1px solid #E2E8F0", boxShadow: "none", color: "#0F172A" },
      },
    },
  },
});

function ThemeRegistryInner({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={themeStore.isDark ? darkTheme : lightTheme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}

export default observer(ThemeRegistryInner);
