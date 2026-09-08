"use client";

/**
 * ZentrizAuthBackground — o fundo das telas de acesso do portal Genesis (pedido do Jean, 2026-09-08:
 * "aplique a identidade da Zentriz (Genesis > Connect > Auto Care) e seus símbolos no background").
 *
 * O que está desenhado (e por quê):
 *  • fundo `tinta` (#0D0916): na marca o herói é SEMPRE em tinta;
 *  • o **grafismo do laço** — três estádios entrelaçados, geometria copiada do asset oficial
 *    `Grafismos/Ordem=32` (Drive → `zentriz-landpage/src/brand/grafismos/ordem-32-*.svg`),
 *    cada laço recolorido pelo ESTADO da peça que representa, na ordem da suíte:
 *    Genesis (construção) → Connect (conexão) → Auto Care (cura). O laço não termina: os estádios
 *    se sobrepõem porque o Auto Care realimenta o Genesis;
 *  • o **símbolo v3.1** como aguada (`markInk` sobre `tinta`) — o Z de dois nós, que é o próprio laço.
 *
 * Decorativo de ponta a ponta: `aria-hidden` + `pointer-events: none`. Nenhum texto vive aqui (rótulo
 * de peça é HTML de verdade no `ZentrizAuthShell`, para leitor de tela e para não borrar em zoom).
 * Movimento: um halo percorre as três estações na ordem da suíte; com `prefers-reduced-motion` os
 * halos ficam parados no estado final (nunca piscando).
 */

import { motion, useReducedMotion } from "framer-motion";
import Box from "@mui/material/Box";
import { suiteStations, zentrizColor } from "./zentrizBrand";
import { ZentrizSymbol } from "./ZentrizMarks";

type Point = readonly [number, number];

/**
 * Os três laços do `Ordem=32`, verbatim do asset (viewBox `-8 -8 738 416`): estádio (rx=108,75),
 * a diagonal do Z entre dois nós grandes e os nós pequenos do anel. Só as CORES mudam.
 */
const LACOS: ReadonlyArray<{
  station: (typeof suiteStations)[number];
  rectX: number;
  diagonal: string;
  hubs: readonly Point[];
  nodes: readonly Point[];
}> = [
  {
    station: suiteStations[0], // Genesis — constrói
    rectX: 2.93042,
    diagonal: "M182.581 90L120.781 310",
    hubs: [[182.581, 90], [120.78, 310]],
    nodes: [
      [111.68, 90], [250.33, 106.939], [294.488, 160.876], [297.361, 230.523], [257.796, 287.914],
      [191.68, 310], [53.0312, 293.061], [8.87329, 239.124], [6, 169.477], [45.5652, 112.086],
    ],
  },
  {
    station: suiteStations[1], // Connect — contrata (a diagonal sobe: o contrato devolve garantia)
    rectX: 212.93,
    diagonal: "M330.781 310L392.581 90",
    hubs: [[330.78, 310], [392.581, 90]],
    nodes: [
      [401.68, 310], [263.031, 293.061], [218.873, 239.124], [216, 169.477], [255.565, 112.086],
      [321.68, 90], [460.33, 106.939], [504.488, 160.876], [507.361, 230.523], [467.796, 287.914],
    ],
  },
  {
    station: suiteStations[2], // Auto Care — cura (e realimenta o Genesis)
    rectX: 422.93,
    diagonal: "M637.82 93.1499L505.54 306.85",
    hubs: [[637.822, 93.1514], [505.539, 306.849]],
    nodes: [
      [531.68, 90], [714.488, 160.876], [702.244, 262.435], [611.68, 310], [428.873, 239.124],
      [441.116, 137.565],
    ],
  },
];

export default function ZentrizAuthBackground() {
  const reduceMotion = useReducedMotion();

  return (
    <Box aria-hidden sx={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", bgcolor: zentrizColor.ink }}>
      {/* Aguada do símbolo: `markInk` sobre `tinta` é quase imperceptível — é textura, não logotipo
          (a assinatura legível fica no cabeçalho do cartão). */}
      <Box sx={{ position: "absolute", right: { xs: -110, md: -70 }, bottom: { xs: -110, md: -80 }, lineHeight: 0 }}>
        <ZentrizSymbol size={420} fill={zentrizColor.markInk} />
      </Box>

      {/* Grafismo do laço — largo de propósito: em telas estreitas ele sangra pelas bordas, como no
          manual (o laço continua fora do quadro). */}
      <Box
        component="svg"
        viewBox="-8 -8 738 416"
        preserveAspectRatio="xMidYMid meet"
        sx={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: { xs: "190%", sm: "150%", md: "115%", lg: "1420px" },
          maxWidth: "none",
        }}
      >
        {LACOS.map(({ station, rectX, diagonal, hubs, nodes }, lacoIndex) => (
          <g key={station.id}>
            {/* anel do laço + diagonal do Z: estrutura, sempre em neutro (a cor pertence ao nó) */}
            <rect x={rectX} y={91.25} width={297.5} height={217.5} rx={108.75} fill="none" stroke={zentrizColor.neutro800} strokeWidth={2.5} />
            <path d={diagonal} stroke={zentrizColor.neutro800} strokeWidth={2} strokeLinecap="round" />
            {nodes.map(([cx, cy]) => (
              <circle key={`${station.id}-${cx}-${cy}`} cx={cx} cy={cy} r={6} fill={zentrizColor.neutro600} />
            ))}
            {hubs.map(([cx, cy], i) => (
              <g key={`${station.id}-hub-${i}`}>
                {/* halo = anel de traço (não alfa): a cor de estado da marca não tem transparência */}
                <motion.circle
                  cx={cx}
                  cy={cy}
                  r={17}
                  fill="none"
                  stroke={station.color}
                  strokeWidth={1.5}
                  initial={{ opacity: reduceMotion ? 0.35 : 0 }}
                  animate={reduceMotion ? { opacity: 0.35 } : { opacity: [0, 0.9, 0] }}
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { duration: 2.4, times: [0, 0.35, 1], repeat: Infinity, repeatDelay: 3.6, delay: lacoIndex * 1.2, ease: "easeOut" }
                  }
                />
                <circle cx={cx} cy={cy} r={9} fill={station.color} />
              </g>
            ))}
          </g>
        ))}
      </Box>
    </Box>
  );
}
