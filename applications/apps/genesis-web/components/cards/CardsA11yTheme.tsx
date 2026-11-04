"use client";
import { useMemo } from "react";
import { ThemeProvider, createTheme, type Theme } from "@mui/material/styles";

/** Cor de texto de destaque com contraste ≥ 4,5:1 nos dois temas (a cor `primary.main` do portal dá ~4,3:1 no escuro e ~4,5:1 por pouco no claro). */
export const accentColor = (t: Theme): string => (t.palette.mode === "dark" ? t.palette.primary.light : t.palette.primary.dark);
/** Texto de erro/bloqueio com contraste ≥ 4,5:1 (o `error.main` do tema claro dá ~3,8:1 sobre branco). */
export const errorTextColor = (t: Theme): string => (t.palette.mode === "dark" ? t.palette.error.light : t.palette.error.dark);

/**
 * Ajustes de contraste e de alvo (WCAG 2.2: 1.4.3 e 2.5.8) restritos às telas de cards: links, botões de texto/contorno e aba selecionada
 * usam o destaque acessível; o chip “Pronto” usa o primário escuro. Não altera o tema global do portal (login etc.).
 */
export function CardsA11yTheme({ children }: { children: React.ReactNode }) {
  const make = useMemo(() => (outer: Theme) => createTheme(outer, {
    components: {
      // Foco visível (2.4.7): anel de 2 px no destaque acessível em todo controle “ButtonBase” (botões, abas, chips, links).
      MuiButtonBase: {
        styleOverrides: {
          root: ({ theme }: { theme: Theme }) => ({ "&.Mui-focusVisible": { outline: "2px solid", outlineColor: accentColor(theme), outlineOffset: 2 } }),
        },
      },
      MuiLink: { styleOverrides: { root: ({ theme }: { theme: Theme }) => ({ color: accentColor(theme), textUnderlineOffset: "2px", "&:focus-visible": { outline: "2px solid", outlineColor: accentColor(theme), outlineOffset: 2 } }) } },
      MuiButton: {
        styleOverrides: {
          outlinedPrimary: ({ theme }: { theme: Theme }) => ({ color: accentColor(theme), borderColor: accentColor(theme) }),
          textPrimary: ({ theme }: { theme: Theme }) => ({ color: accentColor(theme) }),
          outlinedError: ({ theme }: { theme: Theme }) => (theme.palette.mode === "light" ? { color: theme.palette.error.dark, borderColor: theme.palette.error.dark } : {}),
          // O botão “contained” do tema global usa degradê cuja parada mais clara dá ~4,47:1 com o texto branco (< 4,5:1): cor sólida escura.
          containedPrimary: ({ theme }: { theme: Theme }) => ({ "&:not(.Mui-disabled)": { backgroundImage: "none", backgroundColor: theme.palette.primary.dark, color: "#fff", "&:hover": { backgroundColor: theme.palette.primary.main } } }),
          sizeSmall: { minHeight: 32 },
        },
      },
      // Rótulo de campo em foco: o primário do tema escuro dá ~4,29:1 sobre o fundo (< 4,5:1).
      MuiInputLabel: { styleOverrides: { root: ({ theme }: { theme: Theme }) => ({ "&.Mui-focused:not(.Mui-error)": { color: accentColor(theme) } }) } },
      MuiTab: { styleOverrides: { root: ({ theme }: { theme: Theme }) => ({ "&.Mui-selected": { color: accentColor(theme) } }) } },
      MuiChip: { styleOverrides: {
        // No tema claro o texto dos chips de contorno (verde/âmbar/azul) fica abaixo de 4,5:1: usa a variante escura.
        outlinedInfo: ({ theme }: { theme: Theme }) => (theme.palette.mode === "light" ? { color: theme.palette.info.dark } : {}),
        outlinedWarning: ({ theme }: { theme: Theme }) => (theme.palette.mode === "light" ? { color: theme.palette.warning.dark } : {}),
        outlinedSuccess: ({ theme }: { theme: Theme }) => (theme.palette.mode === "light" ? { color: theme.palette.success.dark } : {}),
        filledPrimary: ({ theme }: { theme: Theme }) => ({ backgroundColor: theme.palette.primary.dark, color: "#fff" }),
      } },
    },
  }), []);
  return <ThemeProvider theme={make}>{children}</ThemeProvider>;
}
