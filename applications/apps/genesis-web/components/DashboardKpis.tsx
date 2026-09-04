"use client";
/**
 * DashboardKpis — Épico Spec/Bancada Onda 5 (§4.2–§4.4): KPIs server-side da home.
 *
 * Consome `GET /api/dashboard/kpis?scope=tenant|admin[&tenantId=]` (flag `DASHBOARD_KPIS`
 * no backend; a UI deriva TUDO da resposta — G13: nada de `NEXT_PUBLIC_*`).
 *   - Faixa tenant: 8 cards (T1–T8) + custo do mês × orçamento (C) + mensagens importantes (M).
 *   - Faixa admin (A1–A6): só para zentriz_admin (scope=admin; nunca pedida por outro papel).
 *   - Refresh a cada 30 s alinhado ao DashboardLiveOps; sem flicker (Skeleton só no 1º load;
 *     em erro mantém o último dado e mostra "sem resposta da API"); pausa em aba oculta e
 *     recarrega ao voltar; troca de tenant no seletor do master zera os dados (fail-closed).
 *   - Degradação limpa: `enabled:false`, 403/500 ou payload vazio → `onAvailability("disabled")`
 *     e o componente renderiza null → a página mantém os 4 cards contados no cliente.
 * Sem gráficos/gauges/libs novas (NN/g); cor nunca é o único sinal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { observer } from "mobx-react-lite";
import { useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import HandymanIcon from "@mui/icons-material/Handyman";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ReportProblemIcon from "@mui/icons-material/ReportProblem";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import TimerIcon from "@mui/icons-material/Timer";
import PercentIcon from "@mui/icons-material/Percent";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import LightbulbIcon from "@mui/icons-material/Lightbulb";
import BusinessIcon from "@mui/icons-material/Business";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import BlockIcon from "@mui/icons-material/Block";
import FactoryIcon from "@mui/icons-material/Factory";
import AttachMoneyIcon from "@mui/icons-material/AttachMoney";
import AssignmentLateIcon from "@mui/icons-material/AssignmentLate";
import CampaignIcon from "@mui/icons-material/Campaign";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { authStore } from "@/stores/authStore";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
import { apiGet, withQuery } from "@/lib/api";
import { formatAgo, formatDuration, formatInt, formatPercent, formatShortTime, formatUsd, toFiniteNumber } from "@/lib/format";
import { KpiCard } from "@/components/KpiCard";
import type { KpiTone } from "@/components/KpiCard";

// ── Contrato REAL (API/routes/dashboard.ts, bloco de comentário da rota) — acesso sempre defensivo ──
type Num = number | string | null | undefined;
interface KpiMessage {
  projectId?: string; title?: string; summaryHuman?: string; fromAgent?: string;
  eventType?: string; severity?: string; createdAt?: string;
}
interface TenantKpiNumbers {
  onBench?: Num; inFactory?: Num; blocked?: Num; delivered30d?: Num; deliveredPrev30d?: Num;
  leadTimeMedianSec?: Num; failed30d?: Num; accepted30d?: Num; failureRate30d?: Num;
  tasksDone?: Num; tasksTotal?: Num; proposalsRunning?: Num; proposalsReady?: Num;
}
interface TenantCost {
  monthUsd?: Num; budgetUsd?: Num; acceptedMtd?: Num; costPerDeliveryUsd?: Num;
  topModels?: { model?: string | null; usd?: Num }[];
}
interface AdminKpiNumbers {
  tenantsActive?: Num; tenantsNew30d?: Num; awaitingPayment?: Num; emailUnconfirmed?: Num;
  tenantsSuspended?: Num; projectsBlocked?: Num; factoryRunning?: Num; factoryQueued?: Num; proposalsInFlight?: Num;
  monthUsd?: Num; topTenants?: { tenantId?: string; tenantName?: string | null; usd?: Num }[];
  approvalsPending?: Num; proposalsStuck24h?: Num; specRunsFailed24h?: Num;
}
interface KpisResponse {
  enabled?: boolean;
  scope?: string;
  tenantId?: string;
  /** Sentinela "sem tenant resolvível" (scope=tenant): `tenant: null` → sem dados, NÃO é erro. */
  tenant?: null;
  features?: { dashboardKpis?: boolean };
  kpis?: TenantKpiNumbers & AdminKpiNumbers;
  cost?: TenantCost;
  messages?: KpiMessage[];
}
/** Visões derivadas da resposta, já separadas por escopo. */
interface TenantView { kpis: TenantKpiNumbers; cost?: TenantCost; messages?: KpiMessage[] }
type AdminView = AdminKpiNumbers;

export type KpisAvailability = "loading" | "enabled" | "disabled";

const REFRESH_MS = 30_000;

// ── Hook de polling por escopo ──────────────────────────────────────────────────────────────
type FetchStatus = "idle" | "ok" | "error" | "disabled" | "skipped";
interface FetchState { data: KpisResponse | null; status: FetchStatus; updatedAt: number | null; errorCount: number }
const INITIAL: FetchState = { data: null, status: "idle", updatedAt: null, errorCount: 0 };

function useKpisScope(scope: "tenant" | "admin", tenantId: string | null, active: boolean) {
  const [state, setState] = useState<FetchState>(active ? INITIAL : { ...INITIAL, status: "skipped" });
  const key = `${scope}:${tenantId ?? ""}:${active ? 1 : 0}`;
  const keyRef = useRef(key);
  const lastFetchRef = useRef(0);

  const load = useCallback(async () => {
    if (!active) return;
    const myKey = keyRef.current;
    lastFetchRef.current = Date.now();
    try {
      const res = await apiGet<KpisResponse>(withQuery("/api/dashboard/kpis", { scope, tenantId }));
      if (keyRef.current !== myKey) return; // escopo mudou durante o voo: descarta (fail-closed)
      if (!res || res.enabled === false) {
        setState({ data: null, status: "disabled", updatedAt: Date.now(), errorCount: 0 });
        return;
      }
      setState({ data: res, status: "ok", updatedAt: Date.now(), errorCount: 0 });
    } catch {
      if (keyRef.current !== myKey) return;
      // mantém o último dado bom (sem flicker); só marca o erro
      setState((s) => ({ ...s, status: "error", errorCount: s.errorCount + 1 }));
    }
  }, [scope, tenantId, active]);

  useEffect(() => {
    keyRef.current = key;
    setState(active ? INITIAL : { ...INITIAL, status: "skipped" });
    if (!active) return;
    void load();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return; // aba oculta: não gasta
      void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastFetchRef.current > REFRESH_MS - 1000) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, active, load]);

  return { ...state, refresh: load };
}

// ── Auxiliares de apresentação ──────────────────────────────────────────────────────────────
const SEV_COLOR: Record<string, "error" | "warning" | "info" | "success"> = {
  critical: "error", warning: "warning", notice: "success", info: "info",
};
const SEV_LABEL: Record<string, string> = { critical: "crítico", warning: "alerta", notice: "aviso", info: "info" };

const n0 = (v: unknown): number => toFiniteNumber(v) ?? 0;
const joinParts = (parts: (string | null | false | undefined)[]) => {
  const p = parts.filter((x): x is string => typeof x === "string" && x.length > 0);
  return p.length ? p.join(" · ") : undefined;
};

/** Carimbo "atualizado há …" com tick próprio (10 s) para não re-renderizar os cards. */
function UpdatedAgo({ updatedAt, stale, onRefresh }: { updatedAt: number | null; stale: boolean; onRefresh: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0 }}>
      {stale && (
        <Tooltip title="A API não respondeu na última atualização; os valores exibidos são os últimos recebidos.">
          <WarningAmberIcon color="warning" sx={{ fontSize: "0.95rem" }} aria-label="Dados possivelmente desatualizados" />
        </Tooltip>
      )}
      <Typography variant="caption" color="text.secondary" noWrap>
        {stale ? `sem resposta da API · dados ${formatAgo(updatedAt, now)}` : `atualizado ${formatAgo(updatedAt, now)}`}
      </Typography>
      <IconButton size="small" onClick={onRefresh} aria-label="Atualizar indicadores" sx={{ p: 0.25 }}>
        <RefreshIcon sx={{ fontSize: "1rem" }} />
      </IconButton>
    </Stack>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Typography variant="subtitle2" color="text.secondary" noWrap
      sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.65rem" }}>
      {children}
    </Typography>
  );
}

// ── Faixa tenant ────────────────────────────────────────────────────────────────────────────
function TenantCards({ t, loading }: { t: TenantView | null; loading: boolean }) {
  const k = t?.kpis;
  const blocked = n0(k?.blocked);
  const failure = toFiniteNumber(k?.failureRate30d);
  const failureTone: KpiTone = failure === null || failure === 0 ? "default" : failure >= 0.25 ? "error" : "warning";
  const tasksDone = n0(k?.tasksDone), tasksTotal = n0(k?.tasksTotal);
  const ready = n0(k?.proposalsReady), inFlight = n0(k?.proposalsRunning);
  const lead = toFiniteNumber(k?.leadTimeMedianSec);
  const delivered = toFiniteNumber(k?.delivered30d), deliveredPrev = toFiniteNumber(k?.deliveredPrev30d);
  const delta = delivered !== null && deliveredPrev !== null ? delivered - deliveredPrev : null;
  const failed30d = n0(k?.failed30d), accepted30d = n0(k?.accepted30d);

  return (
    <Grid container spacing={{ xs: 1.5, sm: 2 }}>
      <Grid size={{ xs: 6, sm: 4, md: 3 }}>
        <KpiCard label="Na Bancada" value={loading ? null : formatInt(k?.onBench)} loading={loading} delay={1} href="/specs"
          icon={<HandymanIcon sx={{ color: "#0EA5E9" }} />} gradient="linear-gradient(135deg, #0EA5E9 0%, #0284C7 100%)"
          hint="Specs ainda fora da fábrica: rascunhos, enviadas, em conversão, com validação falha ou aguardando informação. Clique para abrir a Bancada." />
      </Grid>
      <Grid size={{ xs: 6, sm: 4, md: 3 }}>
        <KpiCard label="Na fábrica agora" value={loading ? null : formatInt(k?.inFactory)} loading={loading} delay={2} href="/projects"
          icon={<PlayArrowIcon sx={{ color: "#10B981" }} />} gradient="linear-gradient(135deg, #10B981 0%, #059669 100%)"
          hint="Projetos em fila ou com pipeline em execução neste momento (CTO, PM, Dev/QA, DevOps, Cyborg)." />
      </Grid>
      <Grid size={{ xs: 6, sm: 4, md: 3 }}>
        <KpiCard label="Bloqueados / atenção" value={loading ? null : formatInt(blocked)} loading={loading} delay={3} href="/projects"
          tone={blocked > 0 ? "error" : "default"}
          icon={<ReportProblemIcon sx={{ color: blocked > 0 ? "#EF4444" : "#8B949E" }} />} gradient="linear-gradient(135deg, #64748B 0%, #475569 100%)"
          sub={blocked > 0 ? "precisam de ação" : undefined}
          hint="Projetos bloqueados por gate estrutural, com falha ou parados — precisam de ação humana." />
      </Grid>
      <Grid size={{ xs: 6, sm: 4, md: 3 }}>
        <KpiCard label="Entregues 30 d" value={loading ? null : formatInt(delivered)} loading={loading} delay={4}
          icon={<CheckCircleIcon sx={{ color: "#F59E0B" }} />} gradient="linear-gradient(135deg, #F59E0B 0%, #D97706 100%)"
          delta={delta} deltaLabel="vs. 30 d ant." deltaGood="up"
          hint="Projetos aceitos ou concluídos nos últimos 30 dias (frequência de entrega — DORA). A seta compara com os 30 dias anteriores." />
      </Grid>
      <Grid size={{ xs: 6, sm: 4, md: 3 }}>
        <KpiCard label="Lead time mediano" value={loading ? null : formatDuration(lead)} loading={loading} delay={5}
          icon={<TimerIcon sx={{ color: "#6366F1" }} />}
          sub={!loading && lead === null ? "menos de 3 amostras" : undefined}
          hint="Mediana do tempo entre o início e a conclusão dos projetos entregues nos últimos 30 dias (DORA). Exige ao menos 3 amostras." />
      </Grid>
      <Grid size={{ xs: 6, sm: 4, md: 3 }}>
        <KpiCard label="Taxa de falha 30 d" value={loading ? null : formatPercent(failure, failure !== null && failure > 0 && failure < 0.1 ? 1 : 0)} loading={loading} delay={6}
          tone={failureTone}
          icon={<PercentIcon sx={{ color: failureTone === "default" ? "#8B949E" : failureTone === "error" ? "#EF4444" : "#F59E0B" }} />}
          gradient="linear-gradient(135deg, #64748B 0%, #475569 100%)"
          sub={loading ? undefined : failure === null ? "sem entregas no período" : `${formatInt(failed30d)} falhas · ${formatInt(accepted30d)} aceitos`}
          hint="Falhas ÷ (aceitos + falhas) nos últimos 30 dias — análogo ao change failure rate (DORA)." />
      </Grid>
      <Grid size={{ xs: 6, sm: 4, md: 3 }}>
        <KpiCard label="Tarefas (ativos)" value={loading ? null : tasksTotal > 0 ? `${formatInt(tasksDone)}/${formatInt(tasksTotal)}` : "—"} loading={loading} delay={7}
          icon={<TaskAltIcon sx={{ color: "#10B981" }} />} gradient="linear-gradient(135deg, #10B981 0%, #059669 100%)"
          progress={tasksTotal > 0 ? tasksDone / tasksTotal : null}
          sub={tasksTotal > 0 ? formatPercent(tasksDone / tasksTotal) : "nenhum projeto ativo"}
          hint="Tarefas concluídas sobre o total dos projetos ativos na fábrica (exclui tarefas de infraestrutura e herdadas)." />
      </Grid>
      <Grid size={{ xs: 6, sm: 4, md: 3 }}>
        <KpiCard label="Propostas de produto" value={loading ? null : formatInt(ready)} loading={loading} delay={8} href="/specs"
          icon={<LightbulbIcon sx={{ color: "#A855F7" }} />} gradient="linear-gradient(135deg, #A855F7 0%, #7C3AED 100%)"
          sub={joinParts([ready > 0 && "prontas para revisão", inFlight > 0 && `${formatInt(inFlight)} em análise`]) ?? (loading ? undefined : "nenhuma pendente")}
          hint="Propostas geradas pela IA a partir de uma ideia ou spec: prontas para sua revisão (valor) e ainda em análise." />
      </Grid>
    </Grid>
  );
}

function CostCard({ cost, loading }: { cost: TenantCost | undefined; loading: boolean }) {
  const mtd = toFiniteNumber(cost?.monthUsd);
  const budget = toFiniteNumber(cost?.budgetUsd);
  const perDelivery = toFiniteNumber(cost?.costPerDeliveryUsd);
  const acceptedMtd = n0(cost?.acceptedMtd);
  const ratio = budget && budget > 0 && mtd !== null ? mtd / budget : null;
  const tone: KpiTone = ratio === null ? "default" : ratio >= 1 ? "error" : ratio >= 0.8 ? "warning" : "default";
  const top = (cost?.topModels ?? []).filter((m) => m && (m.model || m.usd !== undefined)).slice(0, 3);

  return (
    <KpiCard label="Custo do mês" value={loading ? null : formatUsd(mtd)} loading={loading} delay={9} tone={tone}
      icon={<AttachMoneyIcon sx={{ color: tone === "default" ? "#10B981" : tone === "error" ? "#EF4444" : "#F59E0B" }} />}
      gradient="linear-gradient(135deg, #10B981 0%, #059669 100%)"
      progress={ratio}
      sub={budget && budget > 0
        ? `de ${formatUsd(budget)} · ${formatPercent(ratio)} do orçamento`
        : "sem orçamento mensal definido"}
      hint="Gasto com modelos de IA desde o 1º dia do mês (todas as chamadas da fábrica) comparado ao orçamento mensal do tenant. Custo por entrega = gasto do mês ÷ projetos aceitos no mês."
      footer={
        <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" noWrap>
            {perDelivery !== null ? `${formatUsd(perDelivery)} por entrega (${formatInt(acceptedMtd)} no mês)` : "sem entregas no mês"}
          </Typography>
          {top.map((m, i) => (
            <Chip key={`${m.model ?? "model"}-${i}`} size="small" variant="outlined"
              label={`${m.model ?? "modelo"} · ${formatUsd(m.usd, { compact: true })}`}
              sx={{ height: 20, fontSize: "0.62rem", maxWidth: "100%" }} />
          ))}
        </Stack>
      }
    />
  );
}

function MessagesCard({ messages, loading }: { messages: KpiMessage[] | undefined; loading: boolean }) {
  const router = useRouter();
  const list = (messages ?? []).slice(0, 5);
  return (
    <Card sx={{ height: "100%", overflow: "hidden" }}>
      <Box sx={{ height: 3, background: "linear-gradient(135deg, #F59E0B 0%, #D97706 100%)" }} />
      <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.75 }}>
          <CampaignIcon sx={{ fontSize: "1rem", color: "#F59E0B" }} />
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Mensagens importantes
          </Typography>
        </Stack>
        {loading ? (
          <Stack spacing={0.75}>
            <Skeleton variant="text" width="90%" />
            <Skeleton variant="text" width="75%" />
            <Skeleton variant="text" width="80%" />
          </Stack>
        ) : list.length === 0 ? (
          <Typography variant="body2" color="text.secondary">Nenhuma mensagem importante recente.</Typography>
        ) : (
          <Stack spacing={0.5}>
            {list.map((m, i) => {
              const sev = (m.severity ?? "info").toLowerCase();
              const clickable = !!m.projectId;
              return (
                <Stack key={`${m.projectId ?? "m"}-${m.createdAt ?? i}`} direction="row" spacing={0.75} alignItems="flex-start"
                  onClick={clickable ? () => router.push(`/projects/${m.projectId}`) : undefined}
                  role={clickable ? "link" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onKeyDown={clickable ? (e) => { if (e.key === "Enter") router.push(`/projects/${m.projectId}`); } : undefined}
                  sx={{
                    minWidth: 0, px: 0.75, py: 0.5, mx: -0.75, borderRadius: 1,
                    cursor: clickable ? "pointer" : "default",
                    "&:hover": clickable ? { bgcolor: "action.hover" } : undefined,
                    "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
                  }}>
                  <Chip size="small" color={SEV_COLOR[sev] ?? "info"} label={SEV_LABEL[sev] ?? sev}
                    sx={{ height: 18, fontSize: "0.6rem", flexShrink: 0, mt: "1px" }} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Stack direction="row" justifyContent="space-between" spacing={1} sx={{ minWidth: 0 }}>
                      <Typography variant="caption" fontWeight={600} noWrap sx={{ minWidth: 0 }}>{m.title ?? "Projeto"}</Typography>
                      <Typography variant="caption" color="text.disabled" noWrap sx={{ flexShrink: 0 }}>{formatShortTime(m.createdAt)}</Typography>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" display="block"
                      sx={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                      {m.fromAgent ? `${m.fromAgent}: ` : ""}{m.summaryHuman ?? "—"}
                    </Typography>
                  </Box>
                </Stack>
              );
            })}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

// ── Faixa admin (A1–A6) ─────────────────────────────────────────────────────────────────────
function AdminCards({ a, loading }: { a: AdminView | null; loading: boolean }) {
  const pendingTotal = n0(a?.awaitingPayment) + n0(a?.emailUnconfirmed);
  const suspended = n0(a?.tenantsSuspended), projBlocked = n0(a?.projectsBlocked);
  const approvals = n0(a?.approvalsPending);
  const stuck = n0(a?.proposalsStuck24h) + n0(a?.specRunsFailed24h);
  const topTenants = (a?.topTenants ?? []).slice(0, 5);
  const topHint = (
    <Box>
      <Typography variant="caption" display="block" sx={{ mb: 0.5 }}>
        Gasto com IA de toda a plataforma no mês (showback — não gera cobrança). Top tenants:
      </Typography>
      {topTenants.length === 0
        ? <Typography variant="caption">—</Typography>
        : topTenants.map((t, i) => (
          <Typography key={t.tenantId ?? i} variant="caption" display="block">
            {i + 1}. {t.tenantName ?? t.tenantId ?? "tenant"} — {formatUsd(t.usd)}
          </Typography>
        ))}
    </Box>
  );
  const size = { xs: 6, sm: 4, md: 2 } as const;

  return (
    <Grid container spacing={{ xs: 1.5, sm: 2 }}>
      <Grid size={size}>
        <KpiCard label="Tenants ativos" value={loading ? null : formatInt(a?.tenantsActive)} loading={loading} delay={1} href="/zentriz/tenants"
          icon={<BusinessIcon sx={{ color: "#10B981" }} />} gradient="linear-gradient(135deg, #10B981 0%, #059669 100%)"
          sub={n0(a?.tenantsNew30d) > 0 ? `+${formatInt(a?.tenantsNew30d)} novos 30 d` : "nenhum novo em 30 d"}
          hint="Tenants com status ativo; a linha secundária conta os cadastrados nos últimos 30 dias." />
      </Grid>
      <Grid size={size}>
        <KpiCard label="Pend. desbloqueio" value={loading ? null : formatInt(pendingTotal)} loading={loading} delay={2} href="/zentriz/tenants"
          tone={pendingTotal > 0 ? "warning" : "default"}
          icon={<LockOpenIcon sx={{ color: pendingTotal > 0 ? "#F59E0B" : "#8B949E" }} />} gradient="linear-gradient(135deg, #64748B 0%, #475569 100%)"
          sub={joinParts([`${formatInt(a?.awaitingPayment)} pgto.`, `${formatInt(a?.emailUnconfirmed)} e-mail`])}
          hint="Tenants aguardando pagamento (inativos com cobrança aberta) + cadastros com e-mail ainda não confirmado. Não é um estado do tenant: é derivado." />
      </Grid>
      <Grid size={size}>
        <KpiCard label="Bloqueados" value={loading ? null : formatInt(suspended)} loading={loading} delay={3} href="/zentriz/tenants"
          tone={suspended + projBlocked > 0 ? "error" : "default"}
          icon={<BlockIcon sx={{ color: suspended + projBlocked > 0 ? "#EF4444" : "#8B949E" }} />} gradient="linear-gradient(135deg, #64748B 0%, #475569 100%)"
          sub={`${formatInt(projBlocked)} projetos bloq.`}
          hint="Tenants suspensos (valor) e projetos em estado bloqueado em todos os tenants (linha secundária)." />
      </Grid>
      <Grid size={size}>
        <KpiCard label="Fábrica global" value={loading ? null : formatInt(a?.factoryRunning)} loading={loading} delay={4} href="/zentriz/projects"
          icon={<FactoryIcon sx={{ color: "#6366F1" }} />}
          sub={joinParts([`${formatInt(a?.factoryQueued)} na fila`, n0(a?.proposalsInFlight) > 0 && `${formatInt(a?.proposalsInFlight)} propostas`])}
          hint="Pipelines em execução em todos os tenants; na linha secundária, os que aguardam na fila e as propostas de produto em voo." />
      </Grid>
      <Grid size={size}>
        <KpiCard label="Custo MTD plataforma" value={loading ? null : formatUsd(a?.monthUsd, { compact: true })} loading={loading} delay={5}
          icon={<AttachMoneyIcon sx={{ color: "#10B981" }} />} gradient="linear-gradient(135deg, #10B981 0%, #059669 100%)"
          sub={topTenants[0] ? `top: ${topTenants[0].tenantName ?? topTenants[0].tenantId ?? "—"}` : undefined}
          hint={topHint} />
      </Grid>
      <Grid size={size}>
        <KpiCard label="Pendências operacionais" value={loading ? null : formatInt(approvals)} loading={loading} delay={6} href="/deadpool"
          tone={approvals + stuck > 0 ? "warning" : "default"}
          icon={<AssignmentLateIcon sx={{ color: approvals + stuck > 0 ? "#F59E0B" : "#8B949E" }} />} gradient="linear-gradient(135deg, #64748B 0%, #475569 100%)"
          sub={`${formatInt(stuck)} travados 24 h`}
          hint="Aprovações de promoção do Auto Care pendentes (valor); travados = propostas de produto interrompidas/com erro + validações de spec falhas nas últimas 24 h." />
      </Grid>
    </Grid>
  );
}

// ── Componente principal ────────────────────────────────────────────────────────────────────
export interface DashboardKpisProps {
  /** Notifica a página: "enabled" → ela esconde os 4 cards legados; "disabled" → mantém-os. */
  onAvailability?: (state: KpisAvailability) => void;
}

function DashboardKpisInner({ onAvailability }: DashboardKpisProps) {
  const isAdmin = authStore.isZentrizAdmin;
  // Só o master usa o seletor de tenant; para os demais o backend escopa pelo próprio tenant
  // (e ignora `?tenantId` — G1), então nem enviamos.
  const tenantId = isAdmin ? tenantScopeStore.effectiveTenantId : null;

  const tenantQ = useKpisScope("tenant", tenantId, true);
  const adminQ = useKpisScope("admin", null, isAdmin);

  // Visões por escopo. `tenant: null` na resposta = sem tenant resolvível (master sem seleção) → sem dados.
  const tenant: TenantView | null = useMemo(() => {
    const r = tenantQ.data;
    if (!r || r.tenant === null || !r.kpis) return null;
    return { kpis: r.kpis, cost: r.cost, messages: r.messages };
  }, [tenantQ.data]);
  const admin: AdminView | null = isAdmin && adminQ.data?.kpis ? adminQ.data.kpis : null;

  const settled = (s: FetchStatus) => s !== "idle";
  const allSettled = settled(tenantQ.status) && (!isAdmin || settled(adminQ.status));
  const hasContent = !!tenant || !!admin;
  const availability: KpisAvailability = hasContent ? "enabled" : allSettled ? "disabled" : "loading";

  useEffect(() => { onAvailability?.(availability); }, [availability, onAvailability]);

  const stale = tenantQ.status === "error" || (isAdmin && adminQ.status === "error");
  const updatedAt = useMemo(() => {
    const ts = [tenantQ.updatedAt, adminQ.updatedAt].filter((x): x is number => typeof x === "number");
    return ts.length ? Math.min(...ts) : null;
  }, [tenantQ.updatedAt, adminQ.updatedAt]);
  const refreshAll = useCallback(() => { void tenantQ.refresh(); if (isAdmin) void adminQ.refresh(); }, [tenantQ, adminQ, isAdmin]);

  if (availability === "disabled") return null;

  // Skeleton por faixa: só enquanto a PRÓPRIA chamada ainda não respondeu (1º load / troca de tenant).
  // Depois disso, refresh de 30 s nunca volta ao Skeleton (sem flicker).
  const tenantPending = tenantQ.status === "idle" && !tenant;
  const adminPending = isAdmin && adminQ.status === "idle" && !admin;
  // Master sem tenant selecionado recebe `tenant:null` → só a faixa admin aparece.
  const tenantTitle = isAdmin && tenantId ? "Indicadores do tenant selecionado" : "Indicadores";
  const showTenant = tenantPending || !!tenant;
  const showAdmin = isAdmin && (adminPending || !!admin);

  return (
    <Box sx={{ mb: 3 }}>
      {showAdmin && (
        <Box sx={{ mb: 2.5 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ mb: 1, minWidth: 0 }}>
            <SectionTitle>Plataforma · gestão Zentriz</SectionTitle>
            {!showTenant && <UpdatedAgo updatedAt={updatedAt} stale={stale} onRefresh={refreshAll} />}
          </Stack>
          <AdminCards a={admin} loading={adminPending} />
        </Box>
      )}

      {showTenant && (
        <Box>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ mb: 1, minWidth: 0 }}>
            <SectionTitle>{tenantTitle}</SectionTitle>
            <UpdatedAgo updatedAt={updatedAt} stale={stale} onRefresh={refreshAll} />
          </Stack>
          <TenantCards t={tenant} loading={tenantPending} />
          <Grid container spacing={{ xs: 1.5, sm: 2 }} sx={{ mt: { xs: 1.5, sm: 2 } }}>
            <Grid size={{ xs: 12, md: 6 }}>
              <CostCard cost={tenant?.cost} loading={tenantPending} />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <MessagesCard messages={tenant?.messages} loading={tenantPending} />
            </Grid>
          </Grid>
        </Box>
      )}
    </Box>
  );
}

const DashboardKpis = observer(DashboardKpisInner);
export default DashboardKpis;
