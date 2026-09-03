"use client";
/**
 * SpecTreePanel — RFC-0004 Onda 4 (F3): árvore + editor por arquivo da SPEC.
 *
 * Aparece SÓ quando a spec tem 2+ arquivos (spec de arquivo único mantém o layout
 * clássico do /spec — decisão D8: evoluir o editor existente, nunca uma 2ª página).
 * Editor com If-Match (baseSha): conflito de concorrência → 409 → oferece recarregar.
 * Criar/excluir arquivo via família /spec-file (guardas no servidor: status, runner,
 * traversal, tetos). O arquivo PRIMÁRIO é rotulado e não pode ser removido.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import SaveIcon from "@mui/icons-material/Save";
import RefreshIcon from "@mui/icons-material/Refresh";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";

interface TreeFile { path: string; ext: string; isPrimary: boolean; contentSha256: string | null }
interface TreeResponse { files: TreeFile[]; editable: boolean; status: string; totalFiles: number }
interface FileResponse { path: string; content: string; contentSha256: string; isPrimary: boolean; editable: boolean }

export default function SpecTreePanel({ projectId, onFileSelected }: {
  projectId: string;
  /** Notifica o pai (chat usa o arquivo selecionado como contexto). */
  onFileSelected?: (f: { path: string; content: string; baseSha: string } | null) => void;
}) {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [baseSha, setBaseSha] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"load" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const loadTree = useCallback(async () => {
    try {
      const t = await apiGet<TreeResponse>(`/api/projects/${projectId}/spec-tree`);
      setTree(t);
      return t;
    } catch { return null; }
  }, [projectId]);

  useEffect(() => { void loadTree(); }, [loadTree]);

  const openFile = useCallback(async (p: string) => {
    setBusy("load"); setError(null); setConflict(false);
    try {
      const f = await apiGet<FileResponse>(`/api/projects/${projectId}/spec-file?path=${encodeURIComponent(p)}`);
      setSelected(p); setContent(f.content); setBaseSha(f.contentSha256); setDirty(false);
      onFileSelected?.({ path: p, content: f.content, baseSha: f.contentSha256 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao abrir arquivo");
    } finally { setBusy(null); }
  }, [projectId, onFileSelected]);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy("save"); setError(null); setConflict(false);
    try {
      const r = await apiPut<{ ok: boolean; contentSha256: string }>(
        `/api/projects/${projectId}/spec-file?path=${encodeURIComponent(selected)}`,
        { content, baseSha },
      );
      setBaseSha(r.contentSha256); setDirty(false);
      onFileSelected?.({ path: selected, content, baseSha: r.contentSha256 });
      void loadTree();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("CONFLICT") || msg.includes("mudou desde")) setConflict(true);
      else setError(msg);
    } finally { setBusy(null); }
  }, [projectId, selected, content, baseSha, loadTree, onFileSelected]);

  const createFile = useCallback(async () => {
    const p = window.prompt("Caminho do novo arquivo (ex.: backend/02-fila.md):");
    if (!p) return;
    try {
      await apiPost(`/api/projects/${projectId}/spec-file`, { path: p, content: `# ${p}\n\n` });
      await loadTree(); await openFile(p);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao criar"); }
  }, [projectId, loadTree, openFile]);

  const removeFile = useCallback(async (p: string) => {
    if (!window.confirm(`Remover ${p}?`)) return;
    try {
      await apiDelete(`/api/projects/${projectId}/spec-file?path=${encodeURIComponent(p)}`);
      if (selected === p) { setSelected(null); setContent(""); onFileSelected?.(null); }
      await loadTree();
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao remover"); }
  }, [projectId, selected, loadTree, onFileSelected]);

  const grouped = useMemo(() => {
    const dirs = new Map<string, TreeFile[]>();
    for (const f of tree?.files ?? []) {
      const idx = f.path.lastIndexOf("/");
      const dir = idx === -1 ? "" : f.path.slice(0, idx);
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir)!.push(f);
    }
    return Array.from(dirs.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [tree]);

  // Spec de arquivo único (ou árvore indisponível): o layout clássico cuida — nada aqui.
  if (!tree || tree.files.length <= 1) return null;

  const editable = tree.editable;
  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1.5, overflow: "hidden", mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 0.75, bgcolor: "action.hover" }}>
        <DescriptionOutlinedIcon sx={{ fontSize: "1rem" }} />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>Árvore da especificação ({tree.totalFiles} arquivos)</Typography>
        {!editable && <Chip size="small" color="warning" label={`bloqueada (${tree.status})`} />}
        {editable && (
          <Button size="small" startIcon={<AddIcon />} onClick={createFile}>Novo arquivo</Button>
        )}
      </Stack>
      <Stack direction={{ xs: "column", md: "row" }} sx={{ minHeight: 320 }}>
        <Box sx={{ width: { xs: "100%", md: 260 }, maxHeight: { xs: 180, md: 480 }, overflow: "auto", borderRight: { md: "1px solid" }, borderColor: { md: "divider" } }}>
          <List dense disablePadding>
            {grouped.map(([dir, files]) => (
              <Box key={dir || "(raiz)"}>
                {dir && (
                  <Typography variant="caption" sx={{ px: 1.5, pt: 1, display: "block", color: "text.secondary" }}>
                    {dir}/
                  </Typography>
                )}
                {files.map((f) => (
                  <ListItemButton key={f.path} selected={selected === f.path} onClick={() => void openFile(f.path)} sx={{ py: 0.25 }}>
                    <ListItemText
                      primary={f.path.split("/").pop()}
                      primaryTypographyProps={{ fontSize: "0.82rem", fontFamily: "monospace" }}
                    />
                    {f.isPrimary && <Chip size="small" label="principal" sx={{ height: 18, fontSize: "0.62rem" }} />}
                    {editable && !f.isPrimary && (
                      <IconButton size="small" edge="end" onClick={(e) => { e.stopPropagation(); void removeFile(f.path); }}>
                        <DeleteOutlineIcon sx={{ fontSize: "0.95rem" }} />
                      </IconButton>
                    )}
                  </ListItemButton>
                ))}
              </Box>
            ))}
          </List>
        </Box>
        <Box sx={{ flex: 1, p: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
          {!selected && <Typography variant="body2" color="text.secondary">Selecione um arquivo para editar.</Typography>}
          {selected && (
            <>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="caption" sx={{ fontFamily: "monospace", flex: 1 }}>{selected}</Typography>
                <Button size="small" startIcon={busy === "save" ? <CircularProgress size={14} /> : <SaveIcon />}
                        disabled={!editable || !dirty || busy !== null} onClick={() => void save()}>
                  Salvar
                </Button>
              </Stack>
              {conflict && (
                <Alert severity="warning" action={
                  <Button size="small" startIcon={<RefreshIcon />} onClick={() => void openFile(selected)}>Recarregar</Button>
                }>
                  O arquivo mudou em outra aba/sessão. Recarregue antes de salvar (sua edição atual será perdida).
                </Alert>
              )}
              {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
              <TextField
                multiline minRows={14} maxRows={26} fullWidth value={content}
                onChange={(e) => { setContent(e.target.value); setDirty(true); }}
                disabled={!editable || busy !== null}
                InputProps={{ sx: { fontFamily: "monospace", fontSize: "0.82rem" } }}
              />
            </>
          )}
        </Box>
      </Stack>
    </Box>
  );
}
