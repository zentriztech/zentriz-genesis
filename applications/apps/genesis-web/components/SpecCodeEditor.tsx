"use client";
/**
 * SpecCodeEditor — editor de texto COM realce de sintaxe por tipo de arquivo (Onda 3, item d).
 *
 * Substitui o antigo <textarea> plano (cor única) do editor de spec por um CodeMirror
 * editável: as fontes ganham cor por token conforme a linguagem do arquivo (md/ts/json/…),
 * exatamente como a aba "Código" da fábrica (CodeExplorer usa o MESMO resolvedor de linguagem
 * e o MESMO tema vscodeDark — realce read-only lá, editável aqui).
 *
 * A linguagem é escolhida por `ext` (extensão do arquivo). O padrão é "md" porque uma spec é
 * um documento Markdown; ao navegar por arquivos de outros tipos, o realce acompanha.
 *
 * CodeMirror é pesado → carregado sob demanda (dynamic import), com um spinner enquanto monta.
 */
import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import { getLanguageExtension } from "./CodeExplorer";

type CodeMirrorProps = {
  value: string;
  onChange?: (v: string) => void;
  extensions: unknown[];
  theme: unknown;
  readOnly: boolean;
  editable: boolean;
  height: string;
  style: React.CSSProperties;
  basicSetup: Record<string, unknown>;
};

export default function SpecCodeEditor({
  value, onChange, ext = "md", readOnly = false, height = "100%",
}: {
  value: string;
  onChange?: (v: string) => void;
  /** Extensão do arquivo (sem ponto) — decide a linguagem do realce. Default: markdown. */
  ext?: string;
  readOnly?: boolean;
  height?: string;
}) {
  const [CodeMirrorComp, setCodeMirrorComp] = useState<React.ComponentType<CodeMirrorProps> | null>(null);
  const [vscodeDark, setVscodeDark] = useState<unknown>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [lang, setLang] = useState<any[]>([]);

  // Carrega o componente + tema uma única vez.
  useEffect(() => {
    let alive = true;
    Promise.all([
      import("@uiw/react-codemirror").then((m) => m.default),
      import("@uiw/codemirror-theme-vscode").then((m) => m.vscodeDark),
    ]).then(([cm, theme]) => {
      if (!alive) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setCodeMirrorComp(() => cm as any);
      setVscodeDark(() => theme);
    });
    return () => { alive = false; };
  }, []);

  // Resolve a extensão de linguagem quando `ext` muda (md → markdown, ts → javascript(ts), …).
  useEffect(() => {
    let alive = true;
    getLanguageExtension(ext)
      .then((l) => { if (alive) setLang(l ? [l] : []); })
      .catch(() => { if (alive) setLang([]); });
    return () => { alive = false; };
  }, [ext]);

  if (!CodeMirrorComp || vscodeDark === null) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", height, bgcolor: "#0D0F14" }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  return (
    <Box sx={{
      height, overflow: "auto", bgcolor: "#0D0F14",
      "& .cm-editor": { height: "100%", fontSize: "0.78rem" },
      "& .cm-editor.cm-focused": { outline: "none" },
      "& .cm-scroller": { fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace", lineHeight: 1.7 },
      "& .cm-gutters": { bgcolor: "#0D1117", borderRight: "1px solid #21262D", color: "#484F58" },
      "& .cm-activeLineGutter": { bgcolor: "#161B22" },
      "& .cm-activeLine": { bgcolor: "#6366F110" },
      "& .cm-content": { caretColor: "#6366F1" },
    }}>
      <CodeMirrorComp
        value={value}
        onChange={onChange ? (v) => onChange(v) : undefined}
        extensions={lang}
        theme={vscodeDark}
        readOnly={readOnly}
        editable={!readOnly}
        height="100%"
        style={{ height: "100%" }}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: !readOnly, highlightSelectionMatches: false, autocompletion: false }}
      />
    </Box>
  );
}
