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
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import RefreshIcon from "@mui/icons-material/Refresh";
import { apiGet, apiPost, ApiError } from "@/lib/api";

interface EvolutionState {
  checkpoint: boolean; checkpointSavedAt: string | null;
  scope: string[]; compat: string | null; compatExplicit?: boolean; rfcs: string[]; request: string | null; parentId: string | null;
  plan: { summary?: string; compat?: string; rfcs?: string[]; adrs?: string[]; questions?: string[] } | null;
  touchedFiles: string[]; violations: Record<string, string[]>; violationRounds: Record<string, number>;
  completedTasks: string[];
  baseline: { status?: string; passed?: number; failed?: number; total?: number; no_tests?: boolean; final?: { passed?: number; failed?: number; regressions?: string[] } } | null;
  publish: { pending: boolean; branch: string | null; repo: string | null; prUrl: string | null; compareUrl: string | null; version: string | null; supersedes: string | null; acceptedAt: string | null; prNumber?: number | null };
  // Bloco 4 M1: estado do merge do PR evolution/vN → dev (degrada p/ null se a API não enviar).
  merge?: { state: string | null; sha: string | null; at: string | null; method: string | null; actor: string | null; detail: string | null; prNumber: number | null; acceptedPermissions?: string | null } | null;
  // Bloco 4 M7 (Python): métricas de reescrita do Dev (do checkpoint); null se ausente.
  rewriteStats?: { files_rewritten?: number; lines_added?: number; lines_removed?: number; symbols_preserved?: number } | Record<string, unknown> | null;
}
interface TreeFile { path: string; isPrimary: boolean }
interface VersionEntry { id: string; versionNumber: number; status: string; isCurrent: boolean; isServiceCurrent?: boolean; supersededBy?: string | null; evolutionVersion?: string | null }

// Bloco 4 M1 — leitura humana de cada estado terminal do merge (rótulo + cor MUI). Estados que exigem
// confirmação explícita no botão (o back-end também exige `confirm:"MERGE"`) estão em MERGE_CONFIRM_STATES.
type ChipColor = "success" | "warning" | "error" | "info" | "default";
const MERGE_STATE_INFO: Record<string, { label: string; color: ChipColor }> = {
  merged: { label: "Mergeado em dev", color: "success" },
  merging: { label: "Mergeando…", color: "info" },
  blocked_permission: { label: "Sem permissão (GitHub App)", color: "error" },
  blocked_conflict: { label: "Conflito com dev", color: "error" },
  blocked_protection: { label: "Proteção de branch", color: "warning" },
  blocked_checks: { label: "Checks pendentes", color: "warning" },
  blocked_major: { label: "MAJOR — exige confirmação", color: "warning" },
  blocked_compat_implicit: { label: "Compatibilidade não declarada", color: "warning" },
  blocked_regressions: { label: "Regressões nos testes", color: "error" },
  blocked_no_tests: { label: "Sem testes (base)", color: "warning" },
  blocked_no_evidence: { label: "Sem evidência de testes", color: "error" },
  blocked_head_moved: { label: "Head do PR mudou", color: "warning" },
  blocked_base_mismatch: { label: "Base do PR não é dev", color: "error" },
  failed: { label: "Falhou", color: "error" },
};
// Estados de risco em que o botão "Mergear agora" pede o texto de confirmação (o humano assume o risco).
const MERGE_CONFIRM_STATES = new Set(["blocked_regressions", "blocked_no_tests"]);

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
  // Bloco 4 M1 — ação manual "Mergear agora".
  const [merging, setMerging] = useState(false);
  const [mergeMsg, setMergeMsg] = useState<{ severity: "success" | "warning" | "error"; text: string } | null>(null);
  const [confirmText, setConfirmText] = useState("");

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

  const handleMerge = useCallback(async (confirm?: string) => {
    setMerging(true); setMergeMsg(null);
    try {
      const res = await apiPost<{ ok: boolean; state: string; detail: string | null }>(
        `/api/projects/${projectId}/evolution/merge`,
        confirm ? { confirm } : {},
      );
      if (res.ok) {
        setMergeMsg({ severity: "success", text: "Evolução mergeada em 'dev'." });
        setConfirmText("");
      } else {
        const info = MERGE_STATE_INFO[res.state];
        setMergeMsg({ severity: "warning", text: `Não mergeado (${info?.label ?? res.state})${res.detail ? `: ${res.detail}` : ""}.` });
      }
      await load();
    } catch (e) {
      // 400 CONFIRM_REQUIRED chega aqui como ApiError — orienta o usuário a confirmar.
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Falha ao mergear";
      setMergeMsg({ severity: "error", text: msg });
    } finally { setMerging(false); }
  }, [projectId, load]);

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

  // Bloco 4 M1 — bloco de merge do PR evolution/vN → dev. Só aparece quando há PR publicado.
  const merge = state.merge ?? null;
  const mergeState = merge?.state ?? null;
  const hasPr = typeof state.publish.prNumber === "number" || (merge?.prNumber ?? null) !== null;
  const isMerged = mergeState === "merged";
  const commitHref = merge?.sha && state.publish.repo ? `https://github.com/${state.publish.repo}/commit/${merge.sha}` : null;
  // Confirmação exigida: MAJOR ou estados de risco (o back-end também exige — dupla-trava).
  const needsConfirm = (state.compat ?? "").toLowerCase() === "major" || (mergeState ? MERGE_CONFIRM_STATES.has(mergeState) : false);
  const rs = state.rewriteStats as { files_rewritten?: number; lines_added?: number; lines_removed?: number; symbols_preserved?: number } | null;
  const showMerge = hasPr && !state.publish.pending;

  const mergeBlock = !showMerge ? null : (
    <>
      <Divider sx={{ my: 1 }} />
      <Section title="Merge em dev"
        hint="O PR evolution/vN → dev. O merge automático (quando ligado) só ocorre com compatibilidade declarada e testes sem regressão; o botão abaixo mergeia manualmente.">
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
          {mergeState ? (
            <Chip size="small" color={MERGE_STATE_INFO[mergeState]?.color ?? "default"} variant={isMerged ? "filled" : "outlined"}
              label={MERGE_STATE_INFO[mergeState]?.label ?? mergeState} sx={{ fontSize: "0.62rem", height: 20 }} />
          ) : (
            <Chip size="small" variant="outlined" color="default" label="Ainda não mergeado" sx={{ fontSize: "0.62rem", height: 20 }} />
          )}
          {merge?.method && isMerged && <Chip size="small" variant="outlined" label={merge.method} sx={{ fontSize: "0.6rem", height: 18 }} />}
          {merge?.actor && isMerged && <Typography variant="caption" color="text.secondary">por {merge.actor}</Typography>}
          {commitHref && <a href={commitHref} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "monospace", fontSize: "0.68rem" }}>{merge!.sha!.slice(0, 8)}</a>}
        </Stack>
        {merge?.detail && !isMerged && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>{merge.detail}</Typography>}
        {merge?.acceptedPermissions && mergeState === "blocked_permission" && (
          <Typography variant="caption" color="error.main" sx={{ display: "block", mb: 0.5 }}>Permissões que faltam: <code>{merge.acceptedPermissions}</code></Typography>
        )}
        {mergeMsg && <Alert severity={mergeMsg.severity} sx={{ py: 0, mb: 0.75, fontSize: "0.72rem" }}>{mergeMsg.text}</Alert>}
        {!isMerged && (
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            {needsConfirm && (
              <TextField size="small" placeholder="Digite MERGE" value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
                disabled={merging} sx={{ width: 140, "& input": { fontSize: "0.72rem", py: 0.5 } }} />
            )}
            <Button size="small" variant="contained" color={needsConfirm ? "warning" : "primary"}
              disabled={merging || (needsConfirm && confirmText !== "MERGE")}
              onClick={() => void handleMerge(needsConfirm ? confirmText : undefined)}
              startIcon={merging ? <CircularProgress size={12} /> : undefined}
              sx={{ fontSize: "0.68rem", textTransform: "none" }}>
              Mergear agora
            </Button>
            {needsConfirm && <Typography variant="caption" color="warning.main">Mudança de risco — confirme digitando MERGE.</Typography>}
          </Stack>
        )}
      </Section>

      {rs && (Object.keys(rs).length > 0) && (
        <Section title="Reescrita do Dev (evolução)" hint="Métricas da reescrita in-place feita pelo Dev nesta evolução (do checkpoint do runner).">
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {typeof rs.files_rewritten === "number" && <Chip size="small" variant="outlined" label={`${rs.files_rewritten} arquivo(s)`} sx={{ fontSize: "0.62rem", height: 18 }} />}
            {typeof rs.lines_added === "number" && <Chip size="small" variant="outlined" color="success" label={`+${rs.lines_added}`} sx={{ fontSize: "0.62rem", height: 18 }} />}
            {typeof rs.lines_removed === "number" && <Chip size="small" variant="outlined" color="error" label={`-${rs.lines_removed}`} sx={{ fontSize: "0.62rem", height: 18 }} />}
            {typeof rs.symbols_preserved === "number" && <Chip size="small" variant="outlined" label={`${rs.symbols_preserved} símbolo(s) preservado(s)`} sx={{ fontSize: "0.62rem", height: 18 }} />}
          </Stack>
        </Section>
      )}
    </>
  );

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

      {mergeBlock}
    </Box>
  );
}
