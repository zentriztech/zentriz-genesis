"use client";
import { useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import IconButton from "@mui/material/IconButton";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorMessage } from "@/lib/cards/cardErrors";
import { CARD_KINDS, DEFAULT_ATTACHMENT_EXTENSIONS, KIND_DESCRIPTION, KIND_LABEL, type CardCapabilities, type CardKind, type CardSummary } from "@/lib/cards/types";

const BODY_MAX = 20_000;
const fmtMb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(b % (1024 * 1024) === 0 ? 0 : 1)} MB` : `${Math.ceil(b / 1024)} KB`);
const usd = (v: number) => `US$ ${v.toFixed(2)}`;
const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

export function CardCreateDialog({ open, productId, caps, onClose, onCreated }: {
  open: boolean; productId: string; caps?: CardCapabilities | null; onClose: () => void; onCreated: (card: CardSummary) => void;
}) {
  const [kind, setKind] = useState<CardKind>("evolution");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fieldError, setFieldError] = useState<{ body?: string; files?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const allowed = (caps?.attachments?.allowedExtensions?.length ? caps.attachments.allowedExtensions : DEFAULT_ATTACHMENT_EXTENSIONS).map((e) => e.replace(/^\./, "").toLowerCase());
  const maxFiles = caps?.attachments?.maxFiles;
  const maxTotal = caps?.attachments?.maxTotalBytes;
  const budget = caps?.budget;
  const lowBalance = budget && budget.freeUsd != null && budget.minFreeUsd != null && budget.freeUsd < budget.minFreeUsd;

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      if (!allowed.includes(extOf(f.name))) { problems.push(`“${f.name}”: tipo não permitido (use ${allowed.join(", ")})`); continue; }
      next.push(f);
    }
    if (maxFiles && next.length > maxFiles) problems.push(`No máximo ${maxFiles} arquivo(s) por card`);
    const sum = next.reduce((a, f) => a + f.size, 0);
    if (maxTotal && sum > maxTotal) problems.push(`O total dos anexos passa do teto de ${fmtMb(maxTotal)}`);
    setFieldError((p) => ({ ...p, files: problems.length ? problems.join(". ") + "." : undefined }));
    if (!problems.length || problems.every((p) => p.includes("tipo não permitido"))) setFiles(next);
    if (fileInput.current) fileInput.current.value = "";
  };

  const submit = async () => {
    if (inFlight.current) return;
    const errs: { body?: string } = {};
    if (!body.trim()) errs.body = "Descreva o pedido: o que deve mudar e por quê.";
    else if (body.length > BODY_MAX) errs.body = `O texto passa do limite de ${BODY_MAX.toLocaleString("pt-BR")} caracteres.`;
    if (errs.body) { setFieldError((p) => ({ ...p, ...errs })); return; }
    setFieldError((p) => ({ ...p, body: undefined }));
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const card = await cardsApi.create(productId, { kind, title, body, files });
      onCreated(card);
    } catch (e) { setError(cardErrorMessage(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="card-create-title">
      <DialogTitle id="card-create-title">Novo card</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <FormControl>
            <FormLabel id="card-kind-label">Tipo do card</FormLabel>
            <RadioGroup aria-labelledby="card-kind-label" value={kind} onChange={(e) => setKind(e.target.value as CardKind)}>
              {CARD_KINDS.map((k) => (
                <FormControlLabel key={k} value={k} control={<Radio />} sx={{ alignItems: "flex-start", mb: 0.5 }}
                  label={<Box><Typography variant="body2" fontWeight={600}>{KIND_LABEL[k]}</Typography><Typography variant="caption" color="text.secondary">{KIND_DESCRIPTION[k]}</Typography></Box>} />
              ))}
            </RadioGroup>
          </FormControl>
          <TextField label="Título (opcional)" value={title} onChange={(e) => setTitle(e.target.value)} size="small" fullWidth inputProps={{ maxLength: 200 }}
            helperText="Se ficar em branco, o título é gerado a partir do texto." />
          <TextField label="Descrição do pedido" value={body} onChange={(e) => setBody(e.target.value)} multiline minRows={5} fullWidth required
            error={!!fieldError.body} helperText={fieldError.body ?? `${body.length.toLocaleString("pt-BR")} / ${BODY_MAX.toLocaleString("pt-BR")} caracteres`} />
          <Box>
            <Typography variant="subtitle2" component="h3">Anexos (opcional)</Typography>
            <Typography variant="caption" color="text.secondary" component="p" id="card-attach-help">
              Tipos permitidos: {allowed.join(", ")}
              {maxFiles ? ` · até ${maxFiles} arquivo(s)` : ""}{maxTotal ? ` · teto total ${fmtMb(maxTotal)}` : " · o teto de tamanho é conferido pelo servidor"}.
              Arquivos txt e md entram na especificação; pdf, doc e docx ficam guardados no card (convertidos para .md automaticamente quando a conversão está habilitada).
            </Typography>
            <Button component="label" variant="outlined" size="small" sx={{ mt: 1 }}>
              Escolher arquivos
              <input ref={fileInput} hidden type="file" multiple accept={allowed.map((e) => `.${e}`).join(",")} aria-describedby="card-attach-help"
                onChange={(e) => addFiles(e.target.files)} />
            </Button>
            {fieldError.files && <Alert severity="warning" sx={{ mt: 1 }} role="alert">{fieldError.files}</Alert>}
            {files.length > 0 && (
              <Box component="ul" aria-label="Arquivos escolhidos" sx={{ m: 0, mt: 1, pl: 2 }}>
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    <Typography variant="body2" component="span">{f.name} ({fmtMb(f.size)})</Typography>
                    <IconButton size="small" aria-label={`Remover ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><CloseIcon fontSize="inherit" /></IconButton>
                  </li>
                ))}
              </Box>
            )}
          </Box>
          <Alert severity="info" icon={false} role="note">
            <Typography variant="body2"><b>Modo de trabalho: Branch git.</b> Cada card vira um projeto filho que trabalha numa branch do repositório do produto; não há cópia do código.</Typography>
          </Alert>
          <Alert severity={lowBalance ? "warning" : "info"} icon={false} role="note">
            <Typography variant="body2">
              <b>Orçamento:</b> o card compartilha o orçamento da versão corrente do produto.
              {budget && budget.freeUsd != null ? ` Saldo livre: ${usd(budget.freeUsd)}` : " O saldo livre é conferido pelo servidor"}
              {budget && budget.minFreeUsd != null ? ` · mínimo exigido para promover: ${usd(budget.minFreeUsd)}.` : "."}
              {lowBalance ? " O saldo está abaixo do mínimo: você pode criar o card, mas não conseguirá validá-lo nem promovê-lo até aumentar o orçamento." : ""}
            </Typography>
          </Alert>
          {error && <Alert severity="error" role="alert">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="contained" onClick={() => void submit()} disabled={busy}>{busy ? "Criando…" : "Criar card"}</Button>
      </DialogActions>
    </Dialog>
  );
}
