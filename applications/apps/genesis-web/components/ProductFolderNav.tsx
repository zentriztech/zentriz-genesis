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
//
// UI/UX 2026-09-06 — ÁRVORE ÚNICA. Antes existiam DUAS listas de arquivos na Bancada:
// esta ("Pasta do produto") e o `SpecTreePanel` ("Árvore da especificação"), cada uma com
// seu próprio editor. Duas listas para a mesma coisa é contraintuitivo, então tudo o que
// era exclusivo do outro painel passou a viver AQUI: badge de GAPs por arquivo, botão de
// excluir e as ações de cabeçalho (novo arquivo, novo RFC, dividir a spec). Consequências:
//   • sem `productId` (spec aberta direto de um projeto) a árvore cai no modo PROJETO-ÚNICO
//     e lê `GET /api/projects/:id/spec-tree` — senão uma spec multi-arquivo aberta por
//     /projects/:id ficaria SEM lista de arquivos nenhuma;
//   • badge/excluir só nos arquivos do projeto ABERTO: os GAPs e a permissão de escrita são
//     por projeto, e inventar badge para os irmãos seria mentira.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { apiGet } from "@/lib/api";
import { buildTree, TreeItem, type CodeFile, type TreeNode } from "@/components/CodeExplorer";
import type { ProductSpecProject } from "@/components/ProductSpecExplorer";

interface SpecTreeResponse {
  productName: string;
  projects: ProductSpecProject[];
  totalFiles: number;
  loadedFiles?: number;
  truncated: boolean;
}

/** Resposta do índice por PROJETO (modo projeto-único, sem produto na URL). */
interface ProjectTreeResponse {
  files: Array<{ path: string; ext: string; isPrimary: boolean; contentSha256: string | null }>;
  editable: boolean;
  status: string;
  totalFiles: number;
}

// Referência de um arquivo da árvore → projeto/arquivo real (para navegar o editor).
interface NavRef { projectId: string; specPath: string; isPrimary: boolean; isCurrent: boolean }

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

export default function ProductFolderNav({
  productId, currentProjectId, currentFilePath = null, onOpen, height = 560,
  gapsByPath = null, editable = false, onDeleteFile, headerActions = null, onProjectMeta,
  reloadSignal = 0,
}: {
  /** Produto dono da spec. Vazio → modo PROJETO-ÚNICO (lê o índice do próprio projeto). */
  productId: string;
  /** Projeto aberto no editor agora — destaca o(s) arquivo(s) dele na árvore. */
  currentProjectId: string | null;
  /** Arquivo aberto no editor agora (dentro do projeto atual). null → destaca o primário. */
  currentFilePath?: string | null;
  /** Clique num arquivo: navega o editor para o projeto dono (projectId) + caminho. */
  onOpen: (projectId: string, specPath: string) => void;
  height?: number | string;
  /**
   * GAPs ATIVOS por caminho de arquivo (`/api/specs/:id/gap-scope`) do projeto ABERTO. Sem isto,
   * numa spec dividida o usuário não tem como saber ONDE estão os problemas. `null` = ainda não
   * carregado / spec nunca validada (nenhum badge).
   */
  gapsByPath?: Record<string, { active: number; blockers: number }> | null;
  /** Spec do projeto aberto aceita escrita (status/runner) → mostra o botão de excluir. */
  editable?: boolean;
  /** Excluir arquivo (nunca o primário). Ausente → nenhum botão de excluir. */
  onDeleteFile?: (projectId: string, specPath: string) => void;
  /** Ações do cabeçalho da lista (novo arquivo, novo RFC, dividir a spec…). */
  headerActions?: ReactNode;
  /**
   * Reporta ao pai os metadados do projeto ABERTO (o índice já os traz): se a spec aceita escrita
   * e quantos arquivos tem. É assim que o pai decide desenhar (ou não) os ícones de criar arquivo
   * sem repetir o GET da árvore. Chamado com o MESMO valor por cada instância montada — o pai
   * compara antes de setar estado (senão rail + diálogos se re-renderizariam em laço).
   */
  onProjectMeta?: (m: { editable: boolean; fileCount: number }) => void;
  /** Bump externo (criou/excluiu/aplicou revisão) → recarrega o índice. */
  reloadSignal?: number;
}) {
  const [data, setData] = useState<SpecTreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const projectOnly = !productId;

  useEffect(() => {
    // Modo produto: a pasta inteira. Modo projeto-único: só o projeto aberto — normalizado na
    // MESMA forma (`projects[]`) para o resto do componente não precisar saber a diferença.
    const url = productId
      ? `/api/products/${productId}/spec-tree`
      : currentProjectId ? `/api/projects/${currentProjectId}/spec-tree` : null;
    if (!url) return;
    let alive = true;
    setLoading(true); setError(null);
    apiGet<SpecTreeResponse | ProjectTreeResponse>(url)
      .then((r) => {
        if (!alive) return;
        if ("projects" in r) { setData(r); return; }
        setData({
          productName: "",
          projects: [{
            projectId: currentProjectId as string, title: "", status: r.status,
            editable: r.editable, files: r.files,
          }],
          totalFiles: r.totalFiles,
          truncated: false,
        });
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Falha ao carregar a pasta do produto"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [productId, currentProjectId, reloadSignal]);

  // Lista plana p/ a árvore (path = "<pasta do projeto>/<arquivo>") + índice reverso.
  // No modo projeto-único não há pasta de projeto: um nível de pasta com o nome do próprio
  // projeto aberto só empurraria todos os arquivos para dentro sem informar nada.
  const { fileList, index } = useMemo(() => {
    const projects = data?.projects ?? [];
    const labels = buildFolderLabels(projects);
    const list: CodeFile[] = [];
    const idx = new Map<string, NavRef>();
    for (const p of projects) {
      const label = labels.get(p.projectId) ?? p.projectId.slice(0, 8);
      for (const f of p.files) {
        const treePath = projectOnly ? f.path : `${label}/${f.path}`;
        list.push({ path: treePath, ext: f.ext });
        idx.set(treePath, {
          projectId: p.projectId, specPath: f.path,
          isPrimary: f.isPrimary === true, isCurrent: p.projectId === currentProjectId,
        });
      }
    }
    return { fileList: list, index: idx };
  }, [data, projectOnly, currentProjectId]);

  const tree = useMemo(() => buildTree(fileList), [fileList]);

  // Metadados do projeto aberto → pai (ícones de criar/excluir). Callback em ref: um pai que
  // passasse função inline recriaria o efeito a cada render dele.
  const metaCbRef = useRef(onProjectMeta);
  useEffect(() => { metaCbRef.current = onProjectMeta; }, [onProjectMeta]);
  useEffect(() => {
    const cur = data?.projects.find((p) => p.projectId === currentProjectId);
    if (!cur) return;
    metaCbRef.current?.({ editable: cur.editable === true, fileCount: cur.files.length });
  }, [data, currentProjectId]);

  // Destaca o arquivo aberto. Sem arquivo escolhido, destaca o PRIMÁRIO do projeto atual — é ele
  // que o editor mostra no modo "spec inteira" (o `spec-content` grava justamente o primário).
  const selectedTreePath = useMemo(() => {
    if (!currentProjectId) return null;
    const entries = Array.from(index.entries());
    if (currentFilePath) {
      const exact = entries.find(([, r]) => r.projectId === currentProjectId && r.specPath === currentFilePath);
      if (exact) return exact[0];
    }
    const primary = entries.find(([, r]) => r.projectId === currentProjectId && r.isPrimary);
    if (primary) return primary[0];
    const first = entries.find(([, r]) => r.projectId === currentProjectId);
    return first ? first[0] : null;
  }, [index, currentProjectId, currentFilePath]);

  const handleSelect = (treePath: string) => {
    const ref = index.get(treePath);
    if (ref) onOpen(ref.projectId, ref.specPath);
  };

  // Adornos à direita de cada arquivo: nº de GAPs ativos, marca do primário e excluir.
  // Só para os arquivos do projeto ABERTO (ver docblock: GAPs e escrita são por projeto).
  const renderAdornment = useCallback((node: TreeNode) => {
    const ref = index.get(node.fullPath);
    if (!ref || !ref.isCurrent) return null;
    const gaps = gapsByPath?.[ref.specPath];
    return (
      <>
        {gaps && gaps.active > 0 && (
          <Tooltip title={`${gaps.active} GAP(s) ativo(s) neste arquivo${gaps.blockers ? ` — ${gaps.blockers} bloqueador(es)` : ""}`}>
            <Box component="span" sx={{
              px: 0.5, minWidth: 15, height: 15, borderRadius: "8px", display: "inline-flex",
              alignItems: "center", justifyContent: "center", fontSize: "0.58rem", fontWeight: 700,
              lineHeight: 1, color: "#0D1117", bgcolor: gaps.blockers > 0 ? "#F85149" : "#F59E0B",
            }}>{gaps.active}</Box>
          </Tooltip>
        )}
        {ref.isPrimary && (
          <Tooltip title="Arquivo principal da spec — é ele que a Bancada abre como “spec inteira”; não pode ser excluído">
            <Box component="span" sx={{
              px: 0.5, height: 15, borderRadius: "3px", display: "inline-flex", alignItems: "center",
              fontSize: "0.55rem", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
              color: "#8B949E", border: "1px solid #30363D",
            }}>principal</Box>
          </Tooltip>
        )}
        {editable && onDeleteFile && !ref.isPrimary && (
          <Tooltip title={`Excluir ${ref.specPath}`}>
            <IconButton size="small" aria-label={`Excluir ${ref.specPath}`}
              onClick={(e) => { e.stopPropagation(); onDeleteFile(ref.projectId, ref.specPath); }}
              sx={{ p: 0.15, color: "#8B949E", "&:hover": { color: "#F85149" } }}>
              <DeleteOutlineIcon sx={{ fontSize: "0.85rem" }} />
            </IconButton>
          </Tooltip>
        )}
      </>
    );
  }, [index, gapsByPath, editable, onDeleteFile]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height, bgcolor: "#0D1117", overflow: "hidden" }}>
      <Box sx={{ flexShrink: 0, px: 1.5, py: 0.75, borderBottom: "1px solid #21262D" }}>
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ minHeight: 28 }}>
          <Typography variant="caption" sx={{ flexGrow: 1, minWidth: 0, color: "#8B949E", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {projectOnly ? "Arquivos da spec" : "Pasta do produto"} · {data?.totalFiles ?? 0} arquivo(s)
          </Typography>
          {/* Ações da LISTA (novo arquivo, novo RFC, dividir a spec) — ficam aqui, junto do
              excluir de cada linha, em vez de virarem cards ocupando o corpo da página. */}
          {headerActions}
        </Stack>
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
            {projectOnly ? "Esta spec ainda não tem arquivos." : "Este produto ainda não tem arquivos de spec."}
          </Typography>
        ) : (
          tree.map((node) => (
            <TreeItem key={node.fullPath} node={node} depth={0} selected={selectedTreePath}
              onSelect={handleSelect} renderAdornment={renderAdornment} />
          ))
        )}
      </Box>
    </Box>
  );
}
