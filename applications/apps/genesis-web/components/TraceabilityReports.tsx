"use client";

// Relatórios de rastreabilidade em PDF — pedido do Jean (2026-09-07): três perfis (resumido,
// completo e misto) com o mapeamento da construção do produto, "gerar arquivo e iniciar download".
//
// O MESMO controle serve a Bancada e a Fábrica porque o produto é O MESMO objeto nas duas (o outro
// pedido do Jean): na Bancada usamos o produto DONO da spec em edição, na Fábrica o produto do card.
// Duas telas, um relatório — se cada lado tivesse o seu, divergiriam na primeira mudança.
//
// Os fatos vêm da API (`/api/products/:id/traceability`); aqui só há menu, estado de progresso e a
// mensagem do que saiu (páginas e desenhos). O desenho do PDF vive em `lib/traceabilityPdf.ts`.

import { useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Snackbar from "@mui/material/Snackbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import {
  downloadTraceabilityPdf, PROFILE_HINT, PROFILE_LABEL, type TraceabilityProfile,
} from "@/lib/traceabilityPdf";

const PROFILES: TraceabilityProfile[] = ["summary", "full", "mixed"];

interface Props {
  /** Produto sobre o qual o relatório é emitido. Sem produto não há relatório (o controle não aparece). */
  productId: string | null | undefined;
  productName?: string | null;
  /**
   * `icon` para caber em cabeçalho/card apertado; `button` para barra de ações;
   * `hosted` para quando o GATILHO é de outro (item do menu de ícone no mobile,
   * `ActionOverflowBar`): aqui só vivem a lista dos três perfis e os avisos, ancorados no elemento
   * que o hospedeiro entrega. Um MenuItem próprio dentro de outro `<Menu>` não serve — o MenuList
   * clona o primeiro filho, e este componente devolve um Fragment.
   */
  variant?: "button" | "icon" | "hosted";
  size?: "small" | "medium";
  fullWidth?: boolean;
  /** `hosted`: elemento onde a lista de perfis abre (null = fechada). */
  hostAnchor?: HTMLElement | null;
  /** `hosted`: pedido de fechamento (o hospedeiro zera o próprio anchor). */
  onHostClose?: () => void;
}

export function TraceabilityReportsButton({
  productId, productName, variant = "button", size = "small", fullWidth = false,
  hostAnchor = null, onHostClose,
}: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState<TraceabilityProfile | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!productId) return null;

  const run = async (profile: TraceabilityProfile) => {
    setAnchor(null);
    onHostClose?.();
    setBusy(profile);
    setError(null);
    setDone(null);
    try {
      const res = await downloadTraceabilityPdf(productId, profile);
      setDone(
        `${res.filename} — ${res.pages} página(s)` +
        (res.diagrams > 0 ? `, ${res.diagrams} desenho(s) de arquitetura.` : ", sem desenhos de arquitetura ainda."),
      );
    } catch (e) {
      // Sem inventar: o motivo real vai para a tela (403/404 do escopo, falha de rede, PDF).
      setError(e instanceof Error ? e.message : "Falha ao gerar o relatório em PDF");
    } finally {
      setBusy(null);
    }
  };

  const tip = `Gera um PDF com o mapeamento da construção${productName ? ` de "${productName}"` : ""}: spec com hash por arquivo, GAPs, vereditos, constraints, rodadas do laço autônomo, fábrica e os desenhos de arquitetura.`;
  const spinner = <CircularProgress size={14} color="inherit" />;

  return (
    <>
      {variant === "hosted" ? null : variant === "icon" ? (
        <Tooltip title={tip}>
          <IconButton
            size={size} aria-label="Relatórios de rastreabilidade em PDF" disabled={!!busy}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAnchor(e.currentTarget); }}
          >
            {busy ? spinner : <PictureAsPdfOutlinedIcon sx={{ fontSize: "1rem" }} />}
          </IconButton>
        </Tooltip>
      ) : (
        <Tooltip title={tip}>
          <span style={fullWidth ? { display: "block", width: "100%" } : undefined}>
            <Button
              size={size} variant="outlined" color="inherit" fullWidth={fullWidth} disabled={!!busy}
              startIcon={busy ? spinner : <PictureAsPdfOutlinedIcon sx={{ fontSize: "0.95rem" }} />}
              sx={{ fontSize: "0.68rem" }}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAnchor(e.currentTarget); }}
            >
              {busy ? `Gerando ${PROFILE_LABEL[busy].toLowerCase()}…` : "Relatórios (PDF)"}
            </Button>
          </span>
        </Tooltip>
      )}

      <Menu
        anchorEl={variant === "hosted" ? hostAnchor : anchor}
        open={variant === "hosted" ? !!hostAnchor : !!anchor}
        onClose={() => { setAnchor(null); onHostClose?.(); }}
        slotProps={{ paper: { sx: { maxWidth: 380 } } }}
      >
        {PROFILES.map((p) => (
          <MenuItem key={p} onClick={() => void run(p)} sx={{ alignItems: "flex-start", py: 1 }}>
            <ListItemText
              primary={<Typography variant="body2" fontWeight={700}>{PROFILE_LABEL[p]}</Typography>}
              secondary={
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.4, whiteSpace: "normal" }}>
                  {PROFILE_HINT[p]}
                </Typography>
              }
            />
          </MenuItem>
        ))}
      </Menu>

      <Snackbar
        open={!!done} autoHideDuration={9000} onClose={() => setDone(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="success" onClose={() => setDone(null)} sx={{ whiteSpace: "pre-line" }}>
          Relatório baixado: {done}
        </Alert>
      </Snackbar>
      <Snackbar
        open={!!error} autoHideDuration={12000} onClose={() => setError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" onClose={() => setError(null)} sx={{ whiteSpace: "pre-line" }}>{error}</Alert>
      </Snackbar>
    </>
  );
}
