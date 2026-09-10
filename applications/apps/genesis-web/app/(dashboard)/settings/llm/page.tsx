"use client";

/**
 * Configuração de LLM do TENANT.
 *
 * O editor de slot vive em `components/llm/LlmSlotEditor.tsx` e é o MESMO usado pela conta de
 * gestão (`/zentriz/llm`) — as duas telas configuram a mesma coisa e falam o mesmo payload; o que
 * muda aqui é o endpoint (`/api/tenant/llm-config`), o escopo de tenant do master, e o fato de o
 * slot de tenant rodar fábrica (logo, ter Cyborg e limites).
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PsychologyIcon from "@mui/icons-material/Psychology";
import { apiGet, apiPost, apiDelete, withQuery } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
import {
  LlmSlotEditor, LlmSlotCard, SLOT_LABEL, VERIFY_LABEL,
  type LlmSlot, type VerifyResult,
} from "@/components/llm/LlmSlotEditor";

interface LlmConfigResponse {
  slots: LlmSlot[];
  /** ⚖️ LEI 2026-09-10: provider/model vêm NULOS — não existe mais "padrão do sistema" de env. */
  system_default: {
    provider: string | null;
    model_id: string | null;
    cyborg_model_id?: string | null;
    cyborg_model_id_fallback?: string | null;
  };
  /** Tenant autorizado por zentriz_admin a rodar na conta da Zentriz. */
  byoc_exempt?: boolean;
  /** Famílias distintas cobertas pelos slots utilizáveis (base da recomendação dos 2 slots). */
  families?: string[];
  has_usable_slot?: boolean;
  /** `families.length >= 2` — o que destrava o revisor cross-family (+12 p.p., arXiv:2609.04270). */
  cross_family_available?: boolean;
}

// ── Página principal ──────────────────────────────────────────────────────────

function LlmSettingsInner() {
  // Master: escopa as leituras/escritas ao tenant selecionado no topo (null = próprio JWT).
  const tenantId = tenantScopeStore.effectiveTenantId;
  const [slots, setSlots]   = useState<LlmSlot[]>([]);
  // ⚖️ LEI 2026-09-10: o `sysDefault` literal ("bedrock · sonnet-4-6") era a tela ENSINANDO que
  // existia um LLM de reserva da plataforma. O servidor já devolve `null`; aqui o estado nasce nulo.
  const [sysDefault, setSysDefault] = useState<{ provider: string | null; model_id: string | null }>(
    { provider: null, model_id: null },
  );
  /** Famílias distintas cobertas pelos slots utilizáveis — vem calculado do servidor. */
  const [familias, setFamilias] = useState<string[]>([]);
  const [crossFamily, setCrossFamily] = useState(false);
  const [loading, setLoading] = useState(true);
  const [globalMsg, setGlobalMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Modal
  const [modalOpen, setModalOpen]   = useState(false);
  const [editSlot, setEditSlot]     = useState<LlmSlot | null>(null);
  const [editPriority, setEditPriority] = useState(0);

  // Deleting por priority
  const [deletingPriority, setDeletingPriority] = useState<number | null>(null);
  // Testando por priority (⚖️ Jean, 2026-09-10 — re-teste sob demanda)
  const [testingPriority, setTestingPriority] = useState<number | null>(null);

  // Limites globais — lidos do slot 0, usados em todos os saves
  const [globalLimits, setGlobalLimits] = useState({ maxConc: 3, quota: "", dpRes: 0 });

  const configuredSlots = slots.filter((s) => s.configured && s.has_credentials);

  const load = useCallback(async () => {
    try {
      const raw = await apiGet(withQuery("/api/tenant/llm-config", { tenantId })) as LlmConfigResponse | { configured: boolean };
      if ("slots" in raw) {
        const resp = raw as LlmConfigResponse;
        setSysDefault(resp.system_default);
        setFamilias(resp.families ?? []);
        setCrossFamily(!!resp.cross_family_available);
        const configured = resp.slots.filter((s) => s.configured && s.has_credentials);
        setSlots(configured);
        // Puxar limites do slot 0 se existir
        const slot0 = resp.slots.find((s) => s.priority === 0);
        if (slot0?.configured) {
          setGlobalLimits({
            maxConc: slot0.max_concurrent_projects ?? 3,
            quota:   slot0.daily_token_quota != null ? String(slot0.daily_token_quota) : "",
            dpRes:   slot0.deadpool_token_reserve ?? 0,
          });
        }
      }
    } catch {
      setGlobalMsg({ type: "error", text: "Não foi possível carregar as configurações." });
    } finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  /** Mensagem única para o veredicto — mesma no salvar e no botão "Testar". */
  const mostrarVeredicto = (v: VerifyResult | undefined, slotLabel: string) => {
    if (!v) {
      setGlobalMsg({ type: "success", text: `${slotLabel} salvo. Não foi possível testar agora — use ▶ para testar.` });
      return;
    }
    if (v.ok) {
      setGlobalMsg({ type: "success", text: `${slotLabel}: ${v.model} respondeu em ${v.latency_ms} ms.` });
    } else if (v.status === "unavailable") {
      // Indisponibilidade nossa não reprova o slot do tenant — e por isso também não é gravada.
      setGlobalMsg({ type: "success", text: `${slotLabel} salvo. ${VERIFY_LABEL.unavailable} (${v.message}).` });
    } else {
      // Reprovar NÃO desfaz o salvamento: o slot fica gravado e a cascata o ignora até funcionar.
      setGlobalMsg({
        type: "error",
        text: `${slotLabel} salvo, mas o teste falhou — ${VERIFY_LABEL[v.status] ?? VERIFY_LABEL.other}: ${v.message}`,
      });
    }
  };

  const testSlot = async (priority: number, slotLabel: string) => {
    setTestingPriority(priority);
    setGlobalMsg(null);
    try {
      const r = await apiPost<{ verify: VerifyResult }>(
        withQuery(`/api/tenant/llm-config/${priority}/test`, { tenantId }), {});
      mostrarVeredicto(r?.verify, slotLabel);
      await load();
    } catch (e) {
      setGlobalMsg({ type: "error", text: e instanceof Error ? e.message : "Falha ao testar o slot." });
    } finally { setTestingPriority(null); }
  };

  // ── Reordenar: troca duas posições e re-salva com novas priorities ────────

  const swapSlots = async (indexA: number, indexB: number) => {
    const next = [...configuredSlots];
    [next[indexA], next[indexB]] = [next[indexB], next[indexA]];

    // Optimistic update
    setSlots(next);

    // 🔴 Antes: "DELETE tudo → re-PUT de cada um com credentials {}". Como o DELETE vinha antes, a
    // preservação de credencial do upsert não achava a linha anterior e o REORDER APAGAVA as chaves
    // de todos os slots. Agora a permutação é uma transação no servidor que move a linha inteira
    // (credencial, limites e o veredicto do último teste) — e não dispara teste nenhum: mudar a
    // ordem de preferência não reconfigura nada.
    setGlobalMsg(null);
    try {
      await apiPost(withQuery("/api/tenant/llm-config/reorder", { tenantId }),
        { order: next.map((s) => s.priority) });
      await load();
    } catch {
      setGlobalMsg({ type: "error", text: "Erro ao reordenar. Recarregando…" });
      await load();
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async (slotIndex: number) => {
    const slot = configuredSlots[slotIndex];
    if (!confirm(`Remover "${SLOT_LABEL(slotIndex)}" (${slot.model_id})?`)) return;
    setDeletingPriority(slot.priority);
    try {
      // Remove SÓ o slot pedido e compacta as prioridades pelo reorder transacional — os demais
      // slots nem chegam a ser reescritos, então não perdem credencial nem veredicto de teste.
      const remaining = configuredSlots.filter((_, i) => i !== slotIndex);
      await apiDelete(withQuery(`/api/tenant/llm-config/${slot.priority}`, { tenantId }));
      if (remaining.length > 0) {
        await apiPost(withQuery("/api/tenant/llm-config/reorder", { tenantId }),
          { order: remaining.map((s) => s.priority) });
      }
      await load();
    } catch {
      setGlobalMsg({ type: "error", text: "Erro ao remover." });
    } finally { setDeletingPriority(null); }
  };

  // ── Abrir modal ───────────────────────────────────────────────────────────

  const openAdd = () => {
    if (configuredSlots.length >= 4) {
      setGlobalMsg({ type: "error", text: "Máximo de 4 LLMs atingido." });
      return;
    }
    setEditSlot(null);
    setEditPriority(configuredSlots.length);
    setModalOpen(true);
  };

  const openEdit = (index: number) => {
    setEditSlot(configuredSlots[index]);
    setEditPriority(index);
    setModalOpen(true);
  };

  if (loading) return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}><CircularProgress /></Box>
  );

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: { xs: 2, md: 4 } }}>
      {/* Cabeçalho */}
      <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
        <PsychologyIcon sx={{ color: "primary.main", fontSize: 28 }} />
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h5" fontWeight={700}>Configuração de LLM</Typography>
          <Typography variant="body2" color="text.secondary">
            O Genesis usa os providers na ordem listada — o primeiro é o Padrão, os demais são Contingências.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}
          disabled={configuredSlots.length >= 4}>
          Adicionar
        </Button>
      </Stack>

      {globalMsg && (
        <Alert severity={globalMsg.type} sx={{ mb: 2 }} onClose={() => setGlobalMsg(null)}>
          {globalMsg.text}
        </Alert>
      )}

      {/* Lista de LLMs configurados */}
      {configuredSlots.length === 0 ? (
        <Card variant="outlined" sx={{ textAlign: "center", py: 6, borderStyle: "dashed" }}>
          <CardContent>
            <PsychologyIcon sx={{ fontSize: 48, color: "text.disabled", mb: 1 }} />
            <Typography variant="body1" color="text.secondary" fontWeight={500}>
              Nenhum LLM configurado
            </Typography>
            {/* ⚖️ LEI 2026-09-10: aqui se lia "Usando provider padrão da Zentriz (bedrock ·
                sonnet-4-6)" — a tela prometia um LLM de reserva que rodava na NOSSA conta.
                Não existe mais reserva: sem slot, nada roda. */}
            <Typography variant="body2" color="warning.main" sx={{ mb: 2 }}>
              {sysDefault.provider
                ? `Padrão do sistema: ${sysDefault.provider} · ${sysDefault.model_id}`
                : "Sem nenhum slot configurado, o Genesis não executa runs, validações nem revisões "
                  + "para este tenant. Cadastre ao menos um slot com credenciais próprias."}
            </Typography>
            <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
              Adicionar primeiro LLM
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {configuredSlots.map((slot, index) => (
            <LlmSlotCard
              key={slot.priority}
              slot={slot}
              index={index}
              total={configuredSlots.length}
              onMoveUp={() => swapSlots(index, index - 1)}
              onMoveDown={() => swapSlots(index, index + 1)}
              onEdit={() => openEdit(index)}
              onDelete={() => handleDelete(index)}
              onTest={() => void testSlot(slot.priority, SLOT_LABEL(index))}
              deleting={deletingPriority === slot.priority}
              testing={testingPriority === slot.priority}
            />
          ))}

          {/* Slots vazios restantes — placeholder visual */}
          {configuredSlots.length < 4 && (
            <>
              <Divider sx={{ my: 0.5 }}>
                <Typography variant="caption" color="text.disabled">slots disponíveis</Typography>
              </Divider>
              {Array.from({ length: 4 - configuredSlots.length }).map((_, i) => (
                <Card key={i} variant="outlined"
                  sx={{ borderStyle: "dashed", borderColor: "divider", opacity: 0.5 }}>
                  <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                    <Stack direction="row" alignItems="center" spacing={1.5}>
                      <Chip label={SLOT_LABEL(configuredSlots.length + i)} size="small"
                        sx={{ color: "text.disabled", bgcolor: "action.hover", minWidth: 100 }} />
                      <Typography variant="body2" color="text.disabled">Não configurado</Typography>
                    </Stack>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </Stack>
      )}

      {/* ⚖️ Recomendação do Jean (2026-09-10): "aconselhar os clientes a ter pelo menos 2 slots
          com famílias diferentes". Não é preferência estética — é a única configuração que a
          pesquisa mede como ganho: revisor da MESMA família rende ZERO e rejeita 35% do que está
          certo; cross-family de porte médio rende +12 p.p. com 2% de falso-positivo
          (arXiv:2609.04270). Com uma família só, o revisor cross-family simplesmente não roda. */}
      {configuredSlots.length > 0 && !crossFamily && (
        <Alert severity="warning" sx={{ mt: 3 }}>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
            Todos os seus slots são da mesma família{familias[0] ? ` (${familias[0]})` : ""}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            A revisão cruzada do Genesis fica <strong>desligada</strong>: um modelo revisando a si
            mesmo não acrescenta nada e rejeita cerca de 35% do que está correto. Cadastre um
            segundo slot de <strong>outra família</strong> (ex.: Google ao lado de Claude) — a
            medição de referência mostra <strong>+12 pontos percentuais</strong> de defeitos
            encontrados, com 2% de falso-positivo.
          </Typography>
        </Alert>
      )}

      {/* Informativo */}
      {configuredSlots.length > 0 && (
        <Alert severity="info" sx={{ mt: 3 }} icon={<InfoOutlinedIcon />}>
          <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>Como funciona</Typography>
          <Typography variant="caption" color="text.secondary">
            O Genesis tenta os providers em ordem. Se o <strong>Padrão</strong> falhar ou atingir limite,
            tenta <strong>Contingência 1</strong>, depois <strong>2</strong> e <strong>3</strong>.
            Use ↑ ↓ para mudar a ordem — a posição define a prioridade.
            {crossFamily && (
              <> Com <strong>{familias.length} famílias</strong> cadastradas, a revisão cruzada
              (um modelo de outra família revisando o executor) está <strong>ativa</strong>.</>
            )}
          </Typography>
        </Alert>
      )}

      {/* Modal de adicionar / editar */}
      <LlmSlotEditor
        open={modalOpen}
        slot={editSlot}
        priority={editPriority}
        endpoint="/api/tenant/llm-config"
        tenantId={tenantId}
        showCyborg
        onClose={() => setModalOpen(false)}
        onSaved={(verify) => { mostrarVeredicto(verify, SLOT_LABEL(editPriority)); void load(); }}
        globalLimits={globalLimits}
        onLimitsChange={setGlobalLimits}
      />
    </Box>
  );
}

export default observer(LlmSettingsInner);
