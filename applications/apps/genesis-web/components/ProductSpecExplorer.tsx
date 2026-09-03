"use client";

// ProductSpecExplorer — redesign Bancada Onda 2.
// Editor estilo VSCode da "pasta do PRODUTO inteiro": mostra os arquivos de spec de
// TODOS os projetos do produto numa única árvore (cada projeto vira uma pasta de topo),
// análogo à aba "Código" da fábrica, mas por-produto e EDITÁVEL. O índice (árvore) vem
// de GET /api/products/:id/spec-tree; o conteúdo de cada arquivo é carregado/salvo sob
// demanda pelos endpoints por-projeto já endurecidos (GET/PUT /spec-file, If-Match).
//
// Reutiliza buildTree/TreeItem/EXT_COLOR/getLanguageExtension do CodeExplorer (a árvore
// e o realce são idênticos aos da fábrica) — aqui só trocamos o VIEWER read-only por um
// editor com salvamento otimista (baseSha) e status por projeto (running → só leitura).

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import SaveIcon from "@mui/icons-material/Save";
import RefreshIcon from "@mui/icons-material/Refresh";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { apiGet, apiPut } from "@/lib/api";
import { buildTree, TreeItem, EXT_COLOR, getLanguageExtension, type CodeFile } from "@/components/CodeExplorer";

export interface ProductSpecFile { path: string; ext: string; isPrimary: boolean; contentSha256: string | null }
export interface ProductSpecProject {
  projectId: string;
  title: string;
  status: string;
  editable: boolean;
  files: ProductSpecFile[];
}

// Referência resolvida de um arquivo na árvore do produto (path da árvore → arquivo real).
interface FileRef {
  projectId: string;
  projectTitle: string;
  specPath: string; // path por-projeto (rel_dir/filename) — o que o endpoint /spec-file espera
  ext: string;
  isPrimary: boolean;
  editable: boolean;
}

// Rótulo de pasta (topo da árvore) por projeto: título saneado (a árvore fatia por "/",
// então "/" no título quebraria a hierarquia) + desambiguação de homônimos por id curto.
function buildFolderLabels(projects: ProductSpecProject[]): Map<string, string> {
  const sanitize = (t: string) => (t || "Projeto").replace(/[/\\]/g, "-").trim() || "Projeto";
  const counts = new Map<string, number>();
  for (const p of projects) {
    const base = sanitize(p.title);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const p of projects) {
    const base = sanitize(p.title);
    labels.set(p.projectId, (counts.get(base) ?? 0) > 1 ? `${base} · ${p.projectId.slice(0, 8)}` : base);
  }
  return labels;
}

// ── Editor de um arquivo (CodeMirror editável + salvamento otimista via baseSha) ──
function SpecFileEditor({ file, onDirtyChange }: { file: FileRef; onDirtyChange?: (dirty: boolean) => void }) {
  const router = useRouter();
  const [content, setContent] = useState<string | null>(null); // conteúdo salvo (baseline)
  const [draft, setDraft] = useState("");
  const [baseSha, setBaseSha] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [cmExtensions, setCmExtensions] = useState<any[]>([]);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      apiGet<{ content: string; contentSha256: string }>(
        `/api/projects/${file.projectId}/spec-file?path=${encodeURIComponent(file.specPath)}`,
      ),
      getLanguageExtension(file.ext),
    ])
      .then(([res, lang]) => {
        setContent(res.content);
        setDraft(res.content);
        setBaseSha(res.contentSha256);
        setCmExtensions(lang ? [lang] : []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Falha ao carregar o arquivo"))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [file.projectId, file.specPath, file.ext]);

  // CodeMirror carregado sob demanda (pesado — só quando um arquivo é aberto).
  const [CodeMirrorComp, setCodeMirrorComp] = useState<React.ComponentType<{
    value: string;
    extensions: unknown[];
    theme: unknown;
    readOnly: boolean;
    height: string;
    style: React.CSSProperties;
    basicSetup: Record<string, unknown>;
    onChange?: (v: string) => void;
  }> | null>(null);
  const [vscodeDark, setVscodeDark] = useState<unknown>(null);
  useEffect(() => {
    Promise.all([
      import("@uiw/react-codemirror").then((m) => m.default),
      import("@uiw/codemirror-theme-vscode").then((m) => m.vscodeDark),
    ]).then(([cm, theme]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setCodeMirrorComp(() => cm as any);
      setVscodeDark(() => theme);
    });
  }, []);

  const dirty = content !== null && draft !== content;
  // Espelha o estado "sujo" para o pai poder avisar antes de trocar de arquivo (o editor
  // é remontado por `key={selected}`, então a troca descartaria o rascunho silenciosamente).
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]); // limpa no unmount
  const color = EXT_COLOR[file.ext] ?? "#8B949E";

  const save = async () => {
    if (!dirty || !file.editable || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiPut<{ contentSha256: string }>(
        `/api/projects/${file.projectId}/spec-file?path=${encodeURIComponent(file.specPath)}`,
        { content: draft, baseSha },
      );
      setContent(draft);
      setBaseSha(res.contentSha256);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1800);
    } catch (e) {
      // 409 CONFLICT vem como mensagem ("O arquivo mudou desde a sua leitura…") — o botão
      // Recarregar traz a versão nova para reaplicar a edição.
      setError(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <Stack direction="row" alignItems="center" spacing={1}
        sx={{ px: 1.5, py: 0.75, borderBottom: "1px solid #21262D", bgcolor: "#161B22", flexShrink: 0, flexWrap: "wrap", rowGap: 0.5 }}>
        <InsertDriveFileIcon sx={{ fontSize: "0.8rem", color }} />
        <Typography variant="caption" sx={{ color: "#E6EDF3", fontSize: "0.75rem", fontFamily: "monospace", flexGrow: 1, minWidth: 120 }}>
          <span style={{ color: "#8B949E" }}>{file.projectTitle}/</span>{file.specPath}
        </Typography>
        {dirty && <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "#F59E0B" }} title="Alterações não salvas" />}
        <Chip label={`.${file.ext || "txt"}`} size="small" sx={{ bgcolor: `${color}22`, color, border: `1px solid ${color}40`, fontSize: "0.6rem", height: 18 }} />
        {!file.editable && (
          <Chip icon={<LockOutlinedIcon sx={{ fontSize: "0.7rem" }} />} label="somente leitura" size="small"
            sx={{ fontSize: "0.6rem", height: 18, bgcolor: "#F59E0B22", color: "#F59E0B", border: "1px solid #F59E0B40" }} />
        )}
        <Tooltip title="Recarregar do servidor">
          <span>
            <IconButton size="small" onClick={load} disabled={loading || saving}>
              <RefreshIcon sx={{ fontSize: "0.85rem", color: "#8B949E" }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Abrir editor completo do projeto (chat + validação)">
          <IconButton size="small" onClick={() => router.push(`/spec?editProjectId=${file.projectId}`)}>
            <OpenInNewIcon sx={{ fontSize: "0.85rem", color: "#8B949E" }} />
          </IconButton>
        </Tooltip>
        {file.editable && (
          <Button size="small" variant="contained" color="success"
            startIcon={saving ? <CircularProgress size={12} color="inherit" /> : <SaveIcon sx={{ fontSize: "0.85rem" }} />}
            disabled={!dirty || saving} onClick={save}
            sx={{ minHeight: 26, py: 0.25, fontSize: "0.68rem", textTransform: "none" }}>
            {savedTick ? "Salvo!" : "Salvar"}
          </Button>
        )}
      </Stack>

      {error && (
        <Alert severity="warning" sx={{ borderRadius: 0, py: 0.25, fontSize: "0.72rem" }} onClose={() => setError(null)}
          action={<Button color="inherit" size="small" onClick={load}>Recarregar</Button>}>
          {error}
        </Alert>
      )}

      {/* Área de código */}
      {loading || !CodeMirrorComp || vscodeDark === null ? (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", flexGrow: 1, bgcolor: "#0D0F14" }}>
          <CircularProgress size={20} />
        </Box>
      ) : content == null ? (
        <Box sx={{ p: 2, bgcolor: "#0D0F14", flexGrow: 1 }}>
          <Typography variant="caption" color="error">Não foi possível carregar o arquivo.</Typography>
        </Box>
      ) : (
        <Box sx={{
          flexGrow: 1, overflow: "auto", bgcolor: "#0D0F14",
          "& .cm-editor": { height: "100%", fontSize: "0.75rem" },
          "& .cm-scroller": { fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace", lineHeight: 1.7 },
          "& .cm-gutters": { bgcolor: "#0D1117", borderRight: "1px solid #21262D", color: "#484F58" },
          "& .cm-activeLineGutter": { bgcolor: "#161B22" },
          "& .cm-activeLine": { bgcolor: "#6366F110" },
        }}>
          <CodeMirrorComp
            value={draft}
            extensions={cmExtensions}
            theme={vscodeDark}
            readOnly={!file.editable}
            height="100%"
            style={{ height: "100%" }}
            basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, highlightSelectionMatches: false }}
            onChange={file.editable ? (v: string) => setDraft(v) : undefined}
          />
        </Box>
      )}
    </Box>
  );
}

// ── Explorer principal ────────────────────────────────────────────────────────
interface ProductSpecExplorerProps {
  projects: ProductSpecProject[];
  height?: number | string;
  truncated?: boolean;
  totalFiles?: number;
  /** Força somente-leitura em TODOS os arquivos (ex.: conta de gestão/master, que só visualiza). */
  readOnly?: boolean;
}

export function ProductSpecExplorer({ projects, height = 560, truncated = false, totalFiles, readOnly = false }: ProductSpecExplorerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  // Rastreia se o arquivo aberto tem edições não salvas — para confirmar antes de trocar.
  const dirtyRef = useRef(false);
  const selectFile = (next: string) => {
    if (next === selected) return;
    if (dirtyRef.current && typeof window !== "undefined" &&
      !window.confirm("Há alterações não salvas neste arquivo. Descartá-las e abrir outro?")) {
      return;
    }
    dirtyRef.current = false;
    setSelected(next);
  };

  // Constrói a lista plana p/ a árvore (path = "<pasta do projeto>/<path por-projeto>")
  // + índice reverso path-da-árvore → FileRef (projeto/arquivo real).
  const { fileList, index } = useMemo(() => {
    const labels = buildFolderLabels(projects);
    const list: CodeFile[] = [];
    const idx = new Map<string, FileRef>();
    for (const p of projects) {
      const label = labels.get(p.projectId) ?? p.projectId.slice(0, 8);
      for (const f of p.files) {
        const treePath = `${label}/${f.path}`;
        list.push({ path: treePath, ext: f.ext });
        idx.set(treePath, {
          projectId: p.projectId,
          projectTitle: label,
          specPath: f.path,
          ext: f.ext,
          isPrimary: f.isPrimary,
          editable: p.editable && !readOnly,
        });
      }
    }
    return { fileList: list, index: idx };
  }, [projects, readOnly]);

  const tree = useMemo(() => buildTree(fileList), [fileList]);
  const selectedRef = selected ? index.get(selected) ?? null : null;

  return (
    <Box sx={{ border: "1px solid #21262D", borderRadius: 1, overflow: "hidden", height, display: "flex", flexDirection: "column" }}>
      <Box sx={{ display: "flex", flexDirection: { xs: "column", md: "row" }, flex: 1, overflow: "hidden", bgcolor: "#0D0F14" }}>
        {/* Árvore */}
        <Box sx={{ width: { xs: "100%", md: 280 }, flexShrink: 0, maxHeight: { xs: "40%", md: "none" }, display: "flex", flexDirection: "column", borderRight: { xs: "none", md: "1px solid #21262D" }, borderBottom: { xs: "1px solid #21262D", md: "none" }, bgcolor: "#0D1117" }}>
          <Box sx={{ flexShrink: 0, px: 1.5, py: 1, borderBottom: "1px solid #21262D" }}>
            <Typography variant="caption" sx={{ color: "#8B949E", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Pasta do produto · {fileList.length} arquivo(s)
            </Typography>
            {truncated && (
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                <WarningAmberIcon sx={{ fontSize: "0.8rem", color: "#F59E0B", flexShrink: 0 }} />
                <Typography variant="caption" sx={{ color: "#F59E0B", fontSize: "0.62rem", lineHeight: 1.3 }}>
                  Lista truncada{typeof totalFiles === "number" ? ` (${fileList.length} de ${totalFiles})` : ""}.
                </Typography>
              </Stack>
            )}
          </Box>
          <Box sx={{ flexGrow: 1, overflowY: "auto", overflowX: "hidden", py: 0.5 }}>
            {tree.length === 0 ? (
              <Typography variant="caption" sx={{ display: "block", px: 1.5, py: 1, color: "#484F58", fontSize: "0.7rem" }}>
                Este produto ainda não tem arquivos de spec.
              </Typography>
            ) : (
              tree.map((node) => (
                <TreeItem key={node.fullPath} node={node} depth={0} selected={selected} onSelect={selectFile} />
              ))
            )}
          </Box>
        </Box>
        {/* Editor */}
        <Box sx={{ flexGrow: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {selectedRef ? (
            <SpecFileEditor key={selected} file={selectedRef} onDirtyChange={(d) => { dirtyRef.current = d; }} />
          ) : (
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", flexGrow: 1, flexDirection: "column", gap: 1 }}>
              <InsertDriveFileIcon sx={{ fontSize: "2rem", color: "#30363D" }} />
              <Typography variant="body2" color="text.secondary">Selecione um arquivo na árvore do produto</Typography>
              <Typography variant="caption" color="text.secondary">{fileList.length} arquivo(s) de spec</Typography>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
