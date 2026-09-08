"use client";

/**
 * ZentrizAuthShell — moldura de identidade das telas de acesso (`/login`, `/login/genesis`,
 * `/login/tenant`). Antes cada tela era um `Box bgcolor="grey.100"` com um cartão solto: nada dizia
 * que aquilo é a **Autonomy Suite da Zentriz**.
 *
 * Anatomia (espelha a da landpage): assinatura → trilha da suíte → cartão (formulário) → fólio.
 * A trilha é HTML de verdade (não desenho): leitor de tela lê "Genesis, constrói · Connect, contrata ·
 * Auto Care, cura", e a ordem da suíte fica escrita, não só sugerida.
 *
 * ⚠️ Regra de ouro: o fundo é `tinta` SEMPRE (inclusive no tema claro do portal), então todo texto
 * desta moldura fixa cor clara literal. Herdar `text.primary` deixaria o texto escuro sobre tinta —
 * invisível — quando o usuário está no tema claro. O cartão (children) continua no tema do portal:
 * claro ou escuro, ele é opaco e tem contraste próprio.
 */

import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ZentrizAuthBackground from "./ZentrizAuthBackground";
import { ZentrizWordmark } from "./ZentrizMarks";
import { suiteStations, ZENTRIZ_TAGLINE, zentrizColor } from "./zentrizBrand";

export default function ZentrizAuthShell({ children, maxWidth = 400 }: {
  /** O cartão da tela (formulário de acesso). */
  children: ReactNode;
  /** Largura do cartão — telas com mais campos pedem mais. */
  maxWidth?: number;
}) {
  return (
    <Box
      sx={{
        position: "relative",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: { xs: 2.5, md: 3 },
        px: 2,
        py: { xs: 4, md: 5 },
        bgcolor: zentrizColor.ink,
      }}
    >
      <ZentrizAuthBackground />

      {/* Coluna de conteúdo: acima do grafismo (que é `position: absolute` sem z-index). */}
      <Stack spacing={1.25} alignItems="center" sx={{ position: "relative", textAlign: "center" }}>
        <ZentrizWordmark height={30} title="Zentriz" />
        <Typography
          sx={{
            color: zentrizColor.neutro400,
            fontSize: "0.68rem",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          Autonomy Suite
        </Typography>

        {/* Trilha da suíte, na ordem canônica. O separador é o laço: “›” entre as peças e, depois da
            última, o retorno ao início (o Auto Care realimenta o Genesis). */}
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="center"
          flexWrap="wrap"
          sx={{ rowGap: 0.5, columnGap: 1 }}
        >
          {suiteStations.map((station, i) => (
            <Stack key={station.id} direction="row" alignItems="center" spacing={1}>
              <Stack direction="row" alignItems="center" spacing={0.6}>
                <Box
                  component="span"
                  sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: station.color, flexShrink: 0 }}
                />
                <Typography component="span" sx={{ color: zentrizColor.paper, fontSize: "0.78rem", fontWeight: 600 }}>
                  {station.name}
                </Typography>
                <Typography component="span" sx={{ color: zentrizColor.neutro500, fontSize: "0.72rem" }}>
                  {station.role.toLowerCase()}
                </Typography>
              </Stack>
              <Box component="span" aria-hidden sx={{ color: zentrizColor.neutro600, fontSize: "0.8rem" }}>
                {i < suiteStations.length - 1 ? "›" : "↺"}
              </Box>
            </Stack>
          ))}
        </Stack>
      </Stack>

      <Box sx={{ position: "relative", width: "100%", maxWidth }}>{children}</Box>

      <Typography sx={{ position: "relative", color: zentrizColor.neutro500, fontSize: "0.68rem", textAlign: "center" }}>
        {ZENTRIZ_TAGLINE}
      </Typography>
    </Box>
  );
}
