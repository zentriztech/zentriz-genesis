"use client";

import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import FolderIcon from "@mui/icons-material/Folder";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import { apiGet } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────
interface CodeFile { path: string; sizeBytes: number; ext: string }

interface TreeNode {
  name: string;
  fullPath: string;
  type: "file" | "dir";
  ext?: string;
  sizeBytes?: number;
  children?: TreeNode[];
}

// ── Extension colours & icons ─────────────────────────────────────────────────
const EXT_COLOR: Record<string, string> = {
  tsx: "#61DAFB", ts: "#3178C6", js: "#F7DF1E", jsx: "#61DAFB",
  css: "#1572B6", scss: "#CC6699", json: "#F59E0B",
  md: "#8B949E", sh: "#10B981", py: "#3776AB", yml: "#10B981", yaml: "#10B981",
  sql: "#F59E0B", env: "#EF4444", gitignore: "#8B949E", prettierrc: "#F8B400",
};

// ── Build tree from flat file list ────────────────────────────────────────────
function buildTree(files: CodeFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  const getOrCreateDir = (parts: string[]): TreeNode[] => {
    if (parts.length === 0) return root;
    const fullPath = parts.join("/");
    if (dirMap.has(fullPath)) return dirMap.get(fullPath)!.children!;
    const parent = getOrCreateDir(parts.slice(0, -1));
    const node: TreeNode = { name: parts[parts.length - 1], fullPath, type: "dir", children: [] };
    parent.push(node);
    dirMap.set(fullPath, node);
    return node.children!;
  };

  for (const f of files) {
    const parts = f.path.split("/");
    const fileName = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);
    const dir = getOrCreateDir(dirParts);
    dir.push({ name: fileName, fullPath: f.path, type: "file", ext: f.ext, sizeBytes: f.sizeBytes });
  }

  // Sort: dirs first, then files, both alphabetical
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sort(n.children);
  };
  sort(root);
  return root;
}

// ── CodeMirror language resolver (dynamic import) ────────────────────────────
async function getLanguageExtension(ext: string) {
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": case "mjs": case "cjs": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: ext === "ts" || ext === "tsx", jsx: ext === "tsx" || ext === "jsx" });
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "css": case "scss": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "py": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    case "sql": {
      const { sql } = await import("@codemirror/lang-sql");
      return sql();
    }
    case "md": case "mdx": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    default:
      return null;
  }
}

// ── Tree node component ───────────────────────────────────────────────────────
function TreeItem({
  node, depth, selected, onSelect,
}: {
  node: TreeNode; depth: number; selected: string | null; onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isSelected = node.fullPath === selected;
  const color = node.ext ? (EXT_COLOR[node.ext] ?? "#8B949E") : undefined;

  if (node.type === "dir") {
    return (
      <Box>
        <Box
          onClick={() => setOpen((o) => !o)}
          sx={{
            display: "flex", alignItems: "center", gap: 0.5,
            pl: depth * 1.5 + 0.5, pr: 1, py: 0.3, cursor: "pointer",
            borderRadius: 0.5, "&:hover": { bgcolor: "#21262D" },
            userSelect: "none",
          }}
        >
          {open ? <ExpandMoreIcon sx={{ fontSize: "0.9rem", color: "#8B949E", flexShrink: 0 }} />
                : <ChevronRightIcon sx={{ fontSize: "0.9rem", color: "#8B949E", flexShrink: 0 }} />}
          {open ? <FolderOpenIcon sx={{ fontSize: "0.85rem", color: "#F59E0B", flexShrink: 0 }} />
                : <FolderIcon sx={{ fontSize: "0.85rem", color: "#F59E0B", flexShrink: 0 }} />}
          <Typography variant="caption" sx={{ color: "#E6EDF3", fontSize: "0.75rem" }}>{node.name}</Typography>
        </Box>
        {open && node.children?.map((child) => (
          <TreeItem key={child.fullPath} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
      </Box>
    );
  }

  return (
    <Box
      onClick={() => onSelect(node.fullPath)}
      sx={{
        display: "flex", alignItems: "center", gap: 0.75,
        pl: depth * 1.5 + 1.5, pr: 1, py: 0.3, cursor: "pointer",
        borderRadius: 0.5,
        bgcolor: isSelected ? "#6366F122" : "transparent",
        borderLeft: isSelected ? "2px solid #6366F1" : "2px solid transparent",
        "&:hover": { bgcolor: isSelected ? "#6366F130" : "#21262D" },
      }}
    >
      <InsertDriveFileIcon sx={{ fontSize: "0.75rem", color: color ?? "#8B949E", flexShrink: 0 }} />
      <Typography
        variant="caption"
        noWrap
        sx={{ color: isSelected ? "#E6EDF3" : "#C9D1D9", fontSize: "0.73rem", flexGrow: 1 }}
      >
        {node.name}
      </Typography>
      {node.sizeBytes != null && (
        <Typography variant="caption" sx={{ color: "#484F58", fontSize: "0.65rem", flexShrink: 0 }}>
          {node.sizeBytes >= 1024 ? `${(node.sizeBytes/1024).toFixed(1)}k` : `${node.sizeBytes}b`}
        </Typography>
      )}
    </Box>
  );
}

// ── Code viewer (CodeMirror) ──────────────────────────────────────────────────
function CodeViewer({ projectId, filePath, ext }: { projectId: string; filePath: string; ext: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied]   = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [cmExtensions, setCmExtensions] = useState<any[]>([]);

  useEffect(() => {
    setLoading(true);
    setContent(null);
    Promise.all([
      apiGet<{ content: string; path: string }>(`/api/projects/${projectId}/file-content?path=${encodeURIComponent(filePath)}`),
      getLanguageExtension(ext),
    ])
      .then(([{ content: raw }, lang]) => {
        setContent(raw);
        setCmExtensions(lang ? [lang] : []);
      })
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, [projectId, filePath, ext]);

  // Lazy-load CodeMirror component (heavy — only when a file is selected)
  const [CodeMirrorComp, setCodeMirrorComp] = useState<React.ComponentType<{
    value: string;
    extensions: unknown[];
    theme: unknown;
    readOnly: boolean;
    height: string;
    style: React.CSSProperties;
    basicSetup: Record<string, unknown>;
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

  const color = EXT_COLOR[ext] ?? "#8B949E";
  const lineCount = content ? content.split("\n").length : 0;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <Stack direction="row" alignItems="center" spacing={1}
        sx={{ px: 1.5, py: 0.75, borderBottom: "1px solid #21262D", bgcolor: "#161B22", flexShrink: 0 }}>
        <InsertDriveFileIcon sx={{ fontSize: "0.8rem", color }} />
        <Typography variant="caption" sx={{ color: "#E6EDF3", fontSize: "0.75rem", fontFamily: "monospace", flexGrow: 1 }}>
          {filePath}
        </Typography>
        {!loading && content && (
          <Typography variant="caption" sx={{ color: "#484F58", fontSize: "0.65rem" }}>
            {lineCount} linhas
          </Typography>
        )}
        <Chip label={`.${ext}`} size="small" sx={{ bgcolor: `${color}22`, color, border: `1px solid ${color}40`, fontSize: "0.6rem", height: 18 }} />
        {content && (
          <Tooltip title={copied ? "Copiado!" : "Copiar código"}>
            <IconButton size="small" onClick={() => navigator.clipboard.writeText(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
              <ContentCopyIcon sx={{ fontSize: "0.8rem", color: copied ? "#10B981" : "#8B949E" }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {/* Code area */}
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
            value={content}
            extensions={cmExtensions}
            theme={vscodeDark}
            readOnly={true}
            height="100%"
            style={{ height: "100%" }}
            basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, highlightSelectionMatches: false }}
          />
        </Box>
      )}
    </Box>
  );
}

// ── Main CodeExplorer ─────────────────────────────────────────────────────────
interface CodeExplorerProps {
  projectId: string;
  files: CodeFile[];
  appsRoot: string | null;
  height?: number | string;
}

export function CodeExplorer({ projectId, files, appsRoot, height = 520 }: CodeExplorerProps) {
  const [selected, setSelected]     = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const tree = buildTree(files);
  const selectedFile = selected ? files.find((f) => f.path === selected) : null;

  const explorerContent = (h: number | string) => (
    <Box sx={{ display: "flex", height: h, overflow: "hidden", bgcolor: "#0D0F14", flex: 1 }}>
      {/* File tree */}
      <Box sx={{ width: 240, flexShrink: 0, overflowY: "auto", overflowX: "hidden", borderRight: "1px solid #21262D", bgcolor: "#0D1117", py: 0.5 }}>
        {appsRoot && (
          <Typography variant="caption" sx={{ display: "block", px: 1.5, pb: 0.5, color: "#484F58", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            apps/
          </Typography>
        )}
        {tree.map((node) => (
          <TreeItem key={node.fullPath} node={node} depth={0} selected={selected} onSelect={setSelected} />
        ))}
      </Box>
      {/* Editor */}
      <Box sx={{ flexGrow: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {selected && selectedFile ? (
          <CodeViewer projectId={projectId} filePath={selected} ext={selectedFile.ext || "ts"} />
        ) : (
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", flexGrow: 1, flexDirection: "column", gap: 1 }}>
            <InsertDriveFileIcon sx={{ fontSize: "2rem", color: "#30363D" }} />
            <Typography variant="body2" color="text.secondary">Selecione um arquivo na árvore</Typography>
            <Typography variant="caption" color="text.secondary">{files.length} arquivos gerados</Typography>
          </Box>
        )}
      </Box>
    </Box>
  );

  return (
    <>
      {/* Normal view */}
      <Box sx={{ position: "relative", border: "1px solid #21262D", borderRadius: 1, overflow: "hidden", height, display: "flex", flexDirection: "column" }}>
        {/* Fullscreen button */}
        <Tooltip title="Tela cheia">
          <IconButton size="small" onClick={() => setFullscreen(true)}
            sx={{ position: "absolute", top: 6, right: 6, zIndex: 10, bgcolor: "#161B22", border: "1px solid #30363D", borderRadius: 1, p: 0.4, "&:hover": { bgcolor: "#21262D" } }}>
            <FullscreenIcon sx={{ fontSize: "1rem", color: "#8B949E" }} />
          </IconButton>
        </Tooltip>
        {explorerContent("100%")}
      </Box>

      {/* Fullscreen dialog */}
      <Dialog open={fullscreen} onClose={() => setFullscreen(false)} fullScreen
        PaperProps={{ sx: { bgcolor: "#0D0F14", m: 0 } }}>
        <DialogContent sx={{ p: 0, display: "flex", flexDirection: "column", height: "100vh" }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between"
            sx={{ px: 2, py: 1, borderBottom: "1px solid #30363D", flexShrink: 0 }}>
            <Typography variant="body2" fontWeight={600} color="text.primary">
              Explorador de Código — {files.length} arquivos
            </Typography>
            <Tooltip title="Sair de tela cheia">
              <IconButton onClick={() => setFullscreen(false)} size="small">
                <FullscreenExitIcon />
              </IconButton>
            </Tooltip>
          </Stack>
          <Box sx={{ flexGrow: 1, overflow: "hidden" }}>
            {explorerContent("100%")}
          </Box>
        </DialogContent>
      </Dialog>
    </>
  );
}
