"use client";
/**
 * EvolutionPanel — Evoluir bloco 3 (F4 / E6): aba "Evolução" da página do projeto (só em `extra.evolution`).
 * Sem LLM: mostra o que o humano precisa para entender e aceitar a evolução —
 *  • pedido, RFC/ADR/CHANGELOG (árvore da spec do filho, com link para a Bancada);
 *  • escopo permitido (files_allowed) × arquivos efetivamente tocados pelo Dev (gate determinístico E4);
 *  • violações por task (descartados) e rodadas; baseline/regressão da suíte (F3b) quando existir;
 *  • linhagem (versão corrente/substituída) e publicação (branch/PR/pendência).
 * Fonte: GET /api/projects/:id/evolution-state (checkpoint do runner via volume compartilhado + extra),
 * /versions e /spec-tree.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import RefreshIcon from "@mui/icons-material/Refresh";
import { apiGet } from "@/lib/api";

interface EvolutionState {
  checkpoint: boolean; checkpointSavedAt: string | null;
  scope: string[]; compat: string | null; rfcs: string[]; request: string | null; parentId: string | null;
  plan: { summary?: string; compat?: string; rfcs?: string[]; adrs?: string[]; questions?: string[] } | null;
  touchedFiles: string[]; violations: Record<string, string[]>; violationRounds: Record<string, number>;
  completedTasks: string[];
  baseline: { status?: string; passed?: number; failed?: number; total?: number; no_tests?: boolean; final?: { passed?: number; failed?: number; regressions?: string[] } } | null;
  publish: { pending: boolean; branch: string | null; repo: string | null; prUrl: string | null; compareUrl: string | null; version: string | null; supersedes: string | null; acceptedAt: string | null };
}
interface TreeFile { path: string; isPrimary: boolean }
interface VersionEntry { id: string; versionNumber: number; status: string; isCurrent: boolean; isServiceCurrent?: boolean; supersededBy?: string | null; evolutionVersion?: string | null }

function Section({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="caption" sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.62rem", color: "text.secondary" }}>{title}</Typography>
      {hint && <Typography variant="caption" sx={{ display: "block", color: "text.secondary", mb: 0.5 }}>{hint}</Typography>}
      <Box sx={{ mt: 0.5 }}>{children}</Box>
    </Box>
  );
}

export default function EvolutionPanel({ projectId, productId }: { projectId: string; productId?: string | null }) {
  const [state, setState] = useState<EvolutionState | null>(null);
  const [tree, setTree] = useState<TreeFile[]>([]);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [s, t, v] = await Promise.all([
        apiGet<EvolutionState>(`/api/projects/${projectId}/evolution-state`),
        apiGet<{ files: TreeFile[] }>(`/api/projects/${projectId}/spec-tree`).catch(() => ({ files: [] as TreeFile[] })),
        apiGet<{ versions: VersionEntry[] }>(`/api/projects/${projectId}/versions`).catch(() => ({ versions: [] as VersionEntry[] })),
      ]);
      setState(s); setTree(t.files ?? []); setVersions(v.versions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar o estado da evolução");
    } finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const docs = useMemo(() => {
    const p = tree.map((f) => f.path);
    return {
      rfcs: p.filter((x) => /^docs\/rfc\/RFC-\d{4}-.*\.md$/i.test(x)).sort(),
      adrs: p.filter((x) => /^docs\/adr\/ADR-\d{3}-.*\.md$/i.test(x)).sort(),
      changelog: p.find((x) => /^CHANGELOG\.md$/i.test(x)) ?? null,
      connect: p.find((x) => /^connect\.ya?ml$/i.test(x)) ?? null,
    };
  }, [tree]);

  const inScope = useCallback((path: string) => {
    if (!state?.scope?.length) return true;
    const rel = path.replace(/^apps\//, "");
    return state.scope.some((g) => {
      const gg = g.replace(/^apps\//, "").replace(/\/+$/, "");
      if (!/[*?]/.test(gg) && !/\.[a-z0-9]+$/i.test(gg.split("/").pop() ?? "")) return rel === gg || rel.startsWith(gg + "/");
      const re = new RegExp("^" + gg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
      return re.test(rel) || /(^|\/)(tests?|__tests__)\//.test(rel) || /\.(test|spec)\./.test(rel);
    });
  }, [state]);

  if (error) return <Alert severity="error" sx={{ m: 1 }}>{error}</Alert>;
  if (!state) return <Box sx={{ p: 3, textAlign: "center" }}><CircularProgress size={22} /></Box>;

  const violationTasks = Object.keys(state.violations ?? {});
  const totalViolations = violationTasks.reduce((n, k) => n + (state.violations[k]?.length ?? 0), 0);
  const bancadaHref = `/spec?editProjectId=${encodeURIComponent(projectId)}${productId ? `&productId=${encodeURIComponent(productId)}` : ""}`;

  return (
    <Box sx={{ p: 1.5, overflowY: "auto", height: "100%" }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={700}>Evolução — o que muda e por quê</Typography>
        <Stack direction="row" spacing={0.5} alignItems="center">
          {state.compat && <Chip size="small" variant="outlined" label={`compat ${state.compat.toUpperCase()}`} sx={{ fontSize: "0.62rem", height: 18 }} />}
          {!state.checkpoint && <Chip size="small" variant="outlined" color="default" label="fábrica ainda não rodou" sx={{ fontSize: "0.62rem", height: 18 }} />}
          <Button size="small" startIcon={loading ? <CircularProgress size={12} /> : <RefreshIcon sx={{ fontSize: "0.9rem" }} />} onClick={() => void load()} disabled={loading} sx={{ fontSize: "0.65rem", textTransform: "none" }}>Atualizar</Button>
        </Stack>
      </Stack>

      <Section title="Pedido">
        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>{state.request ?? "—"}</Typography>
        {state.plan?.summary && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>Arquiteto: {state.plan.summary}</Typography>}
      </Section>

      <Section title="Artefatos de evolução (Bancada)" hint="RFC define o escopo que a fábrica PODE tocar; ADR só quando houve decisão; CHANGELOG fecha a versão no aceite.">
        <Stack spacing={0.25}>
          {docs.rfcs.length === 0 && <Typography variant="caption" color="warning.main">Sem RFC — a promoção é bloqueada (EVOLUTION_RFC_REQUIRED).</Typography>}
          {docs.rfcs.map((p) => <Typography key={p} variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}>📄 {p}</Typography>)}
          {docs.adrs.map((p) => <Typography key={p} variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}>📐 {p}</Typography>)}
          {docs.changelog && <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}>🧾 {docs.changelog}{state.publish.version ? ` · v${state.publish.version}` : " · Unreleased"}</Typography>}
          {docs.connect && <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}>🔗 {docs.connect}</Typography>}
        </Stack>
        <Button component={Link} href={bancadaHref} size="small" variant="text" sx={{ mt: 0.5, fontSize: "0.7rem", textTransform: "none" }}>Abrir na Bancada</Button>
      </Section>

      <Section title={`Escopo permitido (${state.scope.length}) × arquivos tocados (${state.touchedFiles.length})`}
        hint="Verde = dentro do files_allowed do RFC (ou testes/docs); vermelho = fora (o gate descarta e devolve ao Dev).">
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
          {state.scope.map((g) => <Chip key={g} size="small" variant="outlined" label={g} sx={{ fontFamily: "monospace", fontSize: "0.62rem", height: 18 }} />)}
          {state.scope.length === 0 && <Typography variant="caption" color="text.secondary">Sem escopo gravado (promoção antiga?) — o gate está desativado neste run.</Typography>}
        </Stack>
        {state.touchedFiles.length === 0 ? (
          <Typography variant="caption" color="text.secondary">Nenhum arquivo gravado pela fábrica ainda.</Typography>
        ) : (
          <Stack spacing={0.15} sx={{ maxHeight: 220, overflowY: "auto" }}>
            {state.touchedFiles.map((p) => (
              <Typography key={p} variant="caption" sx={{ fontFamily: "monospace", fontSize: "0.7rem", color: inScope(p) ? "success.main" : "error.main" }}>
                {inScope(p) ? "✓" : "✗"} {p}
              </Typography>
            ))}
          </Stack>
        )}
      </Section>

      <Section title={`Gate de escopo — ${totalViolations} descarte(s) em ${violationTasks.length} task(s)`}
        hint="1ª violação devolve a task ao Dev com a lista; reincidência bloqueia (blocked_structural_gate).">
        {violationTasks.length === 0 ? (
          <Typography variant="caption" color="success.main">Nenhuma violação — tudo dentro do RFC.</Typography>
        ) : violationTasks.map((t) => (
          <Box key={t} sx={{ mb: 0.75 }}>
            <Typography variant="caption" fontWeight={700}>{t} <Chip size="small" color={(state.violationRounds[t] ?? 0) >= 2 ? "error" : "warning"} label={`rodada ${state.violationRounds[t] ?? 1}`} sx={{ fontSize: "0.6rem", height: 16, ml: 0.5 }} /></Typography>
            {state.violations[t].map((v, i) => <Typography key={i} variant="caption" sx={{ display: "block", color: "text.secondary", fontSize: "0.68rem" }}>· {v}</Typography>)}
          </Box>
        ))}
      </Section>

      <Section title="Não-regressão (suíte legada)" hint="Baseline antes das mudanças × resultado final; teste que passava e agora falha = regressão.">
        {!state.baseline ? (
          <Typography variant="caption" color="text.secondary">Sem baseline registrada nesta run.</Typography>
        ) : state.baseline.no_tests ? (
          <Typography variant="caption" color="text.secondary">A versão anterior não tem suíte de testes executável — nada a comparar.</Typography>
        ) : (
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
            <Chip size="small" variant="outlined" label={`baseline: ${state.baseline.passed ?? 0} ok · ${state.baseline.failed ?? 0} falhas`} sx={{ fontSize: "0.62rem", height: 18 }} />
            {state.baseline.final && (
              <Chip size="small" color={(state.baseline.final.regressions?.length ?? 0) > 0 ? "error" : "success"}
                label={(state.baseline.final.regressions?.length ?? 0) > 0 ? `${state.baseline.final.regressions!.length} regressão(ões)` : `final: ${state.baseline.final.passed ?? 0} ok · sem regressão`} sx={{ fontSize: "0.62rem", height: 18 }} />
            )}
            {state.baseline.final?.regressions?.slice(0, 10).map((r) => <Typography key={r} variant="caption" sx={{ fontFamily: "monospace", fontSize: "0.68rem", color: "error.main", width: "100%" }}>✗ {r}</Typography>)}
          </Stack>
        )}
      </Section>

      <Divider sx={{ my: 1 }} />

      <Section title="Linhagem e publicação">
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
          {versions.map((v) => (
            <Chip key={v.id} size="small" component={Link} href={`/projects/${v.id}`} clickable
              color={v.isServiceCurrent ? "success" : v.supersededBy ? "default" : "primary"} variant={v.isCurrent ? "filled" : "outlined"}
              label={`v${v.versionNumber}${v.evolutionVersion ? ` (${v.evolutionVersion})` : ""}${v.isServiceCurrent ? " · corrente" : v.supersededBy ? " · substituída" : ""}`} sx={{ fontSize: "0.62rem", height: 20 }} />
          ))}
        </Stack>
        {state.publish.pending && <Alert severity="warning" sx={{ py: 0, mb: 0.75 }}>Publicação pendente — o código ainda não foi para o GitHub; use “Republicar” no cabeçalho.</Alert>}
        {state.publish.branch && (
          <Typography variant="caption" sx={{ display: "block" }}>
            Branch <code>{state.publish.branch}</code>{state.publish.repo ? ` em ${state.publish.repo}` : ""}
            {state.publish.prUrl ? <> · <a href={state.publish.prUrl} target="_blank" rel="noopener noreferrer">PR aberto</a></> : state.publish.compareUrl ? <> · <a href={state.publish.compareUrl} target="_blank" rel="noopener noreferrer">abrir PR manualmente</a></> : null}
          </Typography>
        )}
        {!state.publish.branch && !state.publish.pending && <Typography variant="caption" color="text.secondary">Ainda não aceita/publicada.</Typography>}
      </Section>
    </Box>
  );
}
