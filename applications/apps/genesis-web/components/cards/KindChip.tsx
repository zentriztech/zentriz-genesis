"use client";
import Chip from "@mui/material/Chip";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import BugReportOutlinedIcon from "@mui/icons-material/BugReportOutlined";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import { KIND_LABEL, STATE_LABEL, type CardKind, type CardState } from "@/lib/cards/types";

const ICON = {
  evolution: <BuildOutlinedIcon />, fix: <BugReportOutlinedIcon />, feature: <AutoAwesomeOutlinedIcon />,
} as const;
const COLOR = { evolution: "info", fix: "warning", feature: "success" } as const;

/** Tipo do card: ícone + rótulo em texto (a cor nunca é a única pista). */
export function KindChip({ kind }: { kind: CardKind }) {
  return <Chip size="small" variant="outlined" icon={ICON[kind]} color={COLOR[kind]} label={KIND_LABEL[kind]} />;
}

const STATE_COLOR: Record<CardState, "default" | "info" | "success" | "warning" | "error" | "primary"> = {
  draft: "default", refining: "info", ready: "primary", promoted: "info", in_factory: "info", delivered: "success", blocked: "error", rejected: "default",
};
export function StateChip({ state }: { state: CardState }) {
  return <Chip size="small" color={STATE_COLOR[state]} variant={state === "ready" || state === "delivered" ? "filled" : "outlined"} label={STATE_LABEL[state]} />;
}
