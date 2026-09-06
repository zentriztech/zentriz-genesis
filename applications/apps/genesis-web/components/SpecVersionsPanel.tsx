"use client";
/**
 * SpecVersionsPanel — Onda 4 (A4.3): a rede de segurança da spec (G2) finalmente VISÍVEL.
 *
 * Contexto medido em 2026-09-05: cinco rodadas do modo autônomo levaram a spec do NVX LastMile de
 * 14 para 7 seções, e só foi possível recuperar porque existia um backup MANUAL. A migração 092
 * passou a guardar a versão ANTERIOR de cada escrita — mas o histórico só era alcançável por
 * `SELECT` no psql. Este painel é o caminho do humano: ver o que havia antes e voltar.
 *
 * Duas regras de contrato que a UI respeita (e por isso a listagem é enxuta):
 *  • a listagem traz só METADADOS — o conteúdo vem por versão, sob demanda (10 versões × ~100 kB
 *    por arquivo é spec inteira viajando a cada abertura de aba);
 *  • restaurar guarda o conteúdo VIVO como versão nova ANTES de sobrescrever. Por isso a ação é
 *    reversível, e é isso que o diálogo de confirmação promete ao usuário.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import HistoryIcon from "@mui/icons-material/History";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestoreIcon from "@mui/icons-material/Restore";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { ApiError, apiGet, apiPost } from "@/lib/api";

export interface SpecVersionWire {
  id: string;
  path: string;
  chars: number;
  contentSha256: string;
  reason: string;
  createdBy: string | null;
  createdAt: string;
}
interface VersionsResponse { projectId: string; editable: boolean; versions: SpecVersionWire[] }
/** Referência estável para o "sem versões" (um `[]` novo a cada render invalidaria o useMemo). */
const EMPTY: SpecVersionWire[] = [];
interface VersionContent { id: string; path: string; content: string; contentSha256: string }

/**
 * O `reason` é gravado pelo produtor da escrita (`autonomy:round-3`, `manual-patch`, …). Aqui só
 * traduzimos os prefixos conhecidos para PT-BR; o valor cru é o fallback — um motivo novo aparece
 * como está em vez de virar "desconhecido" (o histórico é auditoria, não pode esconder nada).
 */
export function describeReason(reason: string): string {
  const r = (reason || "").trim();
  if (r.startsWith("autonomy:round-")) return `Modo autônomo — rodada ${r.slice("autonomy:round-".length)}`;
  if (r.startsWith("pre-restore:")) return "Antes de uma restauração";
  if (r === "manual-file-edit") return "Edição humana (editor de arquivo)";
  if (r === "manual-patch") return "Edição humana (editor da spec)";
  if (r === "spec-chat") return "Revisão do CTO (chat)";
  if (r === "evolution") return "Evolução do produto";
  return r || "—";
}

/** "há 3 min" / "há 2 h" / "há 4 d" — o timestamp completo fica no tooltip. */
function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}

export default function SpecVersionsPanel({ projectId, activeFilePath = null, onRestored, reloadSignal }: {
  projectId: string;
  /** Arquivo aberto no editor: liga o filtro "só este arquivo" (ligado por default quando há um). */
  activeFilePath?: string | null;
  /** O pai recarrega a spec do servidor e a árvore — o editor não pode ficar com o texto velho. */
  onRestored?: (path: string) => void;
  reloadSignal?: number;
}) {
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyActive, setOnlyActive] = useState(Boolean(activeFilePath));
  const [viewing, setViewing] = useState<{ meta: SpecVersionWire; content: string } | null>(null);
  const [confirm, setConfirm] = useState<SpecVersionWire | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Trocar de arquivo no editor volta o filtro ao estado natural (o arquivo que o humano está vendo).
  useEffect(() => { setOnlyActive(Boolean(activeFilePath)); }, [activeFilePath]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // O filtro por arquivo é do SERVIDOR (o `path` relativo é resolvido no `file_path` absoluto):
      // filtrar no cliente exigiria baixar o histórico de todos os arquivos para descartar quase tudo.
      const qs = onlyActive && activeFilePath ? `?path=${encodeURIComponent(activeFilePath)}` : "";
      setData(await apiGet<VersionsResponse>(`/api/projects/${projectId}/spec-versions${qs}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar as versões");
    } finally { setLoading(false); }
  }, [projectId, onlyActive, activeFilePath]);

  useEffect(() => { void load(); }, [load, reloadSignal]);

  const view = useCallback(async (meta: SpecVersionWire) => {
    setBusy(meta.id); setError(null);
    try {
      const c = await apiGet<VersionContent>(`/api/projects/${projectId}/spec-versions/${meta.id}`);
      setViewing({ meta, content: c.content });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao abrir a versão");
    } finally { setBusy(null); }
  }, [projectId]);

  const restore = useCallback(async (meta: SpecVersionWire) => {
    setBusy(meta.id); setError(null); setFlash(null);
    try {
      const r = await apiPost<{ ok: boolean; unchanged?: boolean; path: string }>(
        `/api/projects/${projectId}/spec-versions/${meta.id}/restore`, {});
      setConfirm(null); setViewing(null);
      setFlash(r.unchanged
        ? `${r.path} já estava idêntico a esta versão — nada foi alterado.`
        : `${r.path} restaurado. O conteúdo anterior virou uma nova versão nesta lista.`);
      onRestored?.(r.path);
      await load();
    } catch (e) {
      // Os três "não" que o servidor pode dar têm causa diferente — e ação diferente.
      const code = e instanceof ApiError ? e.code : undefined;
      setError(
        code === "FILE_GONE" ? "O arquivo desta versão não existe mais na árvore da spec. Recrie o arquivo e cole o conteúdo (use “Ver”)."
        : code === "SNAPSHOT_FAILED" ? "Não foi possível guardar a versão atual antes de restaurar — por segurança, nada foi alterado. Tente de novo."
        : code === "SPEC_LOCKED" ? "A spec está bloqueada para edição (projeto em execução). Pare o projeto ou use Evoluir."
        : e instanceof Error ? e.message : "Falha ao restaurar",
      );
    } finally { setBusy(null); }
  }, [projectId, onRestored, load]);

  const versions = data?.versions ?? EMPTY;
  const editable = data?.editable ?? false;
  // A coluna "Arquivo" só aparece quando há mais de um — numa spec de arquivo único ela é ruído.
  const multiFile = useMemo(() => new Set((data?.versions ?? EMPTY).map((v) => v.path)).size > 1, [data]);

  return (
    <Box sx={{ p: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1, rowGap: 0.5 }}>
        <HistoryIcon sx={{ fontSize: "1rem", color: "text.secondary" }} />
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 140 }}>
          Versões da especificação
          {versions.length > 0 && <Chip size="small" label={versions.length} sx={{ ml: 1, height: 18, fontSize: "0.62rem" }} />}
        </Typography>
        {activeFilePath && (
          <FormControlLabel
            control={<Switch size="small" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />}
            label={<Typography variant="caption">Só {activeFilePath.split("/").pop()}</Typography>}
            sx={{ mr: 0 }}
          />
        )}
        <Tooltip title="Recarregar">
          <IconButton size="small" onClick={() => void load()} disabled={loading}><RefreshIcon fontSize="small" /></IconButton>
        </Tooltip>
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        Cada escrita da spec — sua, do CTO ou do modo autônomo — guarda antes o conteúdo que estava
        no lugar. Restaurar também guarda o texto atual, então dá para voltar atrás da volta.
      </Typography>

      {flash && <Alert severity="success" onClose={() => setFlash(null)} sx={{ mb: 1 }}>{flash}</Alert>}
      {error && <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 1 }}>{error}</Alert>}
      {!editable && !loading && (
        <Alert severity="info" sx={{ mb: 1 }}>
          Spec bloqueada para edição neste status — você pode ver as versões, mas não restaurar.
        </Alert>
      )}

      {loading && <Stack alignItems="center" sx={{ py: 3 }}><CircularProgress size={22} /></Stack>}

      {!loading && versions.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          Nenhuma versão guardada ainda. A primeira nasce na próxima escrita desta spec.
        </Typography>
      )}

      {!loading && versions.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Quando</TableCell>
              {multiFile && <TableCell>Arquivo</TableCell>}
              <TableCell>Origem</TableCell>
              <TableCell align="right">Tamanho</TableCell>
              <TableCell align="right">Ações</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {versions.map((v) => (
              <TableRow key={v.id} hover>
                <TableCell>
                  <Tooltip title={new Date(v.createdAt).toLocaleString("pt-BR")}>
                    <span>{ago(v.createdAt)}</span>
                  </Tooltip>
                </TableCell>
                {multiFile && (
                  <TableCell sx={{ fontFamily: "monospace", fontSize: "0.72rem", wordBreak: "break-all" }}>{v.path}</TableCell>
                )}
                <TableCell>
                  <Typography variant="caption">{describeReason(v.reason)}</Typography>
                </TableCell>
                <TableCell align="right">
                  <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {v.chars.toLocaleString("pt-BR")} car.
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                    <Tooltip title="Ver o conteúdo desta versão">
                      <span>
                        <IconButton size="small" onClick={() => void view(v)} disabled={busy !== null}>
                          {busy === v.id ? <CircularProgress size={14} /> : <VisibilityOutlinedIcon sx={{ fontSize: "1rem" }} />}
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title={editable ? "Restaurar esta versão" : "Spec bloqueada para edição"}>
                      <span>
                        <IconButton size="small" color="warning" onClick={() => setConfirm(v)} disabled={!editable || busy !== null}>
                          <RestoreIcon sx={{ fontSize: "1rem" }} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Ver: conteúdo cru, somente leitura — comparar é olho humano (diff fica p/ outra onda). */}
      <Dialog open={viewing !== null} onClose={() => setViewing(null)} fullWidth maxWidth="md">
        <DialogTitle sx={{ pr: 6 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="subtitle1" fontWeight={700} sx={{ fontFamily: "monospace" }}>{viewing?.meta.path}</Typography>
            <Chip size="small" label={describeReason(viewing?.meta.reason ?? "")} />
            <Chip size="small" variant="outlined" label={viewing ? new Date(viewing.meta.createdAt).toLocaleString("pt-BR") : ""} />
          </Stack>
          <IconButton onClick={() => setViewing(null)} aria-label="Fechar" sx={{ position: "absolute", right: 8, top: 8 }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Box component="pre" sx={{
            m: 0, fontFamily: "monospace", fontSize: "0.78rem", whiteSpace: "pre-wrap",
            wordBreak: "break-word", color: "text.primary",
          }}>{viewing?.content}</Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewing(null)}>Fechar</Button>
          {viewing && editable && (
            <Button color="warning" variant="contained" startIcon={<RestoreIcon />} onClick={() => setConfirm(viewing.meta)}>
              Restaurar esta versão
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} fullWidth maxWidth="sm">
        <DialogTitle>Restaurar esta versão?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            <b style={{ fontFamily: "monospace" }}>{confirm?.path}</b> volta ao conteúdo de{" "}
            {confirm ? new Date(confirm.createdAt).toLocaleString("pt-BR") : ""}{" "}
            ({confirm?.chars.toLocaleString("pt-BR")} caracteres, {describeReason(confirm?.reason ?? "").toLowerCase()}).
          </Typography>
          <Alert severity="info">
            O conteúdo que está lá agora é guardado como uma nova versão antes de ser substituído —
            se restaurar foi um erro, é possível voltar por esta mesma lista.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)} disabled={busy !== null}>Cancelar</Button>
          <Button color="warning" variant="contained" disabled={busy !== null}
            startIcon={busy !== null ? <CircularProgress size={14} color="inherit" /> : <RestoreIcon />}
            onClick={() => confirm && void restore(confirm)}>
            {busy !== null ? "Restaurando…" : "Restaurar"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
