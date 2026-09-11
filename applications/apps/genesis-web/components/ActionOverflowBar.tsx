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
  /**
   * NUNCA colapsa: abaixo do breakpoint continua clicável, como ícone (com tooltip e `aria-label`),
   * fora do menu. Reservado à ação do caminho crítico — colapsar o "Salvar" custaria um clique a
   * mais na operação mais frequente da tela. Exige `icon`; sem ele, cai no menu como as demais.
   */
  keepInBar?: boolean;
  /**
   * A ação primária do contexto: colapsada, continua sendo um BOTÃO com rótulo (não vira ícone nem
   * item de menu). Diferente de `keepInBar`, que preserva o alvo mas troca o rótulo por ícone —
   * aqui o que importa é o usuário LER qual é o próximo passo (ex.: "Normalizar" antes de
   * "Promover"). Só faz sentido uma por barra; se houver mais, todas viram botão.
   */
  primary?: boolean;
}

interface Props {
  actions: BarAction[];
  /** Controle com gatilho próprio (ex.: TraceabilityReportsButton), exibido só no desktop. */
  leading?: React.ReactNode;
  /**
   * Abaixo deste breakpoint tudo colapsa no ícone. `"always"` = colapsado em QUALQUER largura:
   * é o caso de ação dentro de card de grade, onde a estreiteza vem do card (≈300 px numa grade de
   * 3 colunas) e não do viewport — esperar o breakpoint do viewport ali empilharia botões
   * `fullWidth` um por linha mesmo num monitor de 1440 px.
   */
  breakpoint?: "sm" | "md" | "lg" | "always";
  ariaLabel?: string;
}

export default function ActionOverflowBar({
  actions, leading, breakpoint = "md", ariaLabel = "Ações",
}: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const naBarra = actions.filter((a) => !a.mobileOnly);
  // Quando colapsado: estas continuam na barra — `primarias` com rótulo, `fixas` como ícone — e por
  // isso saem do menu (duplicar o mesmo comando lado a lado é o defeito que este componente existe
  // para evitar).
  const primarias = actions.filter((a) => a.primary);
  const fixas = actions.filter((a) => !a.primary && a.keepInBar && a.icon);
  const noMenu = actions.filter((a) => !fixas.includes(a) && !primarias.includes(a));
  // Chave computada de breakpoint fora do `sx` — inline, o TS alarga o objeto e recusa o literal.
  const sempreColapsado = breakpoint === "always";
  const displayBarra: Record<string, string> = sempreColapsado
    ? { xs: "none" } : { xs: "none", [breakpoint]: "flex" };
  const displayIcone: Record<string, string> = sempreColapsado
    ? { xs: "flex" } : { xs: "flex", [breakpoint]: "none" };

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

      {/* < breakpoint: a primária (com rótulo), as fixas como ícone, o resto no ⋮. */}
      {/* `flex: 1 1 auto` + `maxWidth: 100%`: sem isso a largura da barra é o `max-content` dos
          filhos e ela ESTOURA o card (medido: 4–5 px para fora do card de spec a 320 px quando a
          primária vira "Promover esta spec"). Com shrink permitido, quem cede é o rótulo. */}
      <Box sx={{ display: displayIcone, alignItems: "center", gap: 0.5, minWidth: 0, flex: "1 1 auto", maxWidth: "100%" }}>
        {/* Ícones primeiro, depois o botão com rótulo, depois o ⋮: a leitura vai do atalho conhecido
            para a próxima ação do fluxo, e o alvo de "mais" fica sempre no mesmo canto. */}
        {fixas.map((a) => (
          <Tooltip key={a.key} title={a.tooltip ? `${a.label} — ${a.tooltip}` : a.label}>
            {/* `span` porque botão desabilitado não emite eventos de mouse (o tooltip morreria). */}
            <span>
              <IconButton
                size="small" color={a.color ?? "inherit"} aria-label={a.label} disabled={a.disabled}
                onClick={(e) => a.onClick(e.currentTarget)} sx={{ width: 34, height: 34, mr: 0.25 }}
              >
                {a.busy ? <CircularProgress size={16} color="inherit" /> : a.icon}
              </IconButton>
            </span>
          </Tooltip>
        ))}
        {primarias.map((a) => (
          <Tooltip key={a.key} title={a.tooltip ?? ""}>
            {/* `span` porque botão desabilitado não emite eventos de mouse (o tooltip morreria). */}
            <span style={{ minWidth: 0, flex: "1 1 auto" }}>
              <Button
                fullWidth size="small" variant={a.variant ?? "contained"} color={a.color ?? "primary"}
                disabled={a.disabled} onClick={(e) => a.onClick(e.currentTarget)}
                startIcon={a.busy ? <CircularProgress size={14} color="inherit" /> : a.icon}
                sx={{ textTransform: "none", minWidth: 0 }}
              >
                {/* O rótulo encolhe com reticências em vez de empurrar o ⋮ para fora do card. O
                    texto completo continua no tooltip e no `aria-label` do botão. */}
                <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.label}
                </Box>
              </Button>
            </span>
          </Tooltip>
        ))}
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
          {noMenu.map((a, i) => (
            <MenuItem
              key={a.key} disabled={a.disabled}
              // O anchor entregue é o ÍCONE da barra, não o item: o item desaparece com o menu, e um
              // menu ancorado em nó desmontado pula para o canto da tela.
              onClick={() => { setAnchor(null); a.onClick(anchor ?? document.body); }}
              sx={{ alignItems: "flex-start", py: 1, ...(i > 0 && a.mobileOnly !== noMenu[i - 1]?.mobileOnly ? { borderTop: "1px solid", borderColor: "divider" } : {}) }}
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
