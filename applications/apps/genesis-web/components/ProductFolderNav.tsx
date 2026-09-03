"use client";

// ProductFolderNav — navegador da "Pasta do produto" no editor de spec (/spec).
// Redesign Bancada Onda 2/3, Opção 1 (árvore do produto dirige UM editor + IA).
//
// Em produção cada PROJETO tem tipicamente 1 arquivo de spec, mas um PRODUTO agrega
// vários projetos. Esta árvore mostra a pasta do produto inteiro (cada projeto vira
// uma pasta de topo, análogo à aba "Código" da fábrica) e, ao clicar num arquivo,
// NAVEGA o editor para o projeto dono daquele arquivo (onOpen) — reusando o editor,
// o chat "Melhorar com IA" e a Validação/GAPs já existentes na página, por-projeto.
// A árvore é só NAVEGADORA (não edita): a edição/validação/promoção acontece no
// editor principal do projeto selecionado. Índice via GET /api/products/:id/spec-tree
// (metadados, sem leitura de disco); tenant-scoped no servidor.

import { useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { apiGet } from "@/lib/api";
import { buildTree, TreeItem, type CodeFile } from "@/components/CodeExplorer";
import type { ProductSpecProject } from "@/components/ProductSpecExplorer";

interface SpecTreeResponse {
  productName: string;
  projects: ProductSpecProject[];
  totalFiles: number;
  loadedFiles?: number;
  truncated: boolean;
}

// Referência de um arquivo da árvore → projeto/arquivo real (para navegar o editor).
interface NavRef { projectId: string; specPath: string }

// Rótulo de pasta (topo) por projeto: título saneado ("/" quebraria a hierarquia da
// árvore) + desambiguação de homônimos por id curto. (Espelha ProductSpecExplorer.)
function buildFolderLabels(projects: ProductSpecProject[]): Map<string, string> {
  const sanitize = (t: string) => (t || "Projeto").replace(/[/\\]/g, "-").trim() || "Projeto";
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(sanitize(p.title), (counts.get(sanitize(p.title)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of projects) {
    const base = sanitize(p.title);
    out.set(p.projectId, (counts.get(base) ?? 0) > 1 ? `${base} · ${p.projectId.slice(0, 8)}` : base);
  }
  return out;
}

export default function ProductFolderNav({ productId, currentProjectId, onOpen, height = 560 }: {
  productId: string;
  /** Projeto aberto no editor agora — destaca o(s) arquivo(s) dele na árvore. */
  currentProjectId: string | null;
  /** Clique num arquivo: navega o editor para o projeto dono (projectId) + caminho. */
  onOpen: (projectId: string, specPath: string) => void;
  height?: number | string;
}) {
  const [data, setData] = useState<SpecTreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productId) return;
    let alive = true;
    setLoading(true); setError(null);
    apiGet<SpecTreeResponse>(`/api/products/${productId}/spec-tree`)
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Falha ao carregar a pasta do produto"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [productId]);

  // Lista plana p/ a árvore (path = "<pasta do projeto>/<arquivo>") + índice reverso.
  const { fileList, index } = useMemo(() => {
    const projects = data?.projects ?? [];
    const labels = buildFolderLabels(projects);
    const list: CodeFile[] = [];
    const idx = new Map<string, NavRef>();
    for (const p of projects) {
      const label = labels.get(p.projectId) ?? p.projectId.slice(0, 8);
      for (const f of p.files) {
        const treePath = `${label}/${f.path}`;
        list.push({ path: treePath, ext: f.ext });
        idx.set(treePath, { projectId: p.projectId, specPath: f.path });
      }
    }
    return { fileList: list, index: idx };
  }, [data]);

  const tree = useMemo(() => buildTree(fileList), [fileList]);

  // Destaca o arquivo do projeto aberto (1º arquivo do projeto atual — em prod cada
  // projeto tem 1 arquivo). Deriva o treePath reverso a partir do índice.
  const selectedTreePath = useMemo(() => {
    if (!currentProjectId) return null;
    const entry = Array.from(index.entries()).find(([, ref]) => ref.projectId === currentProjectId);
    return entry ? entry[0] : null;
  }, [index, currentProjectId]);

  const handleSelect = (treePath: string) => {
    const ref = index.get(treePath);
    if (ref) onOpen(ref.projectId, ref.specPath);
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height, bgcolor: "#0D1117", overflow: "hidden" }}>
      <Box sx={{ flexShrink: 0, px: 1.5, py: 1, borderBottom: "1px solid #21262D" }}>
        <Typography variant="caption" sx={{ color: "#8B949E", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Pasta do produto · {data?.totalFiles ?? 0} arquivo(s)
        </Typography>
        {data?.truncated && (
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
            <WarningAmberIcon sx={{ fontSize: "0.8rem", color: "#F59E0B", flexShrink: 0 }} />
            <Typography variant="caption" sx={{ color: "#F59E0B", fontSize: "0.62rem", lineHeight: 1.3 }}>
              Lista truncada ({data.loadedFiles ?? fileList.length} de {data.totalFiles}).
            </Typography>
          </Stack>
        )}
      </Box>
      <Box sx={{ flexGrow: 1, overflowY: "auto", overflowX: "hidden", py: 0.5 }}>
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}><CircularProgress size={18} /></Box>
        ) : error ? (
          <Alert severity="warning" sx={{ m: 1, fontSize: "0.7rem" }}>{error}</Alert>
        ) : tree.length === 0 ? (
          <Typography variant="caption" sx={{ display: "block", px: 1.5, py: 1, color: "#484F58", fontSize: "0.7rem" }}>
            Este produto ainda não tem arquivos de spec.
          </Typography>
        ) : (
          tree.map((node) => (
            <TreeItem key={node.fullPath} node={node} depth={0} selected={selectedTreePath} onSelect={handleSelect} />
          ))
        )}
      </Box>
    </Box>
  );
}
