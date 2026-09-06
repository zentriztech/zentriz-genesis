"use client";

import {
  Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  TextField, Typography,
} from "@mui/material";

/**
 * Confirmação PADRÃO das ações de fábrica (revisão adversarial da Bancada, 2026-09-06).
 *
 * A escada de guardas é por CONSEQUÊNCIA, não por hábito da tela:
 *  • N1 — confirmação simples: admite N projetos / devolve à Bancada / interrompe execução;
 *  • N2 — confirmação por digitação (`confirmWord`): risco de CONTEÚDO (promover com GAPs abertos)
 *    ou destruição de dados (apagar), onde o clique distraído não pode bastar.
 *
 * Não decide nada: recebe o texto pronto (ver `lib/factoryActions.ts`) e devolve o clique.
 */
export interface ConfirmActionDialogProps {
  open: boolean;
  title: string;
  /** Corpo em texto (uma frase por linha; `\n` é preservado). */
  message: string;
  /** Severidade do alerta — `warning` por padrão; `error` para irreversível. */
  severity?: "info" | "warning" | "error";
  /** Rótulo do botão que executa (ex.: "Promover produto inteiro"). */
  confirmLabel: string;
  /** N2: exige digitar exatamente esta palavra para liberar o botão. */
  confirmWord?: string;
  /** Texto extra abaixo do alerta (ex.: motivo do risco). */
  detail?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  /** Valor/handler do campo de digitação (N2) — controlado pela tela, como os demais diálogos. */
  typed?: string;
  onTypedChange?: (v: string) => void;
}

export function ConfirmActionDialog({
  open, title, message, severity = "warning", confirmLabel, confirmWord, detail,
  busy = false, onConfirm, onClose, typed = "", onTypedChange,
}: ConfirmActionDialogProps) {
  const needsWord = !!confirmWord;
  const canConfirm = !busy && (!needsWord || typed.trim().toUpperCase() === confirmWord!.toUpperCase());
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: "1rem" }}>{title}</DialogTitle>
      <DialogContent>
        <Alert severity={severity} sx={{ whiteSpace: "pre-line" }}>{message}</Alert>
        {detail && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5, lineHeight: 1.6 }}>
            {detail}
          </Typography>
        )}
        {needsWord && (
          <TextField
            fullWidth size="small" sx={{ mt: 2 }} autoFocus
            label={`Digite ${confirmWord} para confirmar`}
            value={typed}
            onChange={(e) => onTypedChange?.(e.target.value)}
            disabled={busy}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button
          variant="contained"
          color={severity === "error" ? "error" : "success"}
          disabled={!canConfirm}
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ConfirmActionDialog;
