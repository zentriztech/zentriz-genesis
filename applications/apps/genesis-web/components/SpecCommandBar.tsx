"use client";

// SpecCommandBar — a ÚNICA barra de comando da Bancada em modo edição.
//
// Antes havia três faixas de cromo empilhadas acima do editor:
//   1) cabeçalho de página  — ícone + "Editar Spec" + subtítulo + [← Voltar ao projeto]
//   2) cabeçalho do Card    — título do projeto + [Relatórios|Autonomia|Descartar|Salvar|Promover]
//   3) toolbar do editor    — abas + chips + [Regenerar|💾 Salvar|📐 Normalizar|Promover|tela cheia]
// "Salvar" aparecia DUAS vezes (2 e 3) a ~40px de distância, e (2) não respeitava o veredito de
// promoção do servidor nem oferecia [Normalizar] — só (3), que no modo inline nem os recebia.
//
// Aqui (1) e (2) viram uma linha só: navegação + identidade do que se edita + ações. A toolbar do
// editor fica com o que é dela — abas e estado do arquivo.
//
// Ganho, pela conta dos paddings/alturas do tema (não é medição de DOM): a faixa (2) valia ~56px
// (py 1.5 + conteúdo ~34 + borda) e desapareceu inteira; (1) e (2) somadas valiam ~132px, contra
// ~81px desta barra. O editor, que vive dentro do Card, recupera os ~56px da faixa (2).

import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ActionOverflowBar, { type BarAction } from "./ActionOverflowBar";

export default function SpecCommandBar({
  title, onTitle, titlePlaceholder = "Título do projeto",
  subtitle, onBack, backLabel = "Voltar ao projeto",
  actions, barLeading, trailing, ariaLabel = "Ações da spec", breakpoint = "lg",
}: {
  title: string;
  onTitle: (v: string) => void;
  titlePlaceholder?: string;
  /** Contexto curto (ex.: nome do produto dono). Some abaixo de sm — ali o espaço é do título. */
  subtitle?: string | null;
  onBack: () => void;
  backLabel?: string;
  actions: BarAction[];
  /** Controle com gatilho próprio, exibido só no desktop (repassado ao ActionOverflowBar). */
  barLeading?: React.ReactNode;
  /** Fora do fluxo visual (ex.: menu ancorado do mobile). */
  trailing?: React.ReactNode;
  ariaLabel?: string;
  /**
   * Abaixo desta largura as ações colapsam no menu de ícone. Default `lg` (1200px), não `md`:
   * somados os rótulos reais desta barra — Relatórios (PDF) · Modo autônomo em todos os arquivos
   * (N) · Descartar · Normalizar · Salvar arquivo · Promover o produto à Fábrica — dão ~980px, e o
   * título precisa de ~200px para não virar duas letras. Em `md` (900px) a barra já quebrava em
   * duas linhas: o menu é mais honesto que o empilhamento.
   */
  breakpoint?: "sm" | "md" | "lg";
}) {
  return (
    <Stack
      direction="row" alignItems="center" flexWrap="wrap" useFlexGap
      sx={{
        px: { xs: 1, sm: 1.5 }, py: 1, rowGap: 1, mb: 2,
        border: "1px solid", borderColor: "divider", borderRadius: 1,
        bgcolor: "background.paper",
      }}
    >
      {/* Alvo de 34px: acima do mínimo de 24×24 CSS px do WCAG 2.5.8. */}
      <Tooltip title={backLabel}>
        <IconButton size="small" onClick={onBack} aria-label={backLabel}
          sx={{ mr: 0.5, width: 34, height: 34, flexShrink: 0 }}>
          <ArrowBackIcon sx={{ fontSize: "1.1rem" }} />
        </IconButton>
      </Tooltip>

      {/* `flex: 1 1 0` (e não `flexGrow: 1` só): o TextField é `fullWidth`, então resolve
          `width: 100%` contra a largura do container flex — com base `auto` isso vira uma base do
          tamanho da barra inteira e empurra o menu ⋮ para uma terceira linha em 320px. Com base 0
          o título cresce a partir do zero e a barra cabe em uma linha em qualquer largura. */}
      <Box sx={{ flex: "1 1 0", minWidth: 0, mr: 1 }}>
          {/* O título é o objeto da tela — maior e mais pesado que tudo à volta (escala é a 2ª
              alavanca de hierarquia). Sem moldura permanente: a borda só aparece no hover/foco,
              para não somar mais uma caixa ao desenho. */}
          <TextField
            size="small" variant="outlined" value={title} onChange={(e) => onTitle(e.target.value)}
            placeholder={titlePlaceholder} fullWidth
            InputProps={{ sx: { fontWeight: 700, fontSize: "1rem" } }}
            // `aria-label` no TextField cai no root (<div>), não no <input>: medido, o campo ficava
            // SEM nome acessível. `inputProps` (minúsculo) é o que chega ao elemento nativo.
            inputProps={{ "aria-label": titlePlaceholder }}
            sx={{
              "& .MuiOutlinedInput-root": {
                "& fieldset": { borderColor: "transparent !important" },
                "&:hover fieldset": { borderColor: "divider !important" },
                "&.Mui-focused fieldset": { borderColor: "primary.main !important" },
              },
              // `input` tem largura intrínseca de ~20 caracteres: sem `minWidth: 0` ele recusa
              // encolher e empurra as ações para a linha de baixo já em 320px.
              "& .MuiOutlinedInput-input": { py: 0.5, px: 1, minWidth: 0 },
            }}
          />
          {subtitle && (
            <Typography variant="caption" color="text.secondary"
              sx={{ display: { xs: "none", sm: "block" }, pl: 1, lineHeight: 1.3 }}>
              {subtitle}
            </Typography>
          )}
      </Box>

      {/* `ml: auto` mantém as ações coladas à direita mesmo quando a barra quebra em duas linhas
          (telas estreitas): alinhadas à esquerda, elas ficavam soltas embaixo do botão Voltar. */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0, ml: "auto" }}>
        <ActionOverflowBar ariaLabel={ariaLabel} actions={actions} leading={barLeading} breakpoint={breakpoint} />
        {trailing}
      </Stack>
    </Stack>
  );
}
