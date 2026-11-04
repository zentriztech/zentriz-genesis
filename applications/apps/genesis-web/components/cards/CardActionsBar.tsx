"use client";
import { useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import type { CardDetail } from "@/lib/cards/types";
import type { CardRunner } from "./useCardRunner";

/** Ações de estado do card (refinar, validar, reabrir, revalidar, retomar, rejeitar, excluir). Promover vive no PromotePanel. */
export function CardActionsBar({ card, runner }: { card: CardDetail; runner: CardRunner }) {
  const [confirm, setConfirm] = useState<"reject" | "delete" | null>(null);
  const { busy, run } = runner;
  const a = card.actions;
  const go = (key: "reject" | "delete") => { setConfirm(null); void run(key); };
  return (
    <>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {a.refine && card.state !== "ready" && <Button size="small" variant="outlined" disabled={!!busy} onClick={() => void run("refine")}>Iniciar refinamento</Button>}
        {a.ready && <Button size="small" variant="contained" disabled={!!busy} onClick={() => void run("ready")}>{busy === "ready" ? "Validando…" : "Validar"}</Button>}
        {a.reopen && <Button size="small" variant="outlined" disabled={!!busy} onClick={() => void run("reopen")}>{busy === "reopen" ? "Reabrindo…" : "Reabrir para edição"}</Button>}
        {a.revalidate && card.state !== "ready" && <Button size="small" variant="outlined" disabled={!!busy} onClick={() => void run("revalidate")}>{busy === "revalidate" ? "Revalidando…" : "Revalidar"}</Button>}
        {a.resume && <Button size="small" variant="outlined" disabled={!!busy} onClick={() => void run("resume")}>{busy === "resume" ? "Retomando…" : "Retomar"}</Button>}
        {a.reject && <Button size="small" color="error" variant="outlined" disabled={!!busy} onClick={() => setConfirm("reject")}>Rejeitar</Button>}
        {a.delete && <Button size="small" color="error" disabled={!!busy} onClick={() => setConfirm("delete")}>Excluir</Button>}
      </Stack>
      {runner.notice && <Alert severity="success" sx={{ mt: 1 }} role="status" onClose={runner.dismiss}>{runner.notice}</Alert>}
      {runner.error && runner.error.code !== "CARD_BASE_STALE" && <Alert severity="error" sx={{ mt: 1 }} role="alert" onClose={runner.dismiss}>{runner.error.message}</Alert>}
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} aria-labelledby="card-confirm-title">
        <DialogTitle id="card-confirm-title">{confirm === "delete" ? "Excluir card?" : "Rejeitar card?"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm === "delete" ? "O rascunho do card e a especificação dele serão removidos. Esta ação não pode ser desfeita." : "O card será encerrado como rejeitado e não poderá ser promovido."}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancelar</Button>
          <Button color="error" variant="contained" disabled={!!busy} onClick={() => go(confirm === "delete" ? "delete" : "reject")}>
            {confirm === "delete" ? "Excluir" : "Rejeitar"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
