"use client";

/**
 * LLM da conta de GESTÃO — os slots que custeiam os agentes internos da Zentriz.
 *
 * ⚖️ Jean, 2026-09-10: *"quando eu falo na conta da Zentriz é a conta de gerenciamento, não o tenant
 * ZFactory; é na conta de gerenciamento que deve ter uma config de LLM para os agentes internos, que
 * serão custeados pela Zentriz, não pelos tenants"*.
 *
 * A LEI dos slots proíbe o **default silencioso** (cair no `.env` do container), não um pagador
 * DECLARADO. Aqui o pagador é declarado: linha de banco, credencial própria, tela que diz em
 * português de quem é a fatura. Por isso estes slots **nunca** são fallback de tenant — quem paga o
 * trabalho de um tenant continua sendo o tenant.
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
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { authStore } from "@/stores/authStore";
import {
  LlmSlotEditor, LlmSlotCard, SLOT_LABEL, VERIFY_LABEL,
  type LlmSlot, type VerifyResult,
} from "@/components/llm/LlmSlotEditor";

const ENDPOINT = "/api/management/llm-config";

interface ManagementLlmResponse {
  slots: LlmSlot[];
  has_usable_slot: boolean;
  /** Frase do servidor sobre quem paga — a tela não inventa a sua. */
  payer: string;
}

function ZentrizLlmInner() {
  const [slots, setSlots]     = useState<LlmSlot[]>([]);
  const [payer, setPayer]     = useState("Zentriz (conta de gestão)");
  const [loading, setLoading] = useState(true);
  const [globalMsg, setGlobalMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [modalOpen, setModalOpen]       = useState(false);
  const [editSlot, setEditSlot]         = useState<LlmSlot | null>(null);
  const [editPriority, setEditPriority] = useState(0);
  const [deletingPriority, setDeletingPriority] = useState<number | null>(null);
  const [testingPriority, setTestingPriority]   = useState<number | null>(null);

  // Mesma regra da tela do tenant: a lista mostra o que de fato RODA. Um slot cadastrado sem
  // credencial própria não roda — nem aqui, onde a pagadora é a própria Zentriz.
  const configuredSlots = slots.filter((s) => s.configured && s.has_credentials);

  const load = useCallback(async () => {
    try {
      const resp = await apiGet<ManagementLlmResponse>(ENDPOINT);
      setSlots(resp?.slots ?? []);
      if (resp?.payer) setPayer(resp.payer);
    } catch {
      setGlobalMsg({ type: "error", text: "Não foi possível carregar a configuração da conta de gestão." });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const mostrarVeredicto = (v: VerifyResult | undefined, slotLabel: string) => {
    if (!v) {
      setGlobalMsg({ type: "success", text: `${slotLabel} salvo. Não foi possível testar agora — use ▶ para testar.` });
      return;
    }
    if (v.ok) {
      setGlobalMsg({ type: "success", text: `${slotLabel}: ${v.model} respondeu em ${v.latency_ms} ms.` });
    } else if (v.status === "unavailable") {
      setGlobalMsg({ type: "success", text: `${slotLabel} salvo. ${VERIFY_LABEL.unavailable} (${v.message}).` });
    } else {
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
      const r = await apiPost<{ verify: VerifyResult }>(`${ENDPOINT}/${priority}/test`, {});
      mostrarVeredicto(r?.verify, slotLabel);
      await load();
    } catch (e) {
      setGlobalMsg({ type: "error", text: e instanceof Error ? e.message : "Falha ao testar o slot." });
    } finally { setTestingPriority(null); }
  };

  // A permutação é transacional no servidor (apaga e reinsere dentro da transação): mudar a ordem
  // de preferência não pode apagar credencial nem o veredicto do último teste.
  const swapSlots = async (indexA: number, indexB: number) => {
    const next = [...configuredSlots];
    [next[indexA], next[indexB]] = [next[indexB], next[indexA]];
    setSlots(next);
    setGlobalMsg(null);
    try {
      await apiPost(`${ENDPOINT}/reorder`, { order: next.map((s) => s.priority) });
      await load();
    } catch {
      setGlobalMsg({ type: "error", text: "Erro ao reordenar. Recarregando…" });
      await load();
    }
  };

  const handleDelete = async (slotIndex: number) => {
    const slot = configuredSlots[slotIndex];
    if (!confirm(`Remover "${SLOT_LABEL(slotIndex)}" (${slot.model_id})?`)) return;
    setDeletingPriority(slot.priority);
    try {
      const remaining = configuredSlots.filter((_, i) => i !== slotIndex);
      await apiDelete(`${ENDPOINT}/${slot.priority}`);
      if (remaining.length > 0) {
        await apiPost(`${ENDPOINT}/reorder`, { order: remaining.map((s) => s.priority) });
      }
      await load();
    } catch {
      setGlobalMsg({ type: "error", text: "Erro ao remover." });
    } finally { setDeletingPriority(null); }
  };

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

  if (!authStore.isZentrizAdmin) {
    return (
      <Box sx={{ maxWidth: 800, mx: "auto", p: { xs: 2, md: 4 } }}>
        <Alert severity="error">Esta tela é exclusiva da conta de gestão da Zentriz.</Alert>
      </Box>
    );
  }

  if (loading) return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}><CircularProgress /></Box>
  );

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: { xs: 2, md: 4 } }}>
      <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <PsychologyIcon sx={{ color: "primary.main", fontSize: 28 }} />
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h5" fontWeight={700}>LLM da Zentriz (conta de gestão)</Typography>
          <Typography variant="body2" color="text.secondary">
            Modelos usados pelos <strong>agentes internos</strong> — trabalho da própria Zentriz, na
            ordem listada: o primeiro é o Padrão, os demais são Contingências.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}
          disabled={configuredSlots.length >= 4}>
          Adicionar
        </Button>
      </Stack>

      {/* A frase que evita o mal-entendido caro: esta conta PAGA, e não é reserva de ninguém. */}
      <Alert severity="warning" sx={{ mb: 2 }}>
        <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
          Quem paga: {payer}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Todo consumo destes slots é faturado na conta da Zentriz. Eles servem <strong>apenas</strong>{" "}
          aos agentes internos (ex.: o agente de operações) e <strong>nunca</strong> são usados como
          reserva de um tenant — o trabalho de um tenant continua saindo dos slots dele.
        </Typography>
      </Alert>

      {globalMsg && (
        <Alert severity={globalMsg.type} sx={{ mb: 2 }} onClose={() => setGlobalMsg(null)}>
          {globalMsg.text}
        </Alert>
      )}

      {configuredSlots.length === 0 ? (
        <Card variant="outlined" sx={{ textAlign: "center", py: 6, borderStyle: "dashed" }}>
          <CardContent>
            <PsychologyIcon sx={{ fontSize: 48, color: "text.disabled", mb: 1 }} />
            <Typography variant="body1" color="text.secondary" fontWeight={500}>
              Nenhum LLM configurado para a conta de gestão
            </Typography>
            <Typography variant="body2" color="warning.main" sx={{ mb: 2 }}>
              Sem slot aqui, os agentes internos da Zentriz não executam — e não existe caminho de
              reserva: a chamada falha em vez de sair pelo ambiente do servidor.
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
              zentrizIsPayer
              onMoveUp={() => swapSlots(index, index - 1)}
              onMoveDown={() => swapSlots(index, index + 1)}
              onEdit={() => openEdit(index)}
              onDelete={() => handleDelete(index)}
              onTest={() => void testSlot(slot.priority, SLOT_LABEL(index))}
              deleting={deletingPriority === slot.priority}
              testing={testingPriority === slot.priority}
            />
          ))}

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

      {configuredSlots.length > 0 && (
        <Alert severity="info" sx={{ mt: 3 }} icon={<InfoOutlinedIcon />}>
          <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>Como funciona</Typography>
          <Typography variant="caption" color="text.secondary">
            Os agentes internos tentam os providers em ordem. Se o <strong>Padrão</strong> falhar ou
            atingir limite, tentam <strong>Contingência 1</strong>, depois <strong>2</strong> e{" "}
            <strong>3</strong>. Use ↑ ↓ para mudar a ordem — a posição define a prioridade.
          </Typography>
        </Alert>
      )}

      <LlmSlotEditor
        open={modalOpen}
        slot={editSlot}
        priority={editPriority}
        endpoint={ENDPOINT}
        showLabel
        onClose={() => setModalOpen(false)}
        onSaved={(verify) => { mostrarVeredicto(verify, SLOT_LABEL(editPriority)); void load(); }}
      />
    </Box>
  );
}

export default observer(ZentrizLlmInner);
