"use client";

// SpecNoticeCenter — os avisos da Bancada em UMA faixa, com hierarquia.
//
// Problema medido (2026-09-11): no modo edição até 5 avisos podiam empilhar ao mesmo tempo
// (laço autônomo ativo, proposta de divisão, validação obsoleta, erro de carga, erro de ação),
// todos como <Alert> de altura cheia e peso visual semelhante. Somados, empurravam o editor
// ~200px para baixo — no mobile, para fora da tela.
//
// A revisão adversarial VETOU esconder aviso atrás de clique: perder de vista "há um laço
// rodando" faz o usuário editar por cima e derrubar a rodada. Então aqui NADA some.
// O que muda é HIERARQUIA (NN/g): o aviso mais severo mantém a forma de Alert completo; os
// demais viram linhas compactas — visíveis, legíveis, acionáveis, mas sem competir pelo olhar.

import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";

export type NoticeSeverity = "error" | "warning" | "info";

export interface SpecNotice {
  key: string;
  severity: NoticeSeverity;
  /** Texto do aviso. Curto: a linha compacta mostra tudo, sem truncar. */
  text: React.ReactNode;
  /** Destaque opcional no início (vira <AlertTitle> na forma completa, negrito na compacta). */
  title?: string;
  /** Ação única do aviso (ex.: "Ver detalhes"). */
  actionLabel?: string;
  onAction?: () => void;
  /** Quando presente, o aviso é dispensável pelo usuário. */
  onClose?: () => void;
  /** Anuncia mudanças a leitores de tela (laço em andamento, revisão concluída). */
  live?: boolean;
}

const ORDEM: Record<NoticeSeverity, number> = { error: 0, warning: 1, info: 2 };
const ICONE: Record<NoticeSeverity, React.ReactNode> = {
  error: <ErrorOutlineIcon sx={{ fontSize: "1rem" }} />,
  warning: <WarningAmberIcon sx={{ fontSize: "1rem" }} />,
  info: <InfoOutlinedIcon sx={{ fontSize: "1rem" }} />,
};

export default function SpecNoticeCenter({ notices, sx }: {
  notices: (SpecNotice | null | false | undefined)[];
  sx?: object;
}) {
  const lista = notices.filter((n): n is SpecNotice => !!n);
  if (lista.length === 0) return null;

  // Mais severo primeiro; empate mantém a ordem de declaração (que é a ordem de importância
  // escolhida por quem chamou).
  const ordenada = [...lista].sort((a, b) => ORDEM[a.severity] - ORDEM[b.severity]);
  const [principal, ...resto] = ordenada;

  return (
    <Box sx={{ mb: 2, ...sx }}>
      <Alert
        severity={principal.severity}
        aria-live={principal.live ? "polite" : undefined}
        onClose={principal.onClose}
        action={principal.actionLabel && principal.onAction
          ? <Button size="small" color="inherit" onClick={principal.onAction}>{principal.actionLabel}</Button>
          : undefined}
        sx={{ mb: resto.length ? 0.75 : 0, alignItems: "center" }}
      >
        {principal.title && <AlertTitle sx={{ mb: 0.25 }}>{principal.title}</AlertTitle>}
        {principal.text}
      </Alert>

      {/* Linhas compactas: mesma informação, ~28px em vez de ~64px. Mantêm ícone de severidade
          (cor sozinha não basta — daltonismo) e a ação própria de cada aviso. */}
      {resto.length > 0 && (
        <Stack
          sx={{
            border: "1px solid", borderColor: "divider", borderRadius: 1,
            bgcolor: "background.paper", overflow: "hidden",
          }}
        >
          {resto.map((n, i) => (
            <Stack
              key={n.key}
              direction="row" alignItems="center" spacing={1}
              aria-live={n.live ? "polite" : undefined}
              sx={{
                px: 1.25, py: 0.5, minHeight: 32,
                borderTop: i > 0 ? "1px solid" : "none", borderColor: "divider",
              }}
            >
              <Box sx={{ display: "flex", color: `${n.severity}.main`, flexShrink: 0 }}>{ICONE[n.severity]}</Box>
              <Typography variant="caption" sx={{ flexGrow: 1, minWidth: 0, fontSize: "0.75rem", lineHeight: 1.45 }}>
                {n.title && <Box component="strong" sx={{ mr: 0.5 }}>{n.title}</Box>}
                {n.text}
              </Typography>
              {n.actionLabel && n.onAction && (
                <Button size="small" color="inherit" onClick={n.onAction}
                  sx={{ flexShrink: 0, fontSize: "0.72rem", py: 0.25, minHeight: 28 }}>
                  {n.actionLabel}
                </Button>
              )}
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
}
