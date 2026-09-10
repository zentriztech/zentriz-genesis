"use client";

/**
 * LlmSlotEditor — o editor de slot de LLM, **um só**, servindo duas telas.
 *
 * ⚖️ Jean, 2026-09-10: *"é na conta de gerenciamento que deve ter uma config de LLM para os agentes
 * internos, que serão custeados pela Zentriz, não pelos tenants"*.
 *
 * Por que compartilhar em vez de copiar: as duas telas configuram a MESMA coisa (provider, modelo,
 * credencial, contingência) com o mesmo payload — o backend foi escrito assim de propósito
 * (`managementLlm.ts`). Uma segunda cópia divergiria na primeira correção que alguém esquecesse de
 * replicar, e o modo de falha desta tela é sempre o mesmo: **dizer verde sobre um slot que o runtime
 * recusa**. Um componente, uma verdade.
 *
 * O que muda entre as duas telas é só o que é de fato diferente:
 *  · `endpoint` — `/api/tenant/llm-config` × `/api/management/llm-config`;
 *  · `tenantId` — escopo do master ao operar dentro de um tenant (a gestão não é um tenant);
 *  · `showCyborg` / `globalLimits` — a conta de gestão não roda fábrica, logo não tem Cyborg nem
 *    quota de projetos; esconder é mais honesto que exibir campo que o servidor ignora.
 */

import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PsychologyIcon from "@mui/icons-material/Psychology";
import SaveIcon from "@mui/icons-material/Save";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { apiPost, apiPut, withQuery } from "@/lib/api";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type Provider = "bedrock" | "foundry" | "google" | "openai" | "anthropic" | "azure_openai";

export interface LlmSlot {
  configured: boolean;
  priority: number;
  priority_label: string;
  provider: Provider | null;
  model_id: string | null;
  model_id_fallback: string | null;
  cyborg_model_id?: string | null;
  cyborg_model_id_fallback?: string | null;
  /** Rótulo livre — usado pela conta de gestão para dizer a que serve o slot. */
  label?: string | null;
  credentials_masked: Record<string, string>;
  /**
   * ⚖️ LEI 2026-09-10 — três eixos, três campos. `has_credentials` continua significando
   * "tem credencial que SERVE" (é o filtro histórico desta tela); a verdade da FATURA está em
   * `own_credentials` / `uses_zentriz_account`.
   */
  has_credentials: boolean;
  usable?: boolean;
  /** A credencial é de quem configurou ⇒ a fatura do LLM é dele. */
  own_credentials?: boolean;
  /** Roda na conta da Zentriz (tenant com `byoc_exempt`, ou a própria conta de gestão). */
  uses_zentriz_account?: boolean;
  max_concurrent_projects?: number;
  daily_token_quota?: number | null;
  deadpool_token_reserve?: number;
  is_active: boolean;
  /**
   * ⚖️ Jean, 2026-09-10: *"o ideal é testar no momento que é adicionado"*. Resultado da última
   * CHAMADA REAL feita com este slot — pergunta diferente de `own_credentials`, que só olha se os
   * campos estão preenchidos. `null` = nunca testado, que não é o mesmo que reprovado.
   */
  verified_at?: string | null;
  verify_status?: string | null;   // ok | auth | model | quota | network | config | other
  verify_error?: string | null;
  verify_model?: string | null;
  verify_latency_ms?: number | null;
}

/** Veredicto devolvido pelo PUT (salvar) e pelo POST …/test. */
export interface VerifyResult {
  ok: boolean;
  status: string;
  message: string;
  model: string;
  latency_ms: number;
}

/** Rótulo humano de cada motivo de reprovação — o operador precisa saber o que CORRIGIR. */
export const VERIFY_LABEL: Record<string, string> = {
  ok:      "Testado e funcionando",
  auth:    "Credencial recusada",
  model:   "Modelo indisponível para esta conta",
  quota:   "Cota / limite de taxa",
  network: "Falha de rede ao chamar o provider",
  config:  "Configuração incompleta",
  other:   "Falhou no teste",
  /** Indisponibilidade NOSSA (agents fora do ar): não é veredicto sobre o slot e não é gravado. */
  unavailable: "Não foi possível testar agora",
};

/**
 * Catálogo DINÂMICO de modelos — ⚖️ Jean, 2026-09-10: *"a lista de modelos disponíveis deve ser
 * obtida de forma dinâmica baseado no provider e credenciais informadas"*.
 *
 * Cada id volta do servidor JÁ VERIFICADO por invocação real, porque catálogo não é entitlement:
 * na conta de prod o `list-inference-profiles` mostra a família Claude 5 inteira como `ACTIVE` e o
 * `InvokeModel` recusa com 403. Listar sem invocar ofereceria modelos mortos ao operador.
 */
export interface DiscoveredModel {
  id: string;
  /** Passou na invocação real com a credencial informada. */
  ok: boolean;
  /** auth | model | quota | network | config | other — por que reprovou. */
  kind: string;
  message: string;
  latencyMs: number;
}

export interface ModelCatalog {
  provider: string;
  /** `provider` = o próprio provider listou; `catalog` = lista local (Foundry não tem listagem). */
  source: "provider" | "catalog";
  warning: string;
  models: DiscoveredModel[];
  usable: number;
  total: number;
  cached: boolean;
}

// ── Meta dos providers ────────────────────────────────────────────────────────

export const PROVIDER_META: Record<Provider, {
  label: string; icon: string; models: string[];
  fields: { key: string; label: string; placeholder: string; secret?: boolean }[];
}> = {
  bedrock: {
    // Modelos Bedrock validados por invocação real (Converse). Família Claude 5 (Opus 5,
    // Sonnet 5, Fable 5/5.1) + Haiku 4.5 validados em 2026-09-03. Modelos que retornam
    // "model identifier invalid" ou "not authorized" foram removidos.
    // ⚠️ ENTITLEMENT: a família Claude 5 está liberada na conta de build (896328489567) mas
    // ainda NEGADA no Bedrock Model Access da conta de PROD (820198199720) — selecionáveis já,
    // mas em prod caem na cascata CLAUDE_MODEL_FALLBACK até o grant ser concedido. Haiku 4.5 e
    // Sonnet 4.6 funcionam em prod hoje. Se novos modelos forem liberados, adicionar após teste real.
    label: "AWS Bedrock", icon: "☁️",
    models: [
      "us.anthropic.claude-opus-5",
      "us.anthropic.claude-sonnet-5",
      "us.anthropic.claude-fable-5",
      "us.anthropic.claude-fable-5-1",
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-opus-4-7",
      "us.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    ],
    fields: [
      { key: "aws_access_key_id",     label: "AWS Access Key ID",     placeholder: "AKIA...",     secret: false },
      { key: "aws_secret_access_key", label: "AWS Secret Access Key", placeholder: "wJalrXUt...", secret: true  },
      { key: "aws_region",            label: "AWS Region",            placeholder: "us-east-1",   secret: false },
    ],
  },
  foundry: {
    // Azure AI Foundry servindo CLAUDE (SDK anthropic nativo apontando para
    // <resource>.cognitiveservices.azure.com/anthropic). NÃO confundir com "Azure OpenAI",
    // que é outro slot e só serve GPT. IDs são BARE — o Foundry rejeita o prefixo
    // `us.anthropic.` do Bedrock. Deployments confirmados no recurso jeanolbar-4097-resource.
    label: "Azure AI Foundry (Claude)", icon: "⚡",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    fields: [
      { key: "foundry_api_key",  label: "API Key",                                 placeholder: "…",                       secret: true  },
      { key: "foundry_resource", label: "Recurso Foundry",                         placeholder: "jeanolbar-4097-resource", secret: false },
      { key: "foundry_base_url", label: "Base URL (opcional, sobrepõe o recurso)", placeholder: "https://<recurso>.cognitiveservices.azure.com/anthropic", secret: false },
    ],
  },
  google: {
    // ÚNICO slot de família NÃO-Claude. É o que viabiliza um revisor cross-family: a pesquisa
    // (arXiv:2609.04270) mede ZERO ganho em auto-revisão da MESMA família (35% de falso-rejeite)
    // contra +12 p.p. e 2% com revisor de OUTRA família. Consumido pelo endpoint
    // OpenAI-compatível do Google — por isso não exige SDK novo no container.
    // O crédito do Google cobre o **Vertex AI**, cujo Model Garden REVENDE outras famílias
    // (Claude, Llama, Mistral) além do Gemini nativo.
    // ⚠️ Os ids abaixo NÃO foram validados por invocação real (não há credencial Google
    // nesta máquina). Os do Model Garden exigem o sufixo de versão exato publicado na SUA
    // conta (`gcloud ai models list`) — confirme antes de promover um slot Google a Padrão.
    label: "Google (Vertex AI)", icon: "🔶",
    models: [
      // Gemini nativo (funciona nos dois modos de credencial)
      "gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-pro", "gemini-3-flash",
      // Model Garden — famílias de TERCEIROS pagas pelo crédito Google (exigem modo Vertex).
      // Claude no Vertex usa `nome@AAAAMMDD` e roda pelo cliente AnthropicVertex.
      "claude-sonnet-4-5@20250929", "claude-opus-4-1@20250805", "claude-haiku-4-5@20251001",
      // Llama e Mistral no Vertex são MaaS e falam o endpoint OpenAI-compatível.
      "meta/llama-3.3-70b-instruct-maas", "mistral-large-2411",
    ],
    fields: [
      { key: "google_api_key",  label: "API Key da Gemini API", placeholder: "AIza…", secret: true  },
      { key: "vertex_project_id", label: "Projeto GCP (modo Vertex — obrigatório p/ Model Garden)", placeholder: "meu-projeto-gcp", secret: false },
      { key: "vertex_location",   label: "Região do Vertex (padrão us-east5)", placeholder: "us-east5", secret: false },
      { key: "vertex_service_account_json", label: "Service Account JSON (modo Vertex)", placeholder: '{"type":"service_account",...}', secret: true },
      { key: "google_base_url", label: "Base URL (opcional — sobrepõe a base calculada)", placeholder: "https://generativelanguage.googleapis.com/v1beta/openai/", secret: false },
    ],
  },
  openai: {
    label: "OpenAI (GPT)", icon: "🤖",
    models: ["gpt-5.5-high","gpt-5.5-high-fast","gpt-5.4-high","gpt-5.4-high-fast","gpt-4o","gpt-4o-mini","gpt-4-turbo","o1","o3-mini"],
    fields: [
      { key: "api_key", label: "API Key", placeholder: "sk-proj-...", secret: true },
    ],
  },
  anthropic: {
    label: "Anthropic (API Direta)", icon: "🧠",
    models: ["claude-opus-5","claude-sonnet-5","claude-fable-5","claude-opus-4-7","claude-sonnet-4-6","claude-haiku-4-5-20251001","claude-3-5-sonnet-20241022","claude-3-opus-20240229"],
    fields: [
      { key: "api_key", label: "API Key (sk-ant-...)", placeholder: "sk-ant-...", secret: true },
    ],
  },
  azure_openai: {
    label: "Azure OpenAI", icon: "🔷",
    models: ["gpt-4o","gpt-4.1","gpt-4-turbo","gpt-35-turbo"],
    fields: [
      { key: "api_key",         label: "API Key",          placeholder: "...",                          secret: true  },
      { key: "endpoint",        label: "Endpoint",         placeholder: "https://xxx.openai.azure.com", secret: false },
      { key: "deployment_name", label: "Deployment Name",  placeholder: "my-gpt4o",                     secret: false },
      { key: "api_version",     label: "API Version",      placeholder: "2024-02-01",                   secret: false },
    ],
  },
};

export const PROVIDERS = Object.keys(PROVIDER_META) as Provider[];

const MODEL_PROVIDER_MAP: Record<string, Provider> = {
  "us.anthropic.claude-opus-5":               "bedrock",
  "us.anthropic.claude-sonnet-5":             "bedrock",
  "us.anthropic.claude-fable-5":              "bedrock",
  "us.anthropic.claude-fable-5-1":            "bedrock",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": "bedrock",
  "us.anthropic.claude-sonnet-4-6":           "bedrock",
  "us.anthropic.claude-opus-4-7":             "bedrock",
  "us.anthropic.claude-opus-4-8":             "bedrock",
  "claude-opus-5":                            "anthropic",
  "claude-sonnet-5":                          "anthropic",
  "claude-fable-5":                           "anthropic",
  "claude-opus-4-7":                          "anthropic",
  "claude-sonnet-4-6":                        "anthropic",
  "claude-haiku-4-5-20251001":                "anthropic",
  "claude-3-5-sonnet-20241022":               "anthropic",
  "claude-3-opus-20240229":                   "anthropic",
  "gemini-2.5-pro": "google", "gemini-2.5-flash": "google",
  "gemini-3-pro": "google", "gemini-3-flash": "google",
  // Model Garden: id com `@versão` ou prefixo de vendor só existe no Vertex ⇒ provider google.
  "claude-sonnet-4-5@20250929": "google", "claude-opus-4-1@20250805": "google",
  "claude-haiku-4-5@20251001": "google",
  "meta/llama-3.3-70b-instruct-maas": "google", "mistral-large-2411": "google",
  "gpt-4o": "openai", "gpt-4o-mini": "openai", "gpt-4-turbo": "openai",
  "gpt-5.5-high": "openai", "gpt-5.5-high-fast": "openai",
  "gpt-5.4-high": "openai", "gpt-5.4-high-fast": "openai",
  "o1": "openai", "o3-mini": "openai",
};

export function resolveProvider(modelId: string, tabProvider: Provider): Provider {
  // O modelo escolhido DENTRO de uma aba pertence àquela aba. Os ids BARE (`claude-opus-5`)
  // existem no Foundry E na API direta da Anthropic — deixar o mapa decidir sequestraria a
  // escolha do operador (Foundry viraria "anthropic" em silêncio, com credencial errada).
  if (PROVIDER_META[tabProvider]?.models.includes(modelId)) return tabProvider;
  return MODEL_PROVIDER_MAP[modelId] ?? tabProvider;
}

// ── Labels / cores por posição ────────────────────────────────────────────────

export const SLOT_LABEL = (idx: number) =>
  idx === 0 ? "Padrão" : `Contingência ${idx}`;

export const SLOT_COLOR = (idx: number) => {
  const COLORS = ["#6366F1", "#10B981", "#F59E0B", "#EF4444"];
  return COLORS[idx] ?? "#6366F1";
};

// ── Modal de cadastro / edição ────────────────────────────────────────────────

export interface GlobalLimits { maxConc: number; quota: string; dpRes: number }

export interface LlmSlotEditorProps {
  open: boolean;
  slot: LlmSlot | null;          // null = novo
  priority: number;              // posição onde será inserido
  /** Base REST: `/api/tenant/llm-config` (tenant) ou `/api/management/llm-config` (gestão). */
  endpoint: string;
  /** Tenant selecionado no topo (master); null/undefined = escopo do próprio JWT ou gestão. */
  tenantId?: string | null;
  /** Cyborg e limites só existem no slot de TENANT — a conta de gestão não roda fábrica. */
  showCyborg?: boolean;
  globalLimits?: GlobalLimits;
  onLimitsChange?: (v: GlobalLimits) => void;
  /** Campo livre de rótulo (a gestão usa para dizer a que serve o slot). */
  showLabel?: boolean;
  onClose: () => void;
  /** Recebe o veredicto do teste feito no ato do salvamento (quando o servidor conseguiu testar). */
  onSaved: (verify?: VerifyResult) => void;
}

export function LlmSlotEditor({
  open, slot, priority, endpoint, tenantId = null,
  showCyborg = false, globalLimits, onLimitsChange, showLabel = false,
  onClose, onSaved,
}: LlmSlotEditorProps) {
  const initialProvider = (slot?.provider as Provider) ?? "bedrock";
  const [tab, setTab]           = useState(PROVIDERS.indexOf(initialProvider));
  const [modelId, setModelId]   = useState(slot?.model_id ?? "");
  const [fallbackId, setFallbackId] = useState(slot?.model_id_fallback ?? "");
  const [cyborgId, setCyborgId] = useState(slot?.cyborg_model_id ?? "");
  const [cyborgFallbackId, setCyborgFallbackId] = useState(slot?.cyborg_model_id_fallback ?? "");
  const [label, setLabel]       = useState(slot?.label ?? "");
  const [creds, setCreds]       = useState<Record<string, string>>({});
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState<string | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [catalog, setCatalog]   = useState<ModelCatalog | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [showUnusable, setShowUnusable]   = useState(false);

  // Sincronizar tab quando o slot muda (edição de slot existente)
  useEffect(() => {
    if (open) {
      const p = (slot?.provider as Provider) ?? "bedrock";
      setTab(PROVIDERS.indexOf(p));
      setModelId(slot?.model_id ?? "");
      setFallbackId(slot?.model_id_fallback ?? "");
      setCyborgId(slot?.cyborg_model_id ?? "");
      setCyborgFallbackId(slot?.cyborg_model_id_fallback ?? "");
      setLabel(slot?.label ?? "");
      setCreds({});
      setErr(null);
      setCatalog(null);
      setShowUnusable(false);
    }
  }, [open, slot]);

  // Reset model ao trocar provider. Fica VAZIO de propósito: quem escolhe o primeiro é o catálogo
  // verificado (abaixo) — chutar `meta.models[0]` aqui já ofereceu modelo sem entitlement.
  useEffect(() => {
    setModelId("");
    setFallbackId("");
    setCyborgId("");
    setCyborgFallbackId("");
    setCreds({});
    setCatalog(null);
    setShowUnusable(false);
  }, [tab]);

  const provider = PROVIDERS[tab] as Provider;
  const meta     = PROVIDER_META[provider];

  /**
   * Busca a lista de modelos do PROVIDER com a credencial em tela e testa cada um por invocação
   * real (decisão do Jean: *"verificar todos ao abrir a tela"*). O servidor paraleliza e cacheia por
   * 15 min, então reabrir o diálogo é barato; `refresh` fura o cache.
   * Nunca lança: sem resposta o select cai no catálogo local — indisponibilidade nossa não pode
   * impedir a configuração do slot.
   */
  const carregarModelos = useCallback(async (refresh: boolean) => {
    setLoadingModels(true);
    try {
      const r = await apiPost<Partial<ModelCatalog> & { unavailable?: boolean }>(
        withQuery(`${endpoint}/models`, { tenantId }),
        { provider, priority, credentials: creds, refresh },
      );
      setCatalog(r && !r.unavailable && Array.isArray(r.models) ? (r as ModelCatalog) : null);
    } catch {
      setCatalog(null);
    } finally {
      setLoadingModels(false);
    }
  }, [endpoint, provider, priority, tenantId, creds]);

  // Debounce: o operador ainda está digitando a chave; verificar a cada tecla queimaria invocações.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => { void carregarModelos(false); }, 700);
    return () => clearTimeout(t);
  }, [open, carregarModelos]);

  const verificados = catalog?.models ?? [];
  // `config` = o servidor listou mas NÃO invocou (slot ainda sem credencial própria). Não é
  // reprovação: esconder esses ids deixaria o select vazio antes de o operador digitar a chave.
  const utilizaveis = verificados.filter((m) => m.ok || m.kind === "config");
  const reprovados  = verificados.filter((m) => !m.ok && m.kind !== "config");
  const semCredencial = !!catalog && catalog.usable === 0 && utilizaveis.length > 0;
  // Sem catálogo do servidor a tela continua funcionando com a lista local.
  const base: string[] = catalog
    ? (showUnusable ? [...utilizaveis, ...reprovados] : utilizaveis).map((m) => m.id)
    : meta.models;
  // Um valor JÁ SALVO nunca some da lista: sumir faria o Select cair em "out-of-range" e o próximo
  // save gravaria outro modelo sem o operador pedir.
  const opcoes = [...base];
  for (const v of [slot?.model_id, modelId, fallbackId, cyborgId, cyborgFallbackId]) {
    if (v && !opcoes.includes(v)) opcoes.push(v);
  }
  const infoDe   = (id: string) => verificados.find((m) => m.id === id);
  const padrao   = modelId || utilizaveis[0]?.id || opcoes[0] || "";
  const infoPadrao = infoDe(padrao);
  const padraoReprovado = infoPadrao && !infoPadrao.ok && infoPadrao.kind !== "config"
    ? infoPadrao : null;

  const itemModelo = (m: string) => {
    const info = infoDe(m);
    return (
      <MenuItem key={m} value={m} sx={{ fontSize: "0.8rem" }}
        disabled={!!info && !info.ok && info.kind !== "config"}>
        {m}
        {info && !info.ok && (
          <Typography component="span" variant="caption" sx={{ ml: 1, color: "text.disabled" }}>
            — {info.kind === "config" ? "não verificado" : (info.kind || "indisponível")}
          </Typography>
        )}
      </MenuItem>
    );
  };

  const handleSave = async () => {
    if (!padrao) { setErr("Escolha um modelo principal."); return; }
    setSaving(true); setErr(null);
    try {
      const selected         = padrao;
      const resolvedProvider = resolveProvider(selected, provider);
      // O PUT TESTA o slot antes de responder (chamada real, mínima) — daí ele poder demorar alguns
      // segundos. É o preço de descobrir a credencial errada aqui, e não no meio de um run.
      const resp = await apiPut<{ verify?: VerifyResult }>(withQuery(`${endpoint}/${priority}`, { tenantId }), {
        provider:                resolvedProvider,
        model_id:                selected,
        model_id_fallback:       fallbackId || null,
        ...(showLabel ? { label: label || null } : {}),
        ...(showCyborg ? {
          cyborg_model_id:          cyborgId || null,
          cyborg_model_id_fallback: cyborgFallbackId || null,
        } : {}),
        credentials:             creds,
        ...(globalLimits ? {
          max_concurrent_projects: globalLimits.maxConc,
          daily_token_quota:       globalLimits.quota ? Number(globalLimits.quota) : null,
          deadpool_token_reserve:  globalLimits.dpRes,
        } : {}),
      });
      onSaved(resp?.verify);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally { setSaving(false); }
  };

  const isEdit = slot?.configured && slot.has_credentials;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth
      PaperProps={{ sx: { bgcolor: "background.paper" } }}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <PsychologyIcon sx={{ color: "primary.main" }} />
          <Typography fontWeight={700}>
            {isEdit ? `Editar — ${SLOT_LABEL(priority)}` : "Adicionar LLM"}
          </Typography>
          <Chip label={SLOT_LABEL(priority)} size="small"
            sx={{ bgcolor: SLOT_COLOR(priority) + "22", color: SLOT_COLOR(priority), fontWeight: 700, ml: 0.5 }} />
        </Stack>
      </DialogTitle>

      <DialogContent sx={{ pt: "8px !important" }}>
        {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr(null)}>{err}</Alert>}

        {/* Tabs de provider */}
        <Tabs value={tab} onChange={(_e, v) => setTab(v as number)}
          sx={{ mb: 2.5, borderBottom: "1px solid", borderColor: "divider", minHeight: 36 }}
          variant="scrollable" scrollButtons="auto">
          {PROVIDERS.map((p, i) => (
            <Tab key={p} value={i}
              label={
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <span style={{ fontSize: "0.9rem" }}>{PROVIDER_META[p].icon}</span>
                  <span style={{ fontSize: "0.72rem" }}>{PROVIDER_META[p].label}</span>
                </Stack>
              }
              sx={{ textTransform: "none", minHeight: 36, py: 0.5 }}
            />
          ))}
        </Tabs>

        {/* Credenciais */}
        <Stack spacing={1.5} sx={{ mb: 2 }}>
          {meta.fields.map((f) => (
            <TextField key={f.key}
              label={f.label}
              placeholder={
                isEdit && slot?.provider === provider && slot.credentials_masked[f.key]
                  ? slot.credentials_masked[f.key]
                  : f.placeholder
              }
              type={f.secret ? "password" : "text"}
              size="small"
              value={creds[f.key] ?? ""}
              onChange={(e) => setCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
              helperText={
                isEdit && slot?.provider === provider && slot.credentials_masked[f.key]
                  ? "Deixe em branco para manter o valor salvo"
                  : undefined
              }
              fullWidth
            />
          ))}
          {showLabel && (
            <TextField label="Rótulo (opcional)" placeholder="ex.: agente interno de operações"
              size="small" value={label} onChange={(e) => setLabel(e.target.value)} fullWidth />
          )}
        </Stack>

        {/* Catálogo dinâmico — de onde veio a lista e quantos passaram no teste real */}
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          {loadingModels && <CircularProgress size={13} />}
          <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
            {loadingModels
              ? "Verificando os modelos com a credencial informada…"
              : !catalog
                ? "Catálogo local — não foi possível consultar o provider agora"
                : semCredencial
                  ? `${catalog.total} modelos listados · nenhum verificado (slot sem credencial própria)`
                  : `${catalog.usable} de ${catalog.total} utilizáveis · ${
                      catalog.source === "provider"
                        ? "listados pelo provider e testados por invocação real"
                        : "catálogo local (o provider não lista), testados por invocação real"
                    }${catalog.cached ? " · cache" : ""}`}
          </Typography>
          {reprovados.length > 0 && (
            <Button size="small" sx={{ fontSize: "0.68rem", minWidth: 0 }}
              onClick={() => setShowUnusable((v) => !v)}>
              {showUnusable ? "ocultar reprovados" : `ver ${reprovados.length} reprovados`}
            </Button>
          )}
          <Button size="small" disabled={loadingModels} sx={{ fontSize: "0.68rem", minWidth: 0 }}
            onClick={() => void carregarModelos(true)}>
            reverificar
          </Button>
        </Stack>
        {catalog?.warning && (
          <Alert severity="info" icon={false} sx={{ mb: 1.5, py: 0.25, fontSize: "0.72rem" }}>
            {catalog.warning}
          </Alert>
        )}
        {padraoReprovado && (
          <Alert severity="warning" sx={{ mb: 1.5, py: 0.25, fontSize: "0.72rem" }}>
            <strong>{padrao}</strong> não respondeu com esta credencial ({padraoReprovado.kind}):{" "}
            {padraoReprovado.message}
          </Alert>
        )}

        {/* Modelo principal + Fallback */}
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mb: 2 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>Modelo principal</InputLabel>
            <Select value={padrao} label="Modelo principal" renderValue={(v) => String(v)}
              onChange={(e) => setModelId(e.target.value)}>
              {opcoes.map(itemModelo)}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>Fallback (rework / QA)</InputLabel>
            <Select value={fallbackId} label="Fallback (rework / QA)" renderValue={(v) => String(v)}
              onChange={(e) => setFallbackId(e.target.value)}>
              <MenuItem value="" sx={{ fontSize: "0.8rem", color: "text.disabled" }}>
                — Nenhum —
              </MenuItem>
              {opcoes.map(itemModelo)}
            </Select>
          </FormControl>
        </Stack>
        {fallbackId && showCyborg && (
          <Alert severity="info" icon={false} sx={{ mb: 2, py: 0.5, fontSize: "0.75rem" }}>
            Dev/QA usam <strong>{padrao}</strong> no 1º intento.
            No rework (QA_FAIL ≥ 1) ou quando Dev escalou, <strong>{fallbackId}</strong> é chamado automaticamente.
          </Alert>
        )}

        {/* Cyborg — modelo dedicado para lapidação e entrega final (só no slot de tenant) */}
        {showCyborg && (
          <Box sx={{ border: "1px solid", borderColor: "warning.main", borderRadius: 1, p: 1.5, mb: 2, bgcolor: "warning.main", color: "warning.contrastText" }}>
            <Typography variant="caption" sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, display: "block", mb: 1 }}>
              🤖 Cyborg — Lapidação e Entrega (etapa final crítica)
            </Typography>
            <Typography variant="caption" sx={{ display: "block", mb: 1.5, opacity: 0.9 }}>
              O Cyborg audita o produto entregue pelo squad, corrige gaps residuais e publica no S3.
              Use o modelo mais capaz disponível — é a etapa mais importante do pipeline.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
              <FormControl size="small" fullWidth sx={{ bgcolor: "background.paper", borderRadius: 1 }}>
                <InputLabel>Cyborg principal</InputLabel>
                <Select value={cyborgId} label="Cyborg principal" renderValue={(v) => String(v)}
                  onChange={(e) => setCyborgId(e.target.value)}>
                  <MenuItem value="" sx={{ fontSize: "0.8rem", color: "text.disabled" }}>
                    — Usar padrão Zentriz —
                  </MenuItem>
                  {opcoes.map(itemModelo)}
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth sx={{ bgcolor: "background.paper", borderRadius: 1 }}>
                <InputLabel>Cyborg fallback</InputLabel>
                <Select value={cyborgFallbackId} label="Cyborg fallback" renderValue={(v) => String(v)}
                  onChange={(e) => setCyborgFallbackId(e.target.value)}>
                  <MenuItem value="" sx={{ fontSize: "0.8rem", color: "text.disabled" }}>
                    — Nenhum —
                  </MenuItem>
                  {opcoes.map(itemModelo)}
                </Select>
              </FormControl>
            </Stack>
          </Box>
        )}

        {/* Limites globais — expansível (só no slot de tenant) */}
        {globalLimits && onLimitsChange && (
          <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
            <Box
              onClick={() => setLimitsOpen((v) => !v)}
              sx={{ px: 2, py: 1, display: "flex", alignItems: "center", cursor: "pointer",
                bgcolor: "action.hover", "&:hover": { bgcolor: "action.selected" } }}>
              <Typography variant="caption" sx={{ textTransform: "uppercase", letterSpacing: "0.08em", flexGrow: 1 }}>
                Limites globais
              </Typography>
              <Typography variant="caption" color="text.secondary">{limitsOpen ? "▲" : "▼"}</Typography>
            </Box>
            {limitsOpen && (
              <Box sx={{ px: 2, pb: 2, pt: 1.5 }}>
                <Stack spacing={2}>
                  <Box>
                    <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                      <Typography variant="body2">Projetos simultâneos máx.</Typography>
                      <Typography variant="body2" fontWeight={700} color="primary.main">{globalLimits.maxConc}</Typography>
                    </Stack>
                    <Slider value={globalLimits.maxConc}
                      onChange={(_e, v) => onLimitsChange({ ...globalLimits, maxConc: v as number })}
                      min={1} max={20} step={1}
                      marks={[{ value: 1, label: "1" }, { value: 10 }, { value: 20, label: "20" }]}
                      sx={{ color: "primary.main" }} />
                  </Box>
                  <TextField label="Quota diária de tokens (opcional)" placeholder="ex: 1000000"
                    size="small" type="number" value={globalLimits.quota}
                    onChange={(e) => onLimitsChange({ ...globalLimits, quota: e.target.value })}
                    helperText="Vazio = sem limite." fullWidth />
                  <Box>
                    <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Typography variant="body2">Reserva Auto Care</Typography>
                        <Tooltip title="Tokens reservados para o Auto Care.">
                          <InfoOutlinedIcon sx={{ fontSize: "0.85rem", color: "text.secondary" }} />
                        </Tooltip>
                      </Stack>
                      <Typography variant="body2" fontWeight={700} color="secondary.main">
                        {globalLimits.dpRes > 0 ? `${(globalLimits.dpRes / 1000).toFixed(0)}k` : "0"}
                      </Typography>
                    </Stack>
                    <Slider value={globalLimits.dpRes}
                      onChange={(_e, v) => onLimitsChange({ ...globalLimits, dpRes: v as number })}
                      min={0} max={500000} step={10000}
                      marks={[{ value: 0, label: "0" }, { value: 250000, label: "250k" }, { value: 500000, label: "500k" }]}
                      sx={{ color: "secondary.main" }} />
                  </Box>
                </Stack>
              </Box>
            )}
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button variant="outlined" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}>
          {saving ? "Salvando e testando…" : "Salvar e testar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Card de um LLM configurado ────────────────────────────────────────────────

export interface LlmSlotCardProps {
  slot: LlmSlot;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  deleting: boolean;
  testing: boolean;
  /**
   * Na conta de GESTÃO rodar na conta da Zentriz é o desenho, não um defeito — a mesma frase que
   * alerta o tenant ("o consumo é faturado para a Zentriz") ali seria um erro de leitura.
   */
  zentrizIsPayer?: boolean;
}

export function LlmSlotCard({
  slot, index, total, onMoveUp, onMoveDown, onEdit, onDelete, onTest,
  deleting, testing, zentrizIsPayer = false,
}: LlmSlotCardProps) {
  const color = SLOT_COLOR(index);
  const meta  = PROVIDER_META[slot.provider!];
  const status = slot.verify_status ?? null;

  return (
    <Card variant="outlined" sx={{ borderColor: color + "55", borderLeft: `4px solid ${color}` }}>
      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
          {/* Badge de posição */}
          <Chip label={SLOT_LABEL(index)} size="small"
            sx={{ bgcolor: color + "20", color, fontWeight: 700, border: `1px solid ${color}44`, minWidth: 100 }} />

          {/* Info do provider */}
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography sx={{ fontSize: "1rem" }}>{meta?.icon}</Typography>
              <Typography variant="body2" fontWeight={600} noWrap>{meta?.label}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ fontFamily: "monospace" }}>
                {slot.model_id}
                {slot.model_id_fallback && (
                  <> <span style={{ opacity: 0.5 }}>→</span> {slot.model_id_fallback}</>
                )}
              </Typography>
              {slot.label && (
                <Chip size="small" variant="outlined" label={slot.label}
                  sx={{ height: 18, fontSize: "0.65rem" }} />
              )}
              {slot.cyborg_model_id && (
                <Typography variant="caption" sx={{ display: "block", fontFamily: "monospace", color: "warning.main", fontSize: "0.68rem" }}>
                  🤖 Cyborg: {slot.cyborg_model_id}
                  {slot.cyborg_model_id_fallback && (
                    <> <span style={{ opacity: 0.5 }}>→</span> {slot.cyborg_model_id_fallback}</>
                  )}
                </Typography>
              )}
            </Stack>
            {/* ⚖️ LEI 2026-09-10 — o rótulo diz de QUEM é a fatura, não só "tem credencial".
                Um slot com provider e modelo certos rodando na chave do servidor continua
                faturando na Zentriz: era exatamente esse caso que a tela chamava, em verde,
                de "Credenciais configuradas". */}
            {slot.own_credentials ? (
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }}>
                <CheckCircleIcon sx={{ fontSize: "0.75rem", color: "success.main" }} />
                <Typography variant="caption" color="success.main">
                  {zentrizIsPayer
                    ? "Credencial própria da conta de gestão — a Zentriz paga este consumo"
                    : "Credenciais próprias — o consumo é faturado na sua conta"}
                </Typography>
              </Stack>
            ) : slot.uses_zentriz_account && !zentrizIsPayer ? (
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }}>
                <WarningAmberIcon sx={{ fontSize: "0.75rem", color: "warning.main" }} />
                <Typography variant="caption" color="warning.main">
                  Usando a conta da Zentriz — o consumo deste slot é faturado para a Zentriz.
                  Cadastre credenciais próprias para que o custo seja seu.
                </Typography>
              </Stack>
            ) : (
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }}>
                <WarningAmberIcon sx={{ fontSize: "0.75rem", color: "error.main" }} />
                <Typography variant="caption" color="error.main">
                  Sem credenciais — este slot não roda
                </Typography>
              </Stack>
            )}

            {/* ⚖️ Jean, 2026-09-10 — o veredicto da última CHAMADA REAL. Um slot pode ter todas as
                credenciais preenchidas (linha acima, verde) e ainda assim ser recusado pelo
                provider: chave rotacionada, modelo sem entitlement, cota estourada. Enquanto isso
                não aparecia aqui, o único jeito de descobrir era queimar um run. */}
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }} flexWrap="wrap" useFlexGap>
              {status === "ok" ? (
                <Tooltip title={`Testado com ${slot.verify_model ?? slot.model_id}${
                  slot.verify_latency_ms ? ` · ${slot.verify_latency_ms} ms` : ""}`}>
                  <Chip size="small" icon={<CheckCircleIcon />} label={VERIFY_LABEL.ok}
                    sx={{ height: 20, fontSize: "0.65rem", bgcolor: "success.main", color: "success.contrastText",
                          "& .MuiChip-icon": { fontSize: "0.8rem", color: "inherit" } }} />
                </Tooltip>
              ) : status ? (
                <Tooltip title={slot.verify_error || "Falhou no último teste"}>
                  <Chip size="small" icon={<WarningAmberIcon />}
                    label={VERIFY_LABEL[status] ?? VERIFY_LABEL.other}
                    sx={{ height: 20, fontSize: "0.65rem", bgcolor: "error.main", color: "error.contrastText",
                          "& .MuiChip-icon": { fontSize: "0.8rem", color: "inherit" } }} />
                </Tooltip>
              ) : (
                <Chip size="small" variant="outlined" label="Nunca testado"
                  sx={{ height: 20, fontSize: "0.65rem", color: "text.secondary" }} />
              )}
              {status && status !== "ok" && (
                <Typography variant="caption" color="text.secondary">
                  {zentrizIsPayer
                    ? "Os agentes internos pulam este slot e usam a próxima contingência."
                    : "A Bancada pula este slot e usa a próxima contingência."}
                </Typography>
              )}
            </Stack>
          </Box>

          {/* Ações */}
          <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
            <Tooltip title="Mover para cima (aumentar prioridade)">
              <span>
                <IconButton size="small" onClick={onMoveUp} disabled={index === 0}>
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Mover para baixo (diminuir prioridade)">
              <span>
                <IconButton size="small" onClick={onMoveDown} disabled={index === total - 1}>
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Testar agora (faz uma chamada real e mínima ao provider)">
              <span>
                <IconButton size="small" onClick={onTest} disabled={testing}>
                  {testing ? <CircularProgress size={14} /> : <PlayArrowIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Editar credenciais / modelo">
              <IconButton size="small" onClick={onEdit}>
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Remover">
              <IconButton size="small" color="error" onClick={onDelete} disabled={deleting}>
                {deleting ? <CircularProgress size={14} /> : <DeleteIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
