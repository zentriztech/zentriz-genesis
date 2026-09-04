"use client";
/**
 * SpecValidationPanel — RFC-0004 Onda 4 (F4/UI) + RFC-0005 (controle de GAPs por finding).
 *
 * Estado DERIVADO do servidor (run 'passed' cobre o hash ATUAL?): editar a spec depois de um verde o
 * torna 'stale' — e o gate de promoção volta a travar. O job roda no SERVIDOR (sobrevive a sair da página).
 *
 * RFC-0005: cada finding tem identidade estável (fingerprint) e pode ser TRIADO — Ignorar (risco aceito,
 * com prazo opcional) ou Refutar (falso positivo) — com reason_code obrigatório. Ignorados/Refutados saem
 * da conta de GAPs ativos (gate, badge, Resolver GAPs) mas continuam visíveis nas abas. "Resolvidos" é
 * DERIVADO pelo servidor (o GAP sumiu em ≥2 validações). Blockers estruturais não são triáveis; blockers
 * triáveis só pelo administrador do tenant, com motivo — tudo auditado.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { authStore } from "@/stores/authStore";

type Severity = "blocker" | "warning" | "info";
type TriageState = "ignored" | "refuted";
interface Triage { id: string; state: TriageState; reasonCode: string; reason: string; actorRole: string; createdAt: string; expiresAt: string | null; inherited: boolean; recurrenceCount: number; severityChanged: boolean }
interface Finding {
  file: string; line: number | null; severity: Severity; title: string; rationale: string; source: string;
  category?: string | null; anchor?: string | null;
  fingerprint?: string; triageable?: boolean; triage?: Triage | null;
}
interface Resolved { fingerprint: string; file: string; title: string; severity: string; source: string; category: string | null; lastSeenRunId: string; lastSeenAt: string; absentRuns: number; fileRemoved: boolean }
interface Counts { active: number; ignored: number; refuted: number; resolved: number; blockersActive: number; byCategory: Record<string, number> }
interface ValidationState {
  derivedStatus: string;
  currentSpecHash: string | null;
  latestRun: { id: string; status: string; findings: Finding[]; acked_role: string | null; finished_at: string | null } | null;
  resolved?: Resolved[];
  counts?: Counts | null;
  gate?: { wouldPass: boolean; blockersActive: number | null; warningsActive: number | null } | null;
}

const STATUS_META: Record<string, { label: string; color: "default" | "success" | "error" | "warning" | "info" }> = {
  never_validated: { label: "Nunca validada", color: "default" },
  validating: { label: "Validando…", color: "info" },
  validated: { label: "Validada ✓", color: "success" },
  failed: { label: "Reprovada", color: "error" },
  failed_triaged: { label: "Reprovada · blockers triados", color: "warning" },
  stale: { label: "Editada após validação", color: "warning" },
  superseded: { label: "Editada durante validação", color: "warning" },
  interrupted: { label: "Interrompida", color: "warning" },
  error: { label: "Erro na validação", color: "error" },
};
const SEV_COLOR: Record<Severity, "error" | "warning" | "info"> = { blocker: "error", warning: "warning", info: "info" };
const SEV_ORDER: Record<Severity, number> = { blocker: 0, warning: 1, info: 2 };

const REASONS_IGNORE: Array<{ code: string; label: string }> = [
  { code: "accepted_risk", label: "Risco aceito" },
  { code: "out_of_scope", label: "Fora de escopo desta versão" },
  { code: "will_fix_later", label: "Vamos corrigir depois (dívida)" },
  { code: "by_design", label: "É assim por desenho" },
  { code: "mitigated", label: "Mitigado por outro meio" },
  { code: "duplicate", label: "Duplicado de outro GAP" },
];
const REASONS_REFUTE: Array<{ code: string; label: string }> = [
  { code: "false_positive", label: "Falso positivo (o validador errou)" },
  { code: "duplicate", label: "Duplicado de outro GAP" },
];
const REASON_LABEL: Record<string, string> = Object.fromEntries([...REASONS_IGNORE, ...REASONS_REFUTE].map((r) => [r.code, r.label]));
const CATEGORY_LABEL: Record<string, string> = {
  security_gap: "segurança", missing_data_model: "modelo de dados", contract_undefined: "contrato", infra_undefined: "infra",
  ambiguous_fr: "requisito ambíguo", no_acceptance_criteria: "critérios de aceite", missing_nfr: "NFR", scope_conflict: "escopo",
  stack_inconsistent: "stack", connect_declaration_gap: "Connect", prompt_injection: "injeção", structural: "estrutural", other: "outro",
};

type TabKey = "active" | "ignored" | "resolved" | "refuted";

interface TriageDraft { state: TriageState; fingerprints: string[]; titles: string[]; hasBlocker: boolean }

export default function SpecValidationPanel({ projectId, isAdmin, reloadSignal, onFindingsChange }: {
  projectId: string; isAdmin?: boolean; reloadSignal?: number;
  // Onda 3 / RFC-0005 — avisa o pai do nº de GAPs ATIVOS (ignorados/refutados não contam) sempre que o
  // estado recarrega. null = nunca validada. Mantém o badge da aba GAPs e o gate "Promover à Fábrica"
  // SINCRONIZADOS quando a validação/triagem roda DENTRO da aba.
  onFindingsChange?: (count: number | null) => void;
}) {
  const [state, setState] = useState<ValidationState | null>(null);
  const [busy, setBusy] = useState<"validate" | "ack" | "triage" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("active");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; finding: Finding } | null>(null);
  const [draft, setDraft] = useState<TriageDraft | null>(null);
  const [reasonCode, setReasonCode] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onFindingsChangeRef = useRef(onFindingsChange);
  onFindingsChangeRef.current = onFindingsChange;
  const role = authStore.user?.role ?? "user";
  const isTenantAdmin = role === "tenant_admin";

  const load = useCallback(async () => {
    try {
      const s = await apiGet<ValidationState>(`/api/specs/${projectId}/validation`);
      setState(s);
      // ENQUANTO valida, a run corrente tem findings=[] — não reportar (o badge piscaria "0").
      if (s?.derivedStatus !== "validating") {
        const active = s?.counts ? s.counts.active : (s?.latestRun ? (Array.isArray(s.latestRun.findings) ? s.latestRun.findings.filter((f) => !f.triage).length : 0) : null);
        onFindingsChangeRef.current?.(s?.latestRun ? active : null);
      }
      return s;
    } catch { return null; }
  }, [projectId]);

  useEffect(() => {
    void load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const lastReload = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === lastReload.current) return;
    lastReload.current = reloadSignal;
    void load();
  }, [reloadSignal, load]);

  useEffect(() => {
    if (state?.derivedStatus === "validating" && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const s = await load();
        if (s && s.derivedStatus !== "validating" && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }, 6000);
    }
  }, [state?.derivedStatus, load]);

  const validate = useCallback(async () => {
    setBusy("validate"); setError(null);
    try { await apiPost(`/api/specs/${projectId}/validate`, {}); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Falha ao validar"); }
    finally { setBusy(null); }
  }, [projectId, load]);

  const ack = useCallback(async () => {
    const run = state?.latestRun;
    if (!run) return;
    setBusy("ack"); setError(null);
    try { await apiPost(`/api/specs/${projectId}/validation/${run.id}/ack`, {}); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Falha no acknowledgment"); }
    finally { setBusy(null); }
  }, [projectId, state, load]);

  const openDraft = (st: TriageState, findings: Finding[]) => {
    setDraft({ state: st, fingerprints: findings.map((f) => f.fingerprint!).filter(Boolean), titles: findings.map((f) => f.title), hasBlocker: findings.some((f) => f.severity === "blocker") });
    setReasonCode(st === "refuted" ? "false_positive" : "accepted_risk"); setReason(""); setExpiresAt("");
    setMenu(null);
  };

  const submitDraft = useCallback(async () => {
    if (!draft) return;
    setBusy("triage"); setError(null);
    try {
      const body: Record<string, unknown> = { state: draft.state, reason_code: reasonCode, reason: reason.trim() };
      if (draft.state === "ignored" && expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      if (draft.fingerprints.length === 1) {
        await apiPost(`/api/specs/${projectId}/findings/${draft.fingerprints[0]}/triage`, body);
      } else {
        const r = await apiPost<{ ok: boolean; applied: number; results: Array<{ ok: boolean; message?: string }> }>(`/api/specs/${projectId}/findings/triage-bulk`, { ...body, fingerprints: draft.fingerprints });
        if (r.applied < draft.fingerprints.length) setError(`${r.applied}/${draft.fingerprints.length} aplicados. ${r.results.find((x) => !x.ok)?.message ?? ""}`.trim());
      }
      setDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao triar o finding");
    } finally { setBusy(null); }
  }, [draft, reasonCode, reason, expiresAt, projectId, load]);

  const reactivate = useCallback(async (f: Finding) => {
    if (!f.fingerprint) return;
    setBusy("triage"); setError(null); setMenu(null);
    try { await apiDelete(`/api/specs/${projectId}/findings/${f.fingerprint}/triage`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Falha ao reativar"); }
    finally { setBusy(null); }
  }, [projectId, load]);

  const run = state?.latestRun;
  const all = useMemo(() => (run?.findings ?? []).slice().sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.file.localeCompare(b.file)), [run]);
  const active = useMemo(() => all.filter((f) => !f.triage), [all]);
  const ignored = useMemo(() => all.filter((f) => f.triage?.state === "ignored"), [all]);
  const refuted = useMemo(() => all.filter((f) => f.triage?.state === "refuted"), [all]);
  const resolved = state?.resolved ?? [];

  if (!state) return null;
  const meta = STATUS_META[state.derivedStatus] ?? { label: state.derivedStatus, color: "default" as const };
  const hasBlockerActive = active.some((f) => f.severity === "blocker");
  const hasWarningActive = active.some((f) => f.severity === "warning");
  const acked = !!run?.acked_role;
  const showFindings = ["validated", "failed", "failed_triaged", "stale"].includes(state.derivedStatus) && (all.length > 0 || resolved.length > 0);
  const canAck = run && ["validated", "failed", "failed_triaged"].includes(state.derivedStatus) && !acked &&
    ((hasWarningActive && !hasBlockerActive) || (hasBlockerActive && isAdmin));
  const activeWarnings = active.filter((f) => f.severity === "warning" && f.triageable !== false && f.fingerprint);
  const canTriage = (f: Finding) => f.triageable !== false && !!f.fingerprint && role !== "zentriz_admin";
  const blockerHint = (f: Finding) => f.severity === "blocker" && !isTenantAdmin ? "Blocker: só o administrador do tenant pode ignorar/refutar (com motivo)." : null;

  const list: Finding[] = tab === "active" ? active : tab === "ignored" ? ignored : tab === "refuted" ? refuted : [];

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1.5, p: 1.5, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        <FactCheckOutlinedIcon sx={{ fontSize: "1.1rem" }} />
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 160 }}>Validação da especificação</Typography>
        <Chip size="small" color={meta.color} label={meta.label} />
        {acked && <Chip size="small" color={run?.acked_role === "zentriz_admin" && hasBlockerActive ? "error" : "success"}
                        label={run?.acked_role === "zentriz_admin" && hasBlockerActive ? "forçada (admin)" : "avisos reconhecidos"} />}
        <Button size="small" variant="outlined"
                startIcon={busy === "validate" || state.derivedStatus === "validating" ? <CircularProgress size={14} /> : undefined}
                disabled={busy !== null || state.derivedStatus === "validating"}
                onClick={() => void validate()}>
          {state.derivedStatus === "validating" ? "Validando…" : "Validar"}
        </Button>
        {canAck && (
          <Tooltip title="Reconhece os avisos SÓ para esta versão da spec (não cria triagens). Para ignorar de forma durável, use Ignorar por finding ou em lote.">
            <Button size="small" color={hasBlockerActive ? "error" : "warning"} variant="outlined" disabled={busy !== null} onClick={() => void ack()}>
              {hasBlockerActive ? "Forçar (admin, auditado)" : "Reconhecer avisos"}
            </Button>
          </Tooltip>
        )}
      </Stack>
      {error && <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError(null)}>{error}</Alert>}
      {state.derivedStatus === "stale" && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          A spec foi editada depois da última validação — o resultado abaixo é da versão anterior. Revalide antes de promover.
        </Alert>
      )}
      {state.derivedStatus === "failed_triaged" && (
        <Alert severity="info" sx={{ mt: 1 }}>
          Todos os blockers desta validação foram triados pelo administrador do tenant (auditado). O gate de promoção passa; os GAPs continuam visíveis em Ignorados/Refutados.
        </Alert>
      )}

      {showFindings && (
        <Box sx={{ mt: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
            <Tabs value={tab} onChange={(_, v) => setTab(v as TabKey)} variant="scrollable" scrollButtons="auto" sx={{ minHeight: 34, flex: 1, "& .MuiTab-root": { minHeight: 34, py: 0, fontSize: "0.75rem", textTransform: "none" } }}>
              <Tab value="active" label={`Ativos (${active.length})`} />
              <Tab value="ignored" label={`Ignorados (${ignored.length})`} />
              <Tab value="resolved" label={`Resolvidos (${resolved.length})`} />
              <Tab value="refuted" label={`Refutados (${refuted.length})`} />
            </Tabs>
            {tab === "active" && activeWarnings.length > 1 && role !== "zentriz_admin" && (
              <Tooltip title="Cria uma triagem 'Ignorado' para cada warning ativo, com um único motivo (D-G4). Diferente de 'Reconhecer avisos', sobrevive a novas validações.">
                <Button size="small" variant="text" disabled={busy !== null} onClick={() => openDraft("ignored", activeWarnings)} sx={{ fontSize: "0.7rem", textTransform: "none" }}>
                  Ignorar todos os warnings ativos ({activeWarnings.length})
                </Button>
              </Tooltip>
            )}
          </Stack>

          {tab !== "resolved" && list.length === 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", py: 1 }}>
              {tab === "active" ? (ignored.length + refuted.length > 0 ? "Sem GAPs ativos — os demais foram triados." : "Sem GAPs nesta validação.") : "Nada aqui."}
            </Typography>
          )}

          {tab !== "resolved" && (
            <Stack spacing={0.75}>
              {list.map((f, i) => (
                <Alert key={f.fingerprint ?? i} severity={SEV_COLOR[f.severity]} sx={{ py: 0.25, "& .MuiAlert-message": { py: 0.5, width: "100%" }, opacity: f.triage ? 0.85 : 1 }}
                  action={canTriage(f) ? (
                    <IconButton size="small" aria-label="ações do finding" disabled={busy !== null} onClick={(e) => setMenu({ anchor: e.currentTarget, finding: f })}>
                      <MoreVertIcon fontSize="small" />
                    </IconButton>
                  ) : f.triageable === false ? <Chip size="small" variant="outlined" label="não triável" sx={{ fontSize: "0.6rem", height: 18, mt: 0.5 }} /> : undefined}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {f.title}
                    {f.file ? <Typography component="span" variant="caption" sx={{ fontFamily: "monospace", ml: 1 }}>({f.file}{f.line ? `:${f.line}` : ""})</Typography> : null}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">{f.rationale}</Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                    {f.category && <Chip size="small" variant="outlined" label={CATEGORY_LABEL[f.category] ?? f.category} sx={{ fontSize: "0.6rem", height: 18 }} />}
                    {f.anchor && <Chip size="small" variant="outlined" label={f.anchor} sx={{ fontSize: "0.6rem", height: 18, fontFamily: "monospace" }} />}
                    {f.triage && (
                      <Tooltip title={`${REASON_LABEL[f.triage.reasonCode] ?? f.triage.reasonCode}${f.triage.reason ? ` — ${f.triage.reason}` : ""} · por ${f.triage.actorRole} em ${new Date(f.triage.createdAt).toLocaleDateString("pt-BR")}${f.triage.inherited ? " · herdado da versão anterior" : ""}`}>
                        <Chip size="small" color={f.triage.state === "ignored" ? "warning" : "default"} label={`${f.triage.state === "ignored" ? "ignorado" : "refutado"} · ${REASON_LABEL[f.triage.reasonCode] ?? f.triage.reasonCode}${f.triage.expiresAt ? ` · até ${new Date(f.triage.expiresAt).toLocaleDateString("pt-BR")}` : ""}`} sx={{ fontSize: "0.6rem", height: 18 }} />
                      </Tooltip>
                    )}
                    {f.triage?.severityChanged && <Chip size="small" color="error" variant="outlined" label="severidade mudou" sx={{ fontSize: "0.6rem", height: 18 }} />}
                    {f.triage?.state === "refuted" && f.triage.recurrenceCount > 0 && (
                      <Tooltip title="Nº de validações em que o validador voltou a apontar este GAP depois da refutação.">
                        <Chip size="small" color={f.triage.recurrenceCount >= 3 ? "error" : "default"} variant="outlined" label={`reincidiu ${f.triage.recurrenceCount}×`} sx={{ fontSize: "0.6rem", height: 18 }} />
                      </Tooltip>
                    )}
                    {blockerHint(f) && !f.triage && <Typography variant="caption" color="text.secondary">{blockerHint(f)}</Typography>}
                  </Stack>
                  {f.triage?.state === "refuted" && f.triage.recurrenceCount >= 3 && (
                    <Typography variant="caption" color="error.main" sx={{ display: "block", mt: 0.25 }}>O validador insiste neste ponto — revise a refutação.</Typography>
                  )}
                </Alert>
              ))}
            </Stack>
          )}

          {tab === "resolved" && (
            resolved.length === 0 ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", py: 1 }}>Nenhum GAP resolvido ainda (um GAP conta como resolvido quando some em duas validações seguidas).</Typography>
            ) : (
              <Stack spacing={0.5}>
                {resolved.map((r) => (
                  <Alert key={r.fingerprint} severity="success" icon={false} sx={{ py: 0.25, "& .MuiAlert-message": { py: 0.5 } }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, textDecoration: "line-through", opacity: 0.8 }}>
                      {r.title}{r.file ? <Typography component="span" variant="caption" sx={{ fontFamily: "monospace", ml: 1 }}>({r.file})</Typography> : null}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      visto pela última vez em {new Date(r.lastSeenAt).toLocaleString("pt-BR")} · ausente há {r.absentRuns} validação(ões){r.fileRemoved ? " · arquivo removido" : ""}
                    </Typography>
                  </Alert>
                ))}
              </Stack>
            )
          )}
        </Box>
      )}

      <Menu open={!!menu} anchorEl={menu?.anchor ?? null} onClose={() => setMenu(null)}>
        {menu && !menu.finding.triage && <MenuItem onClick={() => openDraft("ignored", [menu.finding])} disabled={menu.finding.severity === "blocker" && !isTenantAdmin}>Ignorar (risco aceito)…</MenuItem>}
        {menu && !menu.finding.triage && <MenuItem onClick={() => openDraft("refuted", [menu.finding])} disabled={menu.finding.severity === "blocker" && !isTenantAdmin}>Refutar (falso positivo)…</MenuItem>}
        {menu && menu.finding.triage?.state === "ignored" && <MenuItem onClick={() => openDraft("refuted", [menu.finding])} disabled={menu.finding.severity === "blocker" && !isTenantAdmin}>Mudar para Refutado…</MenuItem>}
        {menu && menu.finding.triage?.state === "refuted" && <MenuItem onClick={() => openDraft("ignored", [menu.finding])} disabled={menu.finding.severity === "blocker" && !isTenantAdmin}>Mudar para Ignorado…</MenuItem>}
        {menu && menu.finding.triage && <MenuItem onClick={() => void reactivate(menu.finding)} disabled={menu.finding.severity === "blocker" && !isTenantAdmin}>Reativar (volta a Ativo)</MenuItem>}
      </Menu>

      <Dialog open={!!draft} onClose={() => setDraft(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: "1rem" }}>
          {draft?.state === "ignored" ? "Ignorar" : "Refutar"} {draft && draft.fingerprints.length > 1 ? `${draft.fingerprints.length} findings` : "finding"}
        </DialogTitle>
        <DialogContent>
          {draft && draft.fingerprints.length === 1 && <Typography variant="body2" sx={{ mb: 1.5 }}>{draft.titles[0]}</Typography>}
          {draft && draft.fingerprints.length > 1 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>{draft.titles.slice(0, 5).join(" · ")}{draft.titles.length > 5 ? ` · +${draft.titles.length - 5}` : ""}</Typography>
          )}
          <Alert severity={draft?.state === "ignored" ? "warning" : "info"} sx={{ mb: 1.5 }}>
            {draft?.state === "ignored"
              ? "Ignorar = risco aceito. O GAP sai da contagem ativa (gate, badge, Resolver GAPs) mas fica visível na aba Ignorados. Opcionalmente defina um prazo — ao vencer, volta a Ativo."
              : "Refutar = o validador errou. Não expira; se o validador voltar a apontar o mesmo ponto, contamos a reincidência (não volta a Ativo)."}
            {draft?.hasBlocker ? " Blocker: exige administrador do tenant e motivo com pelo menos 20 caracteres; a decisão é auditada e notificada." : ""}
          </Alert>
          <TextField select fullWidth size="small" label="Motivo (código)" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} sx={{ mb: 1.5 }}>
            {(draft?.state === "ignored" ? REASONS_IGNORE : REASONS_REFUTE).map((r) => <MenuItem key={r.code} value={r.code}>{r.label}</MenuItem>)}
          </TextField>
          <TextField fullWidth size="small" multiline minRows={2} label={draft?.hasBlocker ? "Justificativa (mín. 20 caracteres)" : "Justificativa (opcional)"} value={reason} onChange={(e) => setReason(e.target.value)} sx={{ mb: 1.5 }} />
          {draft?.state === "ignored" && (
            <TextField fullWidth size="small" type="date" label="Válido até (opcional)" InputLabelProps={{ shrink: true }} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} helperText="Ao vencer, o GAP volta a Ativo automaticamente." />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDraft(null)} disabled={busy === "triage"}>Cancelar</Button>
          <Button variant="contained" color={draft?.state === "ignored" ? "warning" : "primary"} disabled={busy === "triage" || !reasonCode || (!!draft?.hasBlocker && reason.trim().length < 20)} onClick={() => void submitDraft()}>
            {busy === "triage" ? "Aplicando…" : draft?.state === "ignored" ? "Ignorar" : "Refutar"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
