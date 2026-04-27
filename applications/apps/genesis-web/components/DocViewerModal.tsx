"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import { apiGet } from "@/lib/api";

// Lazy-load heavy deps
const ReactMarkdown = dynamic(
  () => Promise.all([import("react-markdown"), import("remark-gfm")])
    .then(([md, gfm]) => {
      const Comp = ({ children }: { children: string }) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (md.default as any)({ remarkPlugins: [gfm.default], children });
      Comp.displayName = "ReactMarkdownGFM";
      return { default: Comp };
    }),
  { ssr: false }
);

const CodeMirrorViewer = dynamic(
  () => Promise.all([
    import("@uiw/react-codemirror"),
    import("@uiw/codemirror-theme-vscode"),
  ]).then(([cm, theme]) => {
    const Comp = ({ value, ext }: { value: string; ext: string }) => {
      const [extensions, setExtensions] = useState<unknown[]>([]);
      useEffect(() => {
        const load = async () => {
          let ext2 = null;
          try {
            if (["ts","tsx","js","jsx"].includes(ext)) {
              const { javascript } = await import("@codemirror/lang-javascript");
              ext2 = javascript({ typescript: ext.startsWith("t"), jsx: ext.endsWith("x") });
            } else if (ext === "json") {
              const { json } = await import("@codemirror/lang-json"); ext2 = json();
            } else if (["css","scss"].includes(ext)) {
              const { css } = await import("@codemirror/lang-css"); ext2 = css();
            } else if (ext === "py") {
              const { python } = await import("@codemirror/lang-python"); ext2 = python();
            } else if (ext === "sql") {
              const { sql } = await import("@codemirror/lang-sql"); ext2 = sql();
            }
          } catch { /* ignore */ }
          setExtensions(ext2 ? [ext2] : []);
        };
        load();
      }, [ext]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const CM = cm.default as any;
      return (
        <CM
          value={value}
          extensions={extensions}
          theme={theme.vscodeDark}
          readOnly
          height="100%"
          style={{ height: "100%", fontSize: "0.78rem" }}
          basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
        />
      );
    };
    Comp.displayName = "CodeMirrorViewer";
    return { default: Comp };
  }),
  { ssr: false }
);

interface DocViewerModalProps {
  projectId: string;
  filename: string;          // relative path in project docs
  title: string;
  open: boolean;
  onClose: () => void;
}

export function DocViewerModal({ projectId, filename, title, open, onClose }: DocViewerModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const isMarkdown = ext === "md" || ext === "mdx";

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setContent(null);
    // Reuse the file-content endpoint — pass the doc path relative to project
    apiGet<{ content: string; path: string }>(
      `/api/projects/${projectId}/file-content?path=${encodeURIComponent(filename)}`
    )
      .then(({ content: raw }) => setContent(raw))
      .catch(() => setContent("(Não foi possível carregar o conteúdo do arquivo.)"))
      .finally(() => setLoading(false));
  }, [open, projectId, filename]);

  return (
    <Dialog open={open} onClose={onClose} fullScreen
      PaperProps={{ sx: { bgcolor: isMarkdown ? "background.default" : "#0D0F14", m: 0 } }}>
      <DialogContent sx={{ p: 0, display: "flex", flexDirection: "column", height: "100vh" }}>

        {/* Header */}
        <Stack direction="row" alignItems="center" spacing={1.5}
          sx={{ px: 2, py: 1, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0, bgcolor: "background.paper" }}>
          <InsertDriveFileIcon sx={{ fontSize: "1rem", color: isMarkdown ? "#8B949E" : "#3178C6" }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600} noWrap>{title}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", fontSize: "0.65rem" }}>
              {filename}
            </Typography>
          </Box>
          <Chip
            size="small"
            label={isMarkdown ? "Markdown" : ext.toUpperCase()}
            sx={{ fontSize: "0.62rem", height: 20 }}
          />
          <IconButton size="small" onClick={onClose} sx={{ ml: 1 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        {/* Content */}
        <Box sx={{ flexGrow: 1, minHeight: 0, overflow: "hidden" }}>
          {loading ? (
            <Box sx={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <CircularProgress size={28} />
            </Box>
          ) : content === null ? null : isMarkdown ? (
            // Markdown — rich render
            <Box sx={{
              height: "100%", overflowY: "auto", px: { xs: 2, sm: 6, md: 10 }, py: 4,
              maxWidth: 900, mx: "auto",
              "& h1": { fontSize: "1.8rem", fontWeight: 700, mb: 2, mt: 0, borderBottom: "1px solid", borderColor: "divider", pb: 1 },
              "& h2": { fontSize: "1.3rem", fontWeight: 600, mb: 1.5, mt: 3, color: "primary.main" },
              "& h3": { fontSize: "1.05rem", fontWeight: 600, mb: 1, mt: 2.5 },
              "& p":  { fontSize: "0.9rem", lineHeight: 1.8, mb: 1.5 },
              "& ul, & ol": { pl: 3, mb: 1.5 },
              "& li": { fontSize: "0.9rem", lineHeight: 1.7, mb: 0.5 },
              "& code": { bgcolor: "action.hover", px: 0.75, py: 0.2, borderRadius: 0.5, fontFamily: "monospace", fontSize: "0.82rem" },
              "& pre": { bgcolor: "#0D1117", border: "1px solid #30363D", p: 2, borderRadius: 1, overflowX: "auto", mb: 2 },
              "& pre code": { bgcolor: "transparent", p: 0, fontSize: "0.8rem" },
              "& table": { width: "100%", borderCollapse: "collapse", mb: 2, fontSize: "0.85rem" },
              "& th": { bgcolor: "action.hover", fontWeight: 600, px: 1.5, py: 0.75, borderBottom: "2px solid", borderColor: "divider", textAlign: "left" },
              "& td": { px: 1.5, py: 0.6, borderBottom: "1px solid", borderColor: "divider" },
              "& blockquote": { borderLeft: "3px solid", borderColor: "primary.main", pl: 2, ml: 0, color: "text.secondary", fontStyle: "italic", my: 1.5 },
              "& hr": { borderColor: "divider", my: 3 },
              scrollbarWidth: "thin",
            }}>
              <ReactMarkdown>{content}</ReactMarkdown>
            </Box>
          ) : (
            // Other files — CodeMirror
            <Box sx={{
              height: "100%",
              "& .cm-editor": { height: "100%" },
              "& .cm-scroller": { fontFamily: "'JetBrains Mono','Fira Code',monospace" },
              "& .cm-gutters": { bgcolor: "#0D1117", borderRight: "1px solid #21262D", color: "#484F58" },
            }}>
              <CodeMirrorViewer value={content} ext={ext} />
            </Box>
          )}
        </Box>
      </DialogContent>
    </Dialog>
  );
}
