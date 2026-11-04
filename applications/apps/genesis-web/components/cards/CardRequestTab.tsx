"use client";
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorMessage } from "@/lib/cards/cardErrors";
import { CARD_KINDS, KIND_LABEL, KIND_RITE, type CardAttachment, type CardDetail, type CardKind } from "@/lib/cards/types";

const PLAIN = new Set(["txt", "md"]);
const ext = (n: string) => (n.includes(".") ? n.split(".").pop()!.toLowerCase() : "");
const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(b / 1024))} KB`);

/** Estado de cada anexo: entra na spec (txt/md), convertido (derivado .md) ou guardado no card (pdf/doc/docx). */
export function attachmentStatus(a: CardAttachment, all: CardAttachment[]): string {
  if (a.origin === "converted" || a.derivedFromAttachmentId) {
    const src = all.find((x) => x.id === a.derivedFromAttachmentId);
    return `Convertido automaticamente${src ? ` de ${src.filename}` : ""} · entra na especificação`;
  }
  if (PLAIN.has(ext(a.filename))) return "Texto: entra na especificação do card";
  const hasDerived = all.some((x) => x.derivedFromAttachmentId === a.id);
  return hasDerived ? "Guardado no card · conversão para .md concluída" : "Guardado no card · conversão para .md pendente ou desabilitada";
}

export function CardRequestTab({ card, onChanged }: { card: CardDetail; onChanged: () => void | Promise<void> }) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [kind, setKind] = useState<CardKind>(card.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setTitle(card.title); setBody(card.body); setKind(card.kind); }, [card.id, card.title, card.body, card.kind]);
  const editable = card.actions.edit;
  const dirty = title !== card.title || body !== card.body || kind !== card.kind;

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try { await cardsApi.patch(card.id, { title, body, kind }); setSaved(true); await onChanged(); }
    catch (e) { setError(cardErrorMessage(e)); }
    finally { setBusy(false); }
  };
  return (
    <Stack spacing={2}>
      <Alert severity="info" icon={false} role="note" data-testid="kind-rite">{KIND_RITE[card.kind]}</Alert>
      <TextField select size="small" label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as CardKind)} disabled={!editable} sx={{ maxWidth: 260 }}
        helperText={kind !== card.kind ? KIND_RITE[kind] : undefined}>
        {CARD_KINDS.map((k) => <MenuItem key={k} value={k}>{KIND_LABEL[k]}</MenuItem>)}
      </TextField>
      <TextField size="small" label="Título" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} fullWidth />
      <TextField label="Pedido" value={body} onChange={(e) => setBody(e.target.value)} multiline minRows={6} disabled={!editable} fullWidth
        helperText={editable ? undefined : "O texto do pedido só pode ser editado em rascunho ou refinamento."} />
      {editable && (
        <Box><Button variant="contained" size="small" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Salvando…" : "Salvar pedido"}</Button></Box>
      )}
      {saved && <Alert severity="success" role="status">Pedido salvo.</Alert>}
      {error && <Alert severity="error" role="alert">{error}</Alert>}
      <Box component="section" aria-labelledby="card-attachments-title">
        <Typography id="card-attachments-title" variant="subtitle2" component="h3">Anexos ({card.attachments.length})</Typography>
        {card.attachments.length === 0
          ? <Typography variant="body2" color="text.secondary">Este card não tem anexos.</Typography>
          : (
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {card.attachments.map((a) => (
                <li key={a.id}>
                  <Link href={a.downloadUrl} download>{a.filename}</Link>{" "}
                  <Typography variant="caption" color="text.secondary">({fmtSize(a.sizeBytes)}) — {attachmentStatus(a, card.attachments)}</Typography>
                </li>
              ))}
            </Box>
          )}
      </Box>
    </Stack>
  );
}
