"use client";

// ActionOverflowBar — barra de ações que COLAPSA em um ícone quando a tela é pequena.
//
// Pedido do Jean (2026-09-09): na Bancada, os comandos [Relatórios (PDF) | Modo autônomo |
// Descartar | Salvar rascunho | Promover à fábrica] exibidos todos ao mesmo tempo QUEBRAM o layout
// no mobile. Abaixo do breakpoint eles passam a viver em um menu de ícone (⋮).
//
// A regra é FONTE ÚNICA: quem usa declara cada ação UMA vez (`actions`) e este componente decide a
// forma — botão na barra (≥ breakpoint) ou item de menu (< breakpoint). Duplicar rótulo/handler nos
// dois ramos era o jeito óbvio e o errado: na primeira mudança de rótulo os dois divergiriam e o
// mobile passaria a mentir sobre o que o botão faz.

import { useState } from "react";
import Box from "@mui/material/Box";
import Button, { type ButtonProps } from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import MoreVertIcon from "@mui/icons-material/MoreVert";

export interface BarAction {
  key: string;
  /** Rótulo — o MESMO no botão e no item de menu (inclusive o estado "Salvando…"). */
  label: string;
  icon?: React.ReactNode;
  /** Explicação; no menu vira linha secundária (onde o tooltip do dedo não existe). */
  tooltip?: string;
  disabled?: boolean;
  /** Em andamento: troca o ícone por spinner nas duas formas. */
  busy?: boolean;
  variant?: ButtonProps["variant"];
  color?: ButtonProps["color"];
  /**
   * `anchorEl` é o elemento clicado (botão no desktop, item de menu no mobile) — quem abre um menu
   * próprio ancora nele, em vez de adivinhar uma posição.
   */
  onClick: (anchorEl: HTMLElement) => void;
  /**
   * Só aparece quando a barra está COLAPSADA. Para controles que no desktop já têm forma própria em
   * `leading` (ex.: relatórios em PDF) — sem isso, o comando apareceria duas vezes lado a lado.
   */
  mobileOnly?: boolean;
}

interface Props {
  actions: BarAction[];
  /** Controle com gatilho próprio (ex.: TraceabilityReportsButton), exibido só no desktop. */
  leading?: React.ReactNode;
  /** Abaixo deste breakpoint tudo colapsa no ícone. */
  breakpoint?: "sm" | "md" | "lg";
  ariaLabel?: string;
}

export default function ActionOverflowBar({
  actions, leading, breakpoint = "md", ariaLabel = "Ações",
}: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const naBarra = actions.filter((a) => !a.mobileOnly);
  // Chave computada de breakpoint fora do `sx` — inline, o TS alarga o objeto e recusa o literal.
  const displayBarra: Record<string, string> = { xs: "none", [breakpoint]: "flex" };
  const displayIcone: Record<string, string> = { xs: "flex", [breakpoint]: "none" };

  return (
    <>
      {/* ≥ breakpoint: a barra completa, como sempre foi. */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ display: displayBarra }}>
        {leading}
        {naBarra.map((a) => {
          const botao = (
            <Button
              size="small" variant={a.variant ?? "text"} color={a.color ?? "inherit"}
              disabled={a.disabled} onClick={(e) => a.onClick(e.currentTarget)}
              startIcon={a.busy ? <CircularProgress size={14} color="inherit" /> : a.icon}
              sx={{ textTransform: "none" }}
            >
              {a.label}
            </Button>
          );
          // `span` porque botão desabilitado não emite eventos de mouse (tooltip morreria).
          return a.tooltip
            ? <Tooltip key={a.key} title={a.tooltip}><span>{botao}</span></Tooltip>
            : <Box key={a.key} component="span">{botao}</Box>;
        })}
      </Stack>

      {/* < breakpoint: um ícone só. */}
      <Box sx={{ display: displayIcone, alignItems: "center" }}>
        <Tooltip title={ariaLabel}>
          <IconButton size="small" aria-label={ariaLabel} onClick={(e) => setAnchor(e.currentTarget)}>
            <MoreVertIcon sx={{ fontSize: "1.2rem" }} />
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
          slotProps={{ paper: { sx: { maxWidth: 320 } } }}
        >
          {actions.map((a, i) => (
            <MenuItem
              key={a.key} disabled={a.disabled}
              // O anchor entregue é o ÍCONE da barra, não o item: o item desaparece com o menu, e um
              // menu ancorado em nó desmontado pula para o canto da tela.
              onClick={() => { setAnchor(null); a.onClick(anchor ?? document.body); }}
              sx={{ alignItems: "flex-start", py: 1, ...(i > 0 && a.mobileOnly !== actions[i - 1]?.mobileOnly ? { borderTop: "1px solid", borderColor: "divider" } : {}) }}
            >
              <ListItemIcon sx={{ minWidth: 32, mt: 0.25 }}>
                {a.busy ? <CircularProgress size={14} color="inherit" /> : a.icon}
              </ListItemIcon>
              <ListItemText
                primary={<Typography variant="body2" fontWeight={a.variant === "contained" ? 700 : 500}>{a.label}</Typography>}
                secondary={a.tooltip
                  ? (
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.4, whiteSpace: "normal" }}>
                      {a.tooltip}
                    </Typography>
                  )
                  : null}
              />
            </MenuItem>
          ))}
        </Menu>
      </Box>
    </>
  );
}
