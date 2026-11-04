"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorMessage } from "@/lib/cards/cardErrors";
import { useCardsCapabilities } from "@/lib/cards/useCardsEnabled";
import { CARD_KINDS, CARD_STATES, KIND_LABEL, STATE_LABEL, type CardKind, type CardState, type CardSummary } from "@/lib/cards/types";
import { CardTile } from "./CardTile";
import { CardCreateDialog } from "./CardCreateDialog";
import { CardsA11yTheme } from "./CardsA11yTheme";

/** Quadro de cards de um produto (3.1): uma coluna por estado, filtros por tipo e por estado. */
function CardBoardViewInner({ productId }: { productId: string }) {
  const router = useRouter();
  const { loading: capsLoading, caps } = useCardsCapabilities(productId);
  const [cards, setCards] = useState<CardSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<CardKind | "">("");
  const [hidden, setHidden] = useState<Set<CardState>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null); setCards(null);
    try {
      const r = await cardsApi.list(productId, { limit: 100 });
      setCards(r.items); setTotal(r.total);
    } catch (e) { setError(cardErrorMessage(e)); }
  }, [productId]);

  useEffect(() => { if (caps?.cardsBancada) void load(); }, [caps?.cardsBancada, load]);

  const visible = useMemo(() => (cards ?? []).filter((c) => !kind || c.kind === kind), [cards, kind]);
  const toggleState = (s: CardState) => setHidden((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n; });

  if (capsLoading) return <Box sx={{ p: 4, textAlign: "center" }}><CircularProgress aria-label="Carregando" /></Box>;
  if (!caps?.cardsBancada) {
    return <Alert severity="info">Os cards de evolução não estão habilitados para este tenant. O fluxo “Evoluir projeto” continua disponível na página do projeto.</Alert>;
  }

  const columns = CARD_STATES.filter((s) => !hidden.has(s));
  return (
    <Box>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h5" component="h1" fontWeight={700}>Cards do produto</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>Novo card</Button>
      </Stack>

      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ md: "center" }} sx={{ mb: 2 }}>
        <TextField select size="small" label="Filtrar por tipo" value={kind} onChange={(e) => setKind(e.target.value as CardKind | "")} sx={{ minWidth: 200 }}
          SelectProps={{ native: true }} InputLabelProps={{ shrink: true }}>
          <option value="">Todos os tipos</option>
          {CARD_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </TextField>
        <Box role="group" aria-label="Estados exibidos" sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {CARD_STATES.map((s) => {
            const on = !hidden.has(s);
            return (
              <Chip key={s} component="button" type="button" size="small" aria-pressed={on} label={`${on ? "✓ " : ""}${STATE_LABEL[s]}`}
                variant={on ? "filled" : "outlined"} color={on ? "primary" : "default"} onClick={() => toggleState(s)} clickable />
            );
          })}
        </Box>
      </Stack>

      {error && (
        <Alert severity="error" role="alert" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => void load()}>Tentar de novo</Button>}>{error}</Alert>
      )}
      {!error && cards === null && <Box sx={{ p: 4, textAlign: "center" }}><CircularProgress aria-label="Carregando cards" /></Box>}
      {cards && total > cards.length && (
        <Alert severity="warning" sx={{ mb: 2 }}>Mostrando {cards.length} de {total} cards. Use os filtros para refinar.</Alert>
      )}
      {cards && cards.length === 0 && !error && (
        <Alert severity="info" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => setCreateOpen(true)}>Criar o primeiro card</Button>}>
          Este produto ainda não tem cards. Crie um card para pedir uma evolução, uma correção ou um recurso novo.
        </Alert>
      )}
      {cards && cards.length > 0 && (
        <Box sx={{ display: "grid", gap: 1.5, alignItems: "start", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))" }}>
          {columns.map((s) => {
            const col = visible.filter((c) => c.state === s);
            const hid = `col-${s}`;
            return (
              <Box key={s} component="section" aria-labelledby={hid} sx={{ bgcolor: "action.hover", borderRadius: 1, p: 1, minWidth: 0 }}>
                <Typography id={hid} variant="subtitle2" component="h2" fontWeight={700} sx={{ mb: 1 }}>{STATE_LABEL[s]} ({col.length})</Typography>
                <Stack spacing={1}>
                  {col.length === 0
                    ? <Typography variant="caption" color="text.secondary">Nenhum card</Typography>
                    : col.map((c) => <CardTile key={c.id} card={c} />)}
                </Stack>
              </Box>
            );
          })}
        </Box>
      )}

      <CardCreateDialog open={createOpen} productId={productId} onClose={() => setCreateOpen(false)}
        onCreated={(card) => { setCreateOpen(false); router.push(`/cards/${card.id}`); }} />
    </Box>
  );
}

export function CardBoardView(props: { productId: string }) {
  return <CardsA11yTheme><CardBoardViewInner {...props} /></CardsA11yTheme>;
}
