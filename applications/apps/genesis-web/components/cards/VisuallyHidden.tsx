"use client";
import Box from "@mui/material/Box";
import { visuallyHidden } from "@mui/utils";

/** Texto só para leitor de tela. */
export function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return <Box component="span" sx={visuallyHidden}>{children}</Box>;
}
