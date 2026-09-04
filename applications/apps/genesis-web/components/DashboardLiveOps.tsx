"use client";
/**
 * DashboardLiveOps — RFC-0004 Onda 5 (F5): KPIs vivos da fábrica + gerencial admin.
 *
 * Consome UMA chamada de GET /api/dashboard/summary (query-on-read — D5): por projeto
 * ativo mostra tarefa atual, agente atual (vivacidade GATEADA no servidor: só com
 * status running E run aberta — nada de "QA revisando" congelado), tempo decorrido,
 * custo (tabela única de preços) e até 3 mensagens importantes (severidade da 075).
 * Para zentriz_admin, faixa gerencial: novos tenants 30d, aguardando pagamento
 * (inactive COM cobrança aberta), inativos-ação-manual, suspensos, ativos.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import BoltIcon from "@mui/icons-material/Bolt";
import { useRouter } from "next/navigation";
import { apiGet, withQuery } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";

interface ImportantMsg { summary_human: string; from_agent: string; severity: string; created_at: string }
interface SummaryProject {
  id: string; title: string; status: string; product_name: string | null;
  tasks_total: number; tasks_done: number; current_task: string | null;
  cost_usd: string | number | null; running_seconds: number | null;
  current_agent: string | null; important_messages: ImportantMsg[];
}
interface Summary {
  projects: SummaryProject[];
  admin: { new_30d: number; awaiting_payment: number; inactive_manual: number; suspended: number; active: number } | null;
}

const SEV_COLOR: Record<string, "error" | "warning" | "info" | "success"> = {
  critical: "error", warning: "warning", notice: "success", info: "info",
};

function fmtElapsed(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}min`;
}

export default function DashboardLiveOps() {
  const router = useRouter();
  const [data, setData] = useState<Summary | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // PR-0 (Ondas 4/5): master com tenant selecionado no topo vê SÓ aquele tenant — antes a
  // chamada ia sem `tenantId` e o summary voltava global. Para tenant_admin/user o backend
  // ignora o parâmetro (escopa pelo próprio tenant); `withQuery` omite null/"" sozinho.
  const load = useCallback(async () => {
    try {
      setData(await apiGet<Summary>(withQuery("/api/dashboard/summary", { tenantId: tenantScopeStore.effectiveTenantId })));
    } catch { /* silencioso */ }
  }, []);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), 30_000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  if (!data) return null;
  const running = data.projects.filter((p) => p.status === "running");
  const admin = data.admin;

  return (
    <Box sx={{ mb: 3 }}>
      {/* faixa gerencial — só zentriz_admin */}
      {admin && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <Chip size="small" color="success" label={`Tenants ativos: ${admin.active}`} />
          <Chip size="small" color="info" label={`Novos (30d): ${admin.new_30d}`} />
          <Chip size="small" color="warning" label={`Aguardando pagamento: ${admin.awaiting_payment}`} />
          <Chip size="small" label={`Inativos (ação manual): ${admin.inactive_manual}`} />
          <Chip size="small" color="error" label={`Suspensos: ${admin.suspended}`} />
        </Stack>
      )}

      {/* cards vivos da fábrica */}
      {running.length > 0 && (
        <>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <BoltIcon color="warning" sx={{ fontSize: "1.1rem" }} />
            <Typography variant="subtitle2">Na fábrica agora ({running.length})</Typography>
          </Stack>
          <Grid container spacing={2}>
            {running.map((p) => (
              <Grid size={{ xs: 12, md: 6, lg: 4 }} key={p.id}>
                <Card variant="outlined" sx={{ cursor: "pointer", height: "100%" }}
                      onClick={() => router.push(`/projects/${p.id}`)}>
                  <CardContent sx={{ pb: "12px !important" }}>
                    <Typography variant="subtitle2" noWrap>{p.title}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap display="block">
                      {p.product_name ?? "—"}
                    </Typography>
                    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ my: 1 }}>
                      <Chip size="small" label={`tarefas ${p.tasks_done}/${p.tasks_total}`} sx={{ height: 20, fontSize: "0.68rem" }} />
                      <Chip size="small" label={`⏱ ${fmtElapsed(p.running_seconds)}`} sx={{ height: 20, fontSize: "0.68rem" }} />
                      <Chip size="small" label={`US$ ${Number(p.cost_usd ?? 0).toFixed(2)}`} sx={{ height: 20, fontSize: "0.68rem" }} />
                      {p.current_agent && <Chip size="small" color="info" label={`agente: ${p.current_agent}`} sx={{ height: 20, fontSize: "0.68rem" }} />}
                    </Stack>
                    {p.current_task && (
                      <Typography variant="caption" display="block" noWrap sx={{ mb: 0.5 }}>
                        ▸ {p.current_task}
                      </Typography>
                    )}
                    {(p.important_messages ?? []).slice(0, 3).map((m, i) => (
                      <Stack key={i} direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                        <Chip size="small" color={SEV_COLOR[m.severity] ?? "info"} label={m.severity}
                              sx={{ height: 16, fontSize: "0.6rem" }} />
                        <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
                          {m.summary_human}
                        </Typography>
                      </Stack>
                    ))}
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        </>
      )}
    </Box>
  );
}
