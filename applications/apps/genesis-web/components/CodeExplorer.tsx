"use client";

import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
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

// ── Syntax highlight via highlight.js (dynamic import) ───────────────────────
async function highlightCode(code: string, ext: string): Promise<string> {
  try {
    const hljs = (await import("highlight.js/lib/core")).default;
    const langMap: Record<string, () => Promise<{ default: unknown }>> = {
      ts:  () => import("highlight.js/lib/languages/typescript"),
      tsx: () => import("highlight.js/lib/languages/typescript"),
      js:  () => import("highlight.js/lib/languages/javascript"),
      jsx: () => import("highlight.js/lib/languages/javascript"),
      json:() => import("highlight.js/lib/languages/json"),
      css: () => import("highlight.js/lib/languages/css"),
      sql: () => import("highlight.js/lib/languages/sql"),
      sh:  () => import("highlight.js/lib/languages/bash"),
      bash:() => import("highlight.js/lib/languages/bash"),
      yml: () => import("highlight.js/lib/languages/yaml"),
      yaml:() => import("highlight.js/lib/languages/yaml"),
      py:  () => import("highlight.js/lib/languages/python"),
      md:  () => import("highlight.js/lib/languages/markdown"),
    };
    const loader = langMap[ext] ?? langMap["ts"];
    if (loader) {
      const mod = await loader();
      const lang = (mod as { default: unknown }).default;
      if (lang && !hljs.getLanguage(ext)) hljs.registerLanguage(ext, lang as Parameters<typeof hljs.registerLanguage>[1]);
    }
    const result = hljs.highlight(code, { language: ext, ignoreIllegals: true });
    return result.value;
  } catch {
    // Fallback: escape HTML
    return code.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
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

// ── Code viewer ───────────────────────────────────────────────────────────────
function CodeViewer({ projectId, filePath, ext }: { projectId: string; filePath: string; ext: string }) {
  const [html, setHtml]       = useState<string | null>(null);
  const [raw, setRaw]         = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied]   = useState(false);
  const lineCount = useRef(0);

  useEffect(() => {
    setLoading(true);
    setHtml(null);
    apiGet<{ content: string; path: string }>(`/api/projects/${projectId}/file-content?path=${encodeURIComponent(filePath)}`)
      .then(async ({ content }) => {
        setRaw(content);
        lineCount.current = content.split("\n").length;
        const highlighted = await highlightCode(content, ext);
        setHtml(highlighted);
      })
      .catch(() => setHtml(null))
      .finally(() => setLoading(false));
  }, [projectId, filePath, ext]);

  const color = EXT_COLOR[ext] ?? "#8B949E";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <Stack direction="row" alignItems="center" spacing={1}
        sx={{ px: 1.5, py: 0.75, borderBottom: "1px solid #21262D", bgcolor: "#161B22", flexShrink: 0 }}>
        <InsertDriveFileIcon sx={{ fontSize: "0.8rem", color }} />
        <Typography variant="caption" sx={{ color: "#E6EDF3", fontSize: "0.75rem", fontFamily: "monospace", flexGrow: 1 }}>
          {filePath}
        </Typography>
        {!loading && raw && (
          <Typography variant="caption" sx={{ color: "#484F58", fontSize: "0.65rem" }}>
            {lineCount.current} linhas
          </Typography>
        )}
        <Chip label={`.${ext}`} size="small" sx={{ bgcolor: `${color}22`, color, border: `1px solid ${color}40`, fontSize: "0.6rem", height: 18 }} />
        {raw && (
          <Tooltip title={copied ? "Copiado!" : "Copiar código"}>
            <IconButton size="small" onClick={() => navigator.clipboard.writeText(raw).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
              <ContentCopyIcon sx={{ fontSize: "0.8rem", color: copied ? "#10B981" : "#8B949E" }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {/* Code area */}
      {loading ? (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", flexGrow: 1, bgcolor: "#0D0F14" }}>
          <CircularProgress size={20} />
        </Box>
      ) : html == null ? (
        <Box sx={{ p: 2, bgcolor: "#0D0F14", flexGrow: 1 }}>
          <Typography variant="caption" color="error">Não foi possível carregar o arquivo.</Typography>
        </Box>
      ) : (
        <Box
          sx={{
            flexGrow: 1, overflow: "auto", bgcolor: "#0D0F14",
            "& pre": { m: 0, p: 0 },
            "& code": { fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace", fontSize: "0.75rem", lineHeight: 1.7 },
            // highlight.js github-dark tokens
            "& .hljs-keyword":    { color: "#ff7b72" },
            "& .hljs-string":     { color: "#a5d6ff" },
            "& .hljs-number":     { color: "#79c0ff" },
            "& .hljs-comment":    { color: "#8b949e", fontStyle: "italic" },
            "& .hljs-type, & .hljs-title": { color: "#ffa657" },
            "& .hljs-built_in":   { color: "#79c0ff" },
            "& .hljs-attr, & .hljs-attribute": { color: "#7ee787" },
            "& .hljs-variable":   { color: "#ffa657" },
            "& .hljs-meta":       { color: "#d2a8ff" },
            "& .hljs-function, & .hljs-title.function_": { color: "#d2a8ff" },
            "& .hljs-params":     { color: "#E6EDF3" },
            "& .hljs-operator":   { color: "#ff7b72" },
            "& .hljs-punctuation":{ color: "#8b949e" },
            "& .hljs-selector-class, & .hljs-selector-id": { color: "#ffa657" },
          }}
        >
          <Box sx={{ display: "flex" }}>
            {/* Line numbers */}
            <Box
              component="pre"
              sx={{
                flexShrink: 0, userSelect: "none", textAlign: "right",
                px: 1.5, py: 1.5,
                color: "#484F58", fontSize: "0.73rem", fontFamily: "monospace", lineHeight: 1.7,
                borderRight: "1px solid #21262D", bgcolor: "#0D1117",
              }}
            >
              {Array.from({ length: lineCount.current }, (_, i) => i + 1).join("\n")}
            </Box>
            {/* Code */}
            <Box
              component="pre"
              sx={{ flexGrow: 1, px: 1.5, py: 1.5, overflow: "visible", m: 0 }}
            >
              <code dangerouslySetInnerHTML={{ __html: html }} />
            </Box>
          </Box>
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
  height?: number;
}

export function CodeExplorer({ projectId, files, appsRoot, height = 520 }: CodeExplorerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const tree = buildTree(files);

  const selectedFile = selected ? files.find((f) => f.path === selected) : null;

  return (
    <Box
      sx={{
        display: "flex", height, border: "1px solid #21262D", borderRadius: 1,
        overflow: "hidden", bgcolor: "#0D0F14",
      }}
    >
      {/* File tree */}
      <Box
        sx={{
          width: 240, flexShrink: 0, overflowY: "auto", overflowX: "hidden",
          borderRight: "1px solid #21262D", bgcolor: "#0D1117",
          py: 0.5,
        }}
      >
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
}
