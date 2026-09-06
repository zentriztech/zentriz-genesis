"use client";

// Diálogo do PLANO DE PROMOÇÃO (migração 097) — a ORDEM em que os projetos de um produto entram
// na fábrica, por ONDA, decidida por agente (`services/promotionPlanner.ts`).
//
// Requisito do Jean (2026-09-06): "quando temos projetos que dependem um do outro deve ser inserido
// na fabrica na ordem (...) e os projetos devem ser promovidos a fabrica mas nao inciados
// automaticamente". Por isso esta tela tem DUAS responsabilidades e nenhuma a mais:
//   1. mostrar a ordem (onda 1 → N) com o motivo de cada projeto estar ali;
//   2. deixar explícito que NADA começou, e oferecer o início como um clique SEPARADO.
//
// Princípios (do adversarial do plano):
//   • A UI não reordena, não infere camada e não esconde item: renderiza `items` como vieram do
//     servidor. Qualquer "esperteza" aqui faria a tela divergir do que a fábrica vai executar.
//   • `warnings` do planejador aparecem sempre (é onde mora "o agente pediu X, o banco impôs Y").
//   • O botão de iniciar dispara SÓ a onda mais baixa pendente — o rótulo diz isso, para ninguém
//     esperar que o produto todo saia junto.

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";

/** Um projeto no plano. Espelha `PromotionPlanItem` do backend (mais os campos do GET). */
export interface PromotionPlanItem {
  projectId: string;
  title?: string | null;
  /** Status atual do projeto (só o GET /promotion traz; o POST /promote não). */
  status?: string | null;
  position: number;
  wave: number;
  layer?: string | null;
  dependsOn?: string[];
  rationale?: string | null;
  dispatchedAt?: string | null;
}

/** Cabeçalho do plano — o que o POST /promote e o GET /promotion têm em comum. */
export interface PromotionPlanMeta {
  promotionId?: string | null;
  status?: string | null;
  notes?: string | null;
  warnings?: string[];
  /** `triggers` = havia aresta no banco; `agent` = a ordem saiu só do agente. */
  edgesSource?: string | null;
  modelUsed?: string | null;
  startedAt?: string | null;
}

/** Rótulo curto por status de projeto (o suficiente para ler a onda em execução). */
function statusLabel(s: string | null | undefined): { label: string; color: "default" | "info" | "success" | "warning" | "error" } {
  switch (s) {
    case "promoted": return { label: "aguardando início", color: "warning" };
    case "queued": return { label: "na fila", color: "info" };
    case "running": return { label: "em execução", color: "info" };
    case "dev_qa":
    case "devops": return { label: "em execução", color: "info" };
    case "completed": return { label: "concluído", color: "success" };
    case "accepted": return { label: "aceito", color: "success" };
    case "failed": return { label: "falhou", color: "error" };
    case "draft": return { label: "rascunho", color: "default" };
    default: return { label: s ?? "—", color: "default" };
  }
}

export function PromotionPlanDialog({
  open, onClose, productName, meta, items, onStart, starting, startError, startedNotice,
}: {
  open: boolean;
  onClose: () => void;
  productName?: string | null;
  meta: PromotionPlanMeta | null;
  items: PromotionPlanItem[];
  /** Ausente = tela só de leitura (ex.: produto já iniciado). */
  onStart?: () => void;
  starting?: boolean;
  startError?: string | null;
  startedNotice?: string | null;
}) {
  // Agrupa por onda preservando a ordem que o servidor mandou (não reordena nada).
  const waves: Array<{ wave: number; items: PromotionPlanItem[] }> = [];
  for (const it of items) {
    const last = waves[waves.length - 1];
    if (last && last.wave === it.wave) last.items.push(it);
    else waves.push({ wave: it.wave, items: [it] });
  }
  const titleById = new Map(items.map((i) => [i.projectId, i.title ?? i.projectId]));
  // Próxima onda a iniciar = a mais baixa que ainda tem projeto apenas promovido.
  const pendingWave = waves.find((w) => w.items.some((i) => i.status === "promoted" || i.status == null))?.wave ?? null;
  const nothingPending = items.length > 0 && items.every((i) => i.status != null && i.status !== "promoted");

  return (
    <Dialog open={open} onClose={starting ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, pb: 1 }}>
        <AccountTreeOutlinedIcon sx={{ color: "success.main" }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" fontWeight={700} sx={{ lineHeight: 1.2 }}>Ordem de entrada na fábrica</Typography>
          {productName && (
            <Typography variant="caption" color="text.secondary">{productName}</Typography>
          )}
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        {startedNotice && <Alert severity="success" sx={{ mb: 2 }}>{startedNotice}</Alert>}
        {startError && <Alert severity="error" sx={{ mb: 2 }}>{startError}</Alert>}

        {items.length === 0 ? (
          <Alert severity="info">Nenhum plano de promoção para este produto.</Alert>
        ) : (
          <>
            <Alert severity={nothingPending ? "info" : "warning"} sx={{ mb: 2 }}>
              {nothingPending
                ? "Este produto já começou. A ordem abaixo é o plano gravado na promoção."
                : `${items.length} projeto(s) admitidos na fábrica em ${waves.length} onda(s). ` +
                  "NADA foi iniciado — a onda 1 só roda quando você mandar."}
            </Alert>

            {(meta?.warnings ?? []).length > 0 && (
              <Alert severity="warning" icon={<WarningAmberIcon />} sx={{ mb: 2 }}>
                <Typography variant="caption" fontWeight={700} sx={{ display: "block", mb: 0.5 }}>
                  Ajustes feitos sobre a ordem proposta pelo agente
                </Typography>
                <Stack component="ul" sx={{ pl: 2, m: 0 }} spacing={0.25}>
                  {(meta?.warnings ?? []).map((w, i) => (
                    <Typography key={i} component="li" variant="caption">{w}</Typography>
                  ))}
                </Stack>
              </Alert>
            )}

            <Stack spacing={1.5}>
              {waves.map((w) => (
                <Box key={w.wave}>
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
                    <Chip
                      size="small"
                      color={w.wave === pendingWave ? "success" : "default"}
                      variant={w.wave === pendingWave ? "filled" : "outlined"}
                      label={`Onda ${w.wave}`}
                      sx={{ fontSize: "0.62rem", height: 20, fontWeight: 700 }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {w.wave === 1
                        ? "sem dependência interna — entra primeiro"
                        : "entra quando a onda anterior for aceita"}
                    </Typography>
                  </Stack>
                  <Stack spacing={0.75} sx={{ pl: 1, borderLeft: "2px solid", borderColor: "divider" }}>
                    {w.items.map((it) => {
                      const st = statusLabel(it.status);
                      return (
                        <Box key={it.projectId} sx={{ pl: 1 }}>
                          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                            <Typography variant="body2" fontWeight={600} sx={{ minWidth: 0 }}>
                              {it.position}. {it.title ?? it.projectId}
                            </Typography>
                            {it.layer && (
                              <Chip size="small" variant="outlined" label={it.layer}
                                sx={{ fontSize: "0.58rem", height: 17 }} />
                            )}
                            {it.status && (
                              <Chip size="small" color={st.color} variant="outlined" label={st.label}
                                sx={{ fontSize: "0.58rem", height: 17 }} />
                            )}
                          </Stack>
                          {(it.dependsOn ?? []).length > 0 && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                              depende de: {(it.dependsOn ?? []).map((d) => titleById.get(d) ?? d).join(", ")}
                            </Typography>
                          )}
                          {it.rationale && (
                            <Tooltip title={it.rationale}>
                              <Typography variant="caption" color="text.secondary"
                                sx={{ display: "block", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {it.rationale}
                              </Typography>
                            </Tooltip>
                          )}
                        </Box>
                      );
                    })}
                  </Stack>
                </Box>
              ))}
            </Stack>

            {(meta?.notes || meta?.edgesSource || meta?.modelUsed) && (
              <>
                <Divider sx={{ my: 2 }} />
                {meta?.notes && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
                    {meta.notes}
                  </Typography>
                )}
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                  {meta?.edgesSource && (
                    <Tooltip title={meta.edgesSource === "triggers"
                      ? "O produto já tinha dependências registradas no banco — elas mandam na ordem."
                      : "Não havia dependência registrada no banco: a ordem saiu do agente arquiteto."}>
                      <Chip size="small" variant="outlined"
                        label={meta.edgesSource === "triggers" ? "arestas: banco + agente" : "arestas: só agente"}
                        sx={{ fontSize: "0.58rem", height: 18 }} />
                    </Tooltip>
                  )}
                  {meta?.modelUsed && (
                    <Chip size="small" variant="outlined" label={meta.modelUsed}
                      sx={{ fontSize: "0.58rem", height: 18, "& .MuiChip-label": { fontFamily: "monospace" } }} />
                  )}
                </Stack>
              </>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={starting} color="inherit">Fechar</Button>
        {onStart && pendingWave != null && (
          <Button
            variant="contained" color="success"
            startIcon={starting ? <CircularProgress size={14} color="inherit" /> : <PlayArrowRoundedIcon />}
            disabled={starting}
            onClick={onStart}
          >
            {starting ? "Iniciando…" : `Iniciar onda ${pendingWave}`}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default PromotionPlanDialog;
