"use client";
import { useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorMessage } from "@/lib/cards/cardErrors";
import type { CardDetail } from "@/lib/cards/types";

/** Ações de estado do card (refinar, validar, rejeitar, retomar, excluir). Promover vive no PromotePanel. */
export function CardActionsBar({ card, onChanged, onDeleted }: { card: CardDetail; onChanged: () => void | Promise<void>; onDeleted: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"reject" | "delete" | null>(null);
  const inFlight = useRef(false);

  const run = async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(key); setError(null); setOk(null);
    try {
      const r = await fn();
      if (r === "deleted") { setConfirm(null); return; }   // card removido: não há o que recarregar
      if (okMsg) setOk(okMsg);
      setConfirm(null); await onChanged();
    }
    catch (e) { setError(cardErrorMessage(e)); setConfirm(null); await onChanged(); }
    finally { inFlight.current = false; setBusy(null); }
  };
  const a = card.actions;
  return (
    <>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {a.refine && card.state !== "ready" && <Button size="small" variant="outlined" disabled={!!busy} onClick={() => void run("refine", () => cardsApi.refine(card.id))}>Iniciar refinamento</Button>}
        {a.ready && <Button size="small" variant="contained" disabled={!!busy} onClick={() => void run("ready", () => cardsApi.ready(card.id), "Especificação validada: o card está pronto para promover.")}>{busy === "ready" ? "Validando…" : "Validar"}</Button>}
        {a.resume && <Button size="small" variant="outlined" disabled={!!busy} onClick={() => void run("resume", () => cardsApi.resume(card.id))}>Retomar</Button>}
        {a.reject && <Button size="small" color="error" variant="outlined" disabled={!!busy} onClick={() => setConfirm("reject")}>Rejeitar</Button>}
        {a.delete && <Button size="small" color="error" disabled={!!busy} onClick={() => setConfirm("delete")}>Excluir</Button>}
      </Stack>
      {ok && <Alert severity="success" sx={{ mt: 1 }} role="status">{ok}</Alert>}
      {error && <Alert severity="error" sx={{ mt: 1 }} role="alert" onClose={() => setError(null)}>{error}</Alert>}
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} aria-labelledby="card-confirm-title">
        <DialogTitle id="card-confirm-title">{confirm === "delete" ? "Excluir card?" : "Rejeitar card?"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm === "delete" ? "O rascunho do card e a especificação dele serão removidos. Esta ação não pode ser desfeita." : "O card será encerrado como rejeitado e não poderá ser promovido."}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancelar</Button>
          <Button color="error" variant="contained" disabled={!!busy}
            onClick={() => confirm === "delete" ? void run("delete", async () => { await cardsApi.remove(card.id); onDeleted(); return "deleted"; }) : void run("reject", () => cardsApi.reject(card.id))}>
            {confirm === "delete" ? "Excluir" : "Rejeitar"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
