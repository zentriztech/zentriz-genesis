/**
 * tenantLlmConfig.ts — G38: Resolve configuração de LLM por tenant com prioridade.
 *
 * Cada tenant pode ter até 4 configs LLM (priority 0-3: Padrão + 3 Contingências).
 * O runner tenta em ordem crescente de prioridade; pula configs sem credenciais válidas.
 *
 * priority 0 = Padrão       (sempre tentado primeiro)
 * priority 1 = Contingência 1
 * priority 2 = Contingência 2
 * priority 3 = Contingência 3
 */

import { pool } from "../db/client.js";
import { pickReviewerModel, strongestByDomination } from "./reviewerModel.js";

export interface TenantLlmConfig {
  provider: string;
  modelId: string;
  modelIdFallback: string | null;
  credentials: Record<string, string>;
  maxConcurrentProjects: number;
  dailyTokenQuota: number | null;
  deadpoolTokenReserve: number;
  isDefault: boolean;
  priority: number;
  /**
   * `tenants.byoc_exempt` — o tenant está autorizado a rodar na conta da ZENTRIZ.
   * Escrito SÓ por `zentriz_admin` (`routes/tenants.ts` `app.patch("/api/tenants/:id")` →
   * `requireZentrizAdmin`): um tenant não consegue se auto-isentar e empurrar a fatura para nós.
   */
  byocExempt: boolean;
}

export interface ResolvedLlmConfig {
  provider:            string;
  modelId:             string;
  fallbackModelId?:    string;   // modelo para rework/QA-escalation
  apiKey:              string;
  awsRegion?:          string;
  awsAccessKeyId?:     string;
  awsSecretAccessKey?: string;
  /** provider=foundry (BYOC): credencial própria do tenant; ausente ⇒ usa a do container. */
  foundryApiKey?:      string;
  foundryResource?:    string;
  foundryBaseUrl?:     string;
  /** provider=google (Gemini via endpoint OpenAI-compatível); mesma regra de BYOC. */
  googleApiKey?:       string;
  googleBaseUrl?:      string;
  /** modo Vertex: cobre as famílias subsidiadas pelo crédito do Google (Model Garden). */
  vertexProjectId?:    string;
  vertexLocation?:     string;
  vertexServiceAccountJson?: string;
  /** provider=azure_openai: a chamada é endereçada pelo DEPLOYMENT, não pelo nome do modelo. */
  azureEndpoint?:      string;
  azureDeployment?:    string;
  azureApiVersion?:    string;
  isDefault:           boolean;
  priority:            number;
  /**
   * COMO este slot foi escolhido. Só é preenchido quando a estratégia não é a padrão (`priority`),
   * porque quem lê precisa poder AUDITAR a escolha: com `strongest`, o slot que roda pode não ser o
   * de prioridade 0 — e, como cada slot tem credencial própria, mudou também qual delas paga.
   */
  selection?: {
    strategy: LlmSelectionStrategy;
    why: string;
    /** Ids dos slots utilizáveis do tenant, em ordem de prioridade. Sem credencial nenhuma. */
    slotModels: string[];
  };
}

/**
 * `priority` — o 1º slot utilizável na ordem do tenant (Bancada e Fábrica).
 * `strongest` — o modelo mais forte entre os slots (Cyborg; regra do Jean 2026-09-10).
 */
export type LlmSelectionStrategy = "priority" | "strongest";

/**
 * ⚖️ LEI (Jean, 2026-09-10): provider, modelo **e credencial** saem do slot do tenant — nunca do
 * `.env`, nunca de literal no código. O motivo é financeiro, não estético: *"para que os custos de
 * LLM sejam do Tenant, não da Zentriz"*.
 *
 * Por isso NÃO existe mais um `SYSTEM_DEFAULT` de provider/modelo. O único default que sobrou é o de
 * concorrência, que não gasta token de ninguém.
 */
const DEFAULT_MAX_CONCURRENT_PROJECTS = 3;

/**
 * Nenhum slot utilizável. É erro de CONFIGURAÇÃO, não falha de sistema: quem recebe precisa saber
 * o que fazer, e a chamada NÃO pode degradar para a conta da Zentriz (era esse o vazamento).
 */
export class LlmSlotNotConfiguredError extends Error {
  readonly code = "LLM_SLOT_NOT_CONFIGURED";
  constructor(
    message = "Nenhum slot de LLM utilizável. Configure um provider com credenciais próprias em Configurações → LLM.",
  ) {
    super(message);
    this.name = "LlmSlotNotConfiguredError";
  }
}

/**
 * Credenciais que o **próprio slot** carrega — a única fonte que faz a chamada ser faturada no
 * tenant. Antes desta função, `bedrock` devolvia `true` incondicionalmente ("pode usar o env da
 * EC2") e `foundry`/`google` aceitavam a chave do container: medido em 2026-09-10, os dois slots da
 * ZFactory e os slots dos dois POCs apareciam como "credenciais configuradas" na tela enquanto
 * rodavam 100% na identidade da Zentriz.
 */
export function hasOwnCredentials(provider: string, creds: Record<string, string>): boolean {
  switch (provider) {
    case "bedrock":
      return !!(creds.aws_access_key_id && creds.aws_secret_access_key);
    case "foundry":
      return !!creds.foundry_api_key;
    case "google":
      // API Key da Gemini API basta para o Gemini nativo; o modo Vertex (Model Garden) precisa do
      // par projeto + service account — projeto sozinho não autentica nada.
      return !!(creds.google_api_key || (creds.vertex_project_id && creds.vertex_service_account_json));
    case "openai":
    case "anthropic":
      return !!creds.api_key;
    case "azure_openai":
      return !!(creds.api_key && creds.endpoint && creds.deployment_name);
    default:
      return false;
  }
}

/**
 * Existe credencial de INFRAESTRUTURA (identidade da Zentriz) capaz de servir este provider?
 * Só importa para tenant com `byoc_exempt` — para os demais a resposta é irrelevante, porque a
 * infraestrutura deixou de ser fonte legítima.
 *
 * `bedrock` é `true` porque a EC2 de prod usa **instance role**: não há chave em disco para checar,
 * e a ausência de variável não significa ausência de credencial.
 */
export function infraCanServe(provider: string): boolean {
  switch (provider) {
    case "bedrock":  return true;
    case "foundry":  return !!process.env.ANTHROPIC_FOUNDRY_API_KEY;
    case "google":   return !!(process.env.GOOGLE_API_KEY || process.env.GOOGLE_VERTEX_PROJECT);
    default:         return false;
  }
}

export interface SlotUsability {
  /** O slot pode ser usado para uma chamada real. */
  usable: boolean;
  /** O slot tem credencial PRÓPRIA ⇒ a fatura é do tenant. */
  ownCredentials: boolean;
  /** O slot roda na conta da Zentriz (só possível com `byoc_exempt`). A tela precisa DIZER isso. */
  usesZentrizAccount: boolean;
}

/**
 * Regra única de utilizabilidade de slot — usada pela resolução (o que roda) e pela tela (o que o
 * cliente lê). Manter as duas na MESMA função é o ponto: elas divergiram antes
 * (`routes/llm.ts` `hasCredentials` × `hasValidCredentials`) e o resultado foi um check verde
 * "Credenciais configuradas" sobre um slot sem credencial nenhuma.
 */
export function slotUsability(
  provider: string,
  creds: Record<string, string>,
  byocExempt: boolean,
): SlotUsability {
  const own = hasOwnCredentials(provider, creds);
  if (own) return { usable: true, ownCredentials: true, usesZentrizAccount: false };
  const infra = byocExempt && infraCanServe(provider);
  return { usable: infra, ownCredentials: false, usesZentrizAccount: infra };
}

/** Carrega todas as configs ativas de um tenant, ordenadas por prioridade. */
export async function getTenantLlmConfigs(tenantId: string): Promise<TenantLlmConfig[]> {
  try {
    const result = await pool.query(
      `SELECT c.provider, c.model_id, c.model_id_fallback, c.credentials, c.max_concurrent_projects,
              c.daily_token_quota, c.deadpool_token_reserve, c.priority, t.byoc_exempt
       FROM tenant_llm_configs c
       JOIN tenants t ON t.id = c.tenant_id
       WHERE c.tenant_id = $1 AND c.is_active = TRUE
       ORDER BY c.priority ASC`,
      [tenantId]
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      // `provider` e `model_id` são NOT NULL no schema; sem `??` de literal aqui, de propósito —
      // um default silencioso neste ponto é exatamente o que a LEI proíbe.
      provider:              String(row.provider ?? ""),
      modelId:               String(row.model_id ?? ""),
      modelIdFallback:       row.model_id_fallback ? String(row.model_id_fallback) : null,
      credentials:           (row.credentials as Record<string, string>) ?? {},
      maxConcurrentProjects: Number(row.max_concurrent_projects ?? DEFAULT_MAX_CONCURRENT_PROJECTS),
      dailyTokenQuota:       row.daily_token_quota != null ? Number(row.daily_token_quota) : null,
      deadpoolTokenReserve:  Number(row.deadpool_token_reserve ?? 0),
      isDefault:             false,
      priority:              Number(row.priority ?? 0),
      byocExempt:            !!row.byoc_exempt,
    }));
  } catch {
    return [];
  }
}

/**
 * Override de LLM para chamadas da BANCADA aos agents (spec-chat/Resolver GAPs, validador, splitter,
 * planner de evolução) — "a Bancada usa a mesma configuração da fábrica" (Jean, 2026-09-04).
 *
 * A fábrica resolve a config do tenant em `runner_server.py` (GET /api/internal/project-llm-config)
 * e injeta no env do run: CLAUDE_MODEL=model_id, CLAUDE_MODEL_REWORK=model_id_fallback, AWS_*=credenciais
 * do tenant (se houver; senão herda a identidade do container). Antes deste helper, TODA a Bancada
 * ignorava isso e usava o `CLAUDE_MODEL` do env dos agents com a identidade do host — em prod a conta
 * 820 não tem opus-4-8/fable → 403 → fallback silencioso para sonnet-4-6 (achado 2026-09-04).
 *
 * Contrato com os agents (server.py aceita em /invoke/raw, /invoke/cto/async, /invoke/product_architect/async,
 * /invoke/spec_validator/async): `model_id` (principal), `model_id_rework` (informativo) e `llm_config`
 * {provider, model, aws_access_key_id?, aws_secret_access_key?, aws_region?, api_key?} — mesmo shape
 * que o runner já manda no envelope (`runner.py` `_llm_config`). Credenciais viajam só container→container.
 */
export interface AgentsLlmOverride {
  model_id?: string;
  model_id_rework?: string;
  llm_config: Record<string, string>;
  /**
   * ⚖️ Jean, 2026-09-10: *"sempre testando se funciona e em caso de não funcionar testa o próximo"*.
   *
   * As CONTINGÊNCIAS do tenant, em envelope completo (provider + modelo + credencial de cada uma),
   * na ordem que ele cadastrou. O primeiro item é o slot escolhido — os agents (`_slot_cascade`)
   * só avançam quando a falha é do slot. Campo ADITIVO: quem não o manda continua com uma
   * tentativa só, exatamente como antes.
   *
   * Cada slot tem credencial PRÓPRIA: sem o envelope inteiro, cair para a contingência pediria o
   * modelo dela ao provider da primária — 400, ou pior, consumo na fatura errada.
   */
  llm_candidates?: Record<string, string>[];
  /** true quando nada foi resolvido (env default) — os agents usam o próprio env. */
  isDefault: boolean;
}

export function toAgentsOverride(cfg: ResolvedLlmConfig, contingencias: ResolvedLlmConfig[] = []): AgentsLlmOverride {
  if (cfg.isDefault) return { llm_config: {}, isDefault: true };
  // Nomes EXATOS que `_build_foundry_client`/`_build_google_client` procuram no envelope
  // (runtime.py): envelope > env. Só viajam se o tenant tiver credencial própria.
  const llm = credentialEnvelope(cfg);
  // A lista de candidatos começa NO PRÓPRIO slot escolhido: os agents deduplicam por
  // (modelo, provider), e mandar o escolhido junto deixa o envelope auto-contido — quem lê o corpo
  // vê a fila inteira que será tentada, na ordem em que será tentada.
  const candidatos = [cfg, ...contingencias]
    .filter((c) => c.modelId && c.provider)
    .map((c) => {
      const env = c === cfg ? llm : credentialEnvelope(c);
      return { ...env, ...(c.fallbackModelId ? { model_rework: c.fallbackModelId } : {}) };
    });
  return {
    model_id: cfg.modelId,
    ...(cfg.fallbackModelId ? { model_id_rework: cfg.fallbackModelId } : {}),
    llm_config: llm,
    ...(candidatos.length > 1 ? { llm_candidates: candidatos } : {}),
    isDefault: false,
  };
}

/**
 * Só as credenciais + provider + modelo de um slot, no shape que o Python procura no envelope.
 * Extraída de `toAgentsOverride` porque cada CONTINGÊNCIA precisa do MESMO envelope completo —
 * levar só o `model_id` da contingência sobre a credencial da primária é o defeito do "Grupo C".
 */
function credentialEnvelope(cfg: ResolvedLlmConfig): Record<string, string> {
  const llm: Record<string, string> = { provider: cfg.provider, model: cfg.modelId };
  if (cfg.awsAccessKeyId && cfg.awsSecretAccessKey) {
    llm.aws_access_key_id = cfg.awsAccessKeyId;
    llm.aws_secret_access_key = cfg.awsSecretAccessKey;
    if (cfg.awsRegion) llm.aws_region = cfg.awsRegion;
  }
  if (cfg.apiKey && cfg.provider !== "bedrock" && cfg.provider !== "foundry" && cfg.provider !== "google")
    llm.api_key = cfg.apiKey;
  if (cfg.foundryApiKey)   llm.foundry_api_key  = cfg.foundryApiKey;
  if (cfg.foundryResource) llm.foundry_resource = cfg.foundryResource;
  if (cfg.foundryBaseUrl)  llm.foundry_base_url = cfg.foundryBaseUrl;
  if (cfg.googleApiKey)  llm.google_api_key  = cfg.googleApiKey;
  if (cfg.googleBaseUrl) llm.google_base_url = cfg.googleBaseUrl;
  if (cfg.vertexProjectId) llm.vertex_project_id = cfg.vertexProjectId;
  if (cfg.vertexLocation)  llm.vertex_location  = cfg.vertexLocation;
  if (cfg.vertexServiceAccountJson) llm.vertex_service_account_json = cfg.vertexServiceAccountJson;
  if (cfg.azureEndpoint)    llm.azure_endpoint    = cfg.azureEndpoint;
  if (cfg.azureDeployment)  llm.azure_deployment  = cfg.azureDeployment;
  if (cfg.azureApiVersion)  llm.azure_api_version = cfg.azureApiVersion;
  return llm;
}

/**
 * Resolve o override para a Bancada. Prefere o PROJETO (mesma autoridade da fábrica: zentriz_admin →
 * config global; tenant → slot por prioridade); sem projeto, usa a config Padrão do tenant. NUNCA lança
 * (falha → default do env, igual ao comportamento anterior) e NUNCA loga credenciais.
 */
export async function resolveWorkbenchLlm(opts: { projectId?: string | null; tenantId?: string | null }): Promise<AgentsLlmOverride> {
  let projectErr: unknown = null;
  if (opts.projectId) {
    try {
      // A fila inteira: o 1º é o slot escolhido (comportamento de sempre), o resto são as
      // contingências que os agents tentam SÓ se o escolhido falhar por credencial/modelo/cota.
      const [escolhido, ...contingencias] = await resolveProjectLlmCandidates(opts.projectId);
      return toAgentsOverride(escolhido, contingencias);
    } catch (err) {
      // Guardado, não engolido: se o tenant também não resolver, este é o motivo mais específico.
      projectErr = err;
    }
  }
  if (opts.tenantId) {
    // "Bancada e Fábrica usam os slots na ORDEM cadastrada" (Jean, 2026-09-09) — 1º slot utilizável.
    const configs = await getTenantLlmConfigs(opts.tenantId);
    const usaveis = configs.filter(
      (c) => c.provider && c.modelId && slotUsability(c.provider, c.credentials, c.byocExempt).usable,
    );
    if (usaveis.length > 0) {
      const [primeiro, ...resto] = usaveis.map(toResolved);
      return toAgentsOverride(primeiro, resto);
    }
  }
  // ⚖️ LEI 2026-09-10: sem slot utilizável a chamada FALHA. Antes daqui saía
  // `{isDefault: true}`, que os agents traduziam para "usa o teu env" — ou seja, a conta da
  // Zentriz, em silêncio, exatamente o vazamento que a lei existe para fechar.
  if (projectErr instanceof LlmSlotNotConfiguredError) throw projectErr;
  throw new LlmSlotNotConfiguredError();
}

/** Primeiro slot utilizável na ordem de prioridade cadastrada pelo tenant. */
function pickUsableSlot(configs: TenantLlmConfig[]): TenantLlmConfig | null {
  for (const cfg of configs) {
    if (!cfg.provider || !cfg.modelId) continue; // slot incompleto não roda nada
    if (slotUsability(cfg.provider, cfg.credentials, cfg.byocExempt).usable) return cfg;
  }
  return null;
}

/**
 * O slot MAIS FORTE entre os utilizáveis — regra do Cyborg (Jean, 2026-09-10):
 * *"cyborg usa sempre o melhor modelo entre os cadastrados nos slots"*.
 *
 * Elimina quem é comprovadamente mais fraco que outro slot (`strongestByDomination`, que só usa a
 * relação medida) e, entre os que sobram — os incomparáveis, ex.: `claude-opus-5` × `gemini-3-pro` —,
 * respeita a ORDEM DO TENANT. Duas razões para o desempate ser a prioridade dele e não uma nota
 * nossa: (a) não há dado que ordene marcas diferentes; (b) trocar de slot troca de CREDENCIAL, ou
 * seja, de fatura — a escolha de qual conta paga tem de continuar sendo dele.
 *
 * ⚠️ Consequência desejada: se o tenant põe um `haiku` na prioridade 0 e um `opus` na 1, a Bancada
 * e a Fábrica seguem no haiku (ordem dele) e só o CYBORG sobe para o opus. É o pedido — o Cyborg é
 * o último recurso, roda uma vez por projeto e é onde modelo fraco custa entrega, não token.
 */
function pickStrongestSlot(configs: TenantLlmConfig[]): { slot: TenantLlmConfig | null; why: string; slotModels: string[] } {
  const usaveis = configs.filter(
    (c) => c.provider && c.modelId && slotUsability(c.provider, c.credentials, c.byocExempt).usable,
  );
  const slotModels = usaveis.map((c) => c.modelId);
  if (usaveis.length === 0) return { slot: null, why: "nenhum slot utilizável", slotModels };

  const { winners, eliminados } = strongestByDomination(slotModels);
  // `winners` preserva a ordem de entrada, que é a prioridade do tenant ⇒ o primeiro já é o desempate.
  const vencedor = winners[0] ?? slotModels[0];
  const slot = usaveis.find((c) => c.modelId === vencedor) ?? usaveis[0];
  const why =
    usaveis.length === 1
      ? `único slot utilizável: ${slot.modelId} (prioridade ${slot.priority})`
      : `mais forte entre ${usaveis.length} slots: ${slot.modelId} (prioridade ${slot.priority})` +
        (eliminados.length ? ` — descartados: ${eliminados.join(" | ")}` : "") +
        (winners.length > 1
          ? ` — empate sem ordem conhecida entre [${winners.join(", ")}]; desempatou pela ordem do tenant`
          : "");
  return { slot, why, slotModels };
}

/** Projeta um slot do banco no shape que viaja para os agents. */
function toResolved(cfg: TenantLlmConfig): ResolvedLlmConfig {
  const c = cfg.credentials;
  return {
    provider:           cfg.provider,
    modelId:            cfg.modelId,
    fallbackModelId:    cfg.modelIdFallback ?? undefined,
    apiKey:             c.api_key ?? "",
    awsRegion:          c.aws_region,
    awsAccessKeyId:     c.aws_access_key_id,
    awsSecretAccessKey: c.aws_secret_access_key,
    foundryApiKey:      c.foundry_api_key,
    foundryResource:    c.foundry_resource,
    foundryBaseUrl:     c.foundry_base_url,
    googleApiKey:       c.google_api_key,
    googleBaseUrl:      c.google_base_url,
    vertexProjectId:    c.vertex_project_id,
    vertexLocation:     c.vertex_location,
    vertexServiceAccountJson: c.vertex_service_account_json,
    azureEndpoint:      c.endpoint,
    azureDeployment:    c.deployment_name,
    azureApiVersion:    c.api_version,
    isDefault:          false,
    priority:           cfg.priority,
  };
}

/** Campos a espalhar no corpo enviado aos agents (omite tudo quando é o default do env). */
export function agentsLlmFields(o: AgentsLlmOverride): Record<string, unknown> {
  if (o.isDefault) return {};
  return {
    ...(o.model_id ? { model_id: o.model_id } : {}),
    ...(o.model_id_rework ? { model_id_rework: o.model_id_rework } : {}),
    llm_config: o.llm_config,
    // Contingências do tenant (LEI 2026-09-10). Aditivo: agents antigos ignoram o campo.
    ...(o.llm_candidates && o.llm_candidates.length > 1 ? { llm_candidates: o.llm_candidates } : {}),
  };
}

/**
 * Slot efetivo do tenant (singular) — o primeiro UTILIZÁVEL na ordem de prioridade.
 * Devolve `null` quando não há nenhum: sob a LEI 2026-09-10 não existe mais um
 * `SYSTEM_DEFAULT` de env para devolver no lugar.
 */
export async function getTenantLlmConfig(tenantId: string): Promise<TenantLlmConfig | null> {
  return pickUsableSlot(await getTenantLlmConfigs(tenantId));
}

/** Revisor escolhido entre os slots do tenant — com o ENVELOPE dele, não só o id do modelo. */
export interface ReviewerPick {
  ok: true;
  model: string;
  family: string;
  why: string;
  /** Provider + credenciais DO SLOT do revisor. Trocar só o `model_id` daria 400 em outro provider. */
  llm: AgentsLlmOverride;
  priority: number;
}
export type ReviewerResolution = ReviewerPick | { ok: false; alert: string };

/**
 * ⚖️ LEI 2026-09-10 — o revisor cross-family sai dos SLOTS do tenant, nunca de env.
 *
 * Antes os candidatos vinham de `SPEC_CROSS_AUDIT_MODEL`: um id escolhido pela infra, cobrado na
 * credencial do slot Padrão. Isso quebra a lei por dois lados — modelo hard-coded, e um id de
 * outra família pedido ao provider do slot primário (o Foundry desta conta só serve Claude: 400).
 *
 * Agora cada slot é candidato COM o próprio provider e as próprias credenciais. `pickReviewerModel`
 * aplica a régua medida ("outra família E não mais fraco"); o primeiro slot que passa vence, na
 * ordem de prioridade que o tenant cadastrou — então reordenar slots na tela muda o revisor sem
 * deploy. Sem slot de outra família a resposta é ALERTA, e a auditoria não roda.
 */
export async function resolveReviewerLlm(args: {
  tenantId: string;
  executorModel: string;
}): Promise<ReviewerResolution> {
  const { picks, alert } = await rankReviewerSlots(args);
  return picks[0] ?? { ok: false, alert };
}

/**
 * TODOS os slots viáveis como revisor, na ordem de prioridade do tenant.
 *
 * Existe porque a medição de recall do juiz (`specJudgeRecall`) precisa de DOIS revisores de
 * famílias distintas — o casador e o terceiro que recasa a amostra. Com um só, "discordância entre
 * casadores" mediria a consistência de uma família consigo mesma (GAP-98/93), que é justamente o
 * número que não serve para nada.
 */
export async function rankReviewerSlots(args: {
  tenantId: string;
  executorModel: string;
}): Promise<{ picks: ReviewerPick[]; alert: string }> {
  const slots = (await getTenantLlmConfigs(args.tenantId)).filter(
    (c) => c.provider && c.modelId && slotUsability(c.provider, c.credentials, c.byocExempt).usable,
  );
  if (slots.length === 0) {
    return { picks: [], alert: "revisor cross-family: o tenant não tem nenhum slot de LLM utilizável" };
  }
  const picks: ReviewerPick[] = [];
  const recusas: string[] = [];
  for (const slot of slots) {
    // Um candidato por vez: cada slot tem o SEU provider, e `servableBy` é uma pergunta por slot.
    const pick = pickReviewerModel({
      executorModel: args.executorModel,
      candidates: [slot.modelId],
      provider: slot.provider,
    });
    if (pick.ok) {
      picks.push({ ok: true, model: pick.model, family: pick.family, why: pick.why,
                   llm: toAgentsOverride(toResolved(slot)), priority: slot.priority });
    } else {
      recusas.push(...pick.recusados);
    }
  }
  return {
    picks,
    // Com pelo menos um revisor viável não existe alerta: a frase "nenhum dos N slots serve" seria
    // FALSA e, medida ao vivo (e2e 2026-09-10), sai junto de um `picks` com 1 item. Quem loga o
    // alerta sem olhar `picks` publicaria o contrário do que aconteceu.
    alert: picks.length > 0 ? "" :
      `revisor cross-family: nenhum dos ${slots.length} slot(s) do tenant serve para revisar ` +
      `'${args.executorModel || "(executor não declarado)"}' — ${recusas.join(" | ")}. ` +
      "Revisor da MESMA família mede zero ganho e rejeita 35% do que está certo; revisor mais fraco " +
      "muda 0 respostas pelo dobro do custo. Cadastre um slot de OUTRA família em Configurações → LLM.",
  };
}

async function tenantIdOfProject(projectId: string): Promise<string | null> {
  try {
    const res = await pool.query(`SELECT tenant_id FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
    return (res.rows[0]?.tenant_id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Mesma resolução, partindo do projeto (a Fábrica e a Bancada só conhecem o `projectId`). */
export async function resolveReviewerLlmForProject(args: {
  projectId: string;
  executorModel: string;
}): Promise<ReviewerResolution> {
  const tenantId = await tenantIdOfProject(args.projectId);
  if (!tenantId) return { ok: false, alert: "revisor cross-family: projeto sem tenant" };
  return resolveReviewerLlm({ tenantId, executorModel: args.executorModel });
}

/** Todos os revisores viáveis do projeto, na ordem de prioridade dos slots. */
export async function rankReviewerSlotsForProject(args: {
  projectId: string;
  executorModel: string;
}): Promise<{ picks: ReviewerPick[]; alert: string }> {
  const tenantId = await tenantIdOfProject(args.projectId);
  if (!tenantId) return { picks: [], alert: "revisor cross-family: projeto sem tenant" };
  return rankReviewerSlots({ tenantId, executorModel: args.executorModel });
}

/**
 * FT-13: Resolve a config LLM efetiva para um projeto.
 * Tenta em ordem de prioridade; retorna a primeira com credenciais válidas.
 *
 * `strategy: "strongest"` (Cyborg) troca só o CRITÉRIO DE ESCOLHA entre os slots — a fonte continua
 * sendo exclusivamente `tenant_llm_configs`, e sem slot utilizável continua lançando.
 */
export async function resolveProjectLlmConfig(
  projectId: string,
  opts: { strategy?: LlmSelectionStrategy } = {},
): Promise<ResolvedLlmConfig> {
  return (await resolveProjectLlmCandidates(projectId, opts))[0];
}

/**
 * ⚖️ Jean, 2026-09-10: *"sempre testando se funciona e em caso de não funcionar testa o próximo"*.
 *
 * A FILA inteira de slots utilizáveis do projeto — o escolhido primeiro, as contingências atrás, na
 * ordem que o tenant cadastrou. `resolveProjectLlmConfig` é o primeiro item desta lista, então quem
 * já usava a resolução singular não muda de comportamento: o que muda é passar a existir um
 * "próximo" quando o primeiro falha ao vivo.
 *
 * Continua lançando `LlmSlotNotConfiguredError` quando a fila é vazia — a cascata dá contingência,
 * nunca uma porta de saída para a conta da Zentriz.
 */
export async function resolveProjectLlmCandidates(
  projectId: string,
  opts: { strategy?: LlmSelectionStrategy } = {},
): Promise<ResolvedLlmConfig[]> {
  const strategy: LlmSelectionStrategy = opts.strategy ?? "priority";
  let createdByRole = "user";
  let tenantId: string | null = null;

  try {
    const proj = await pool.query(
      `SELECT p.tenant_id, u.role AS creator_role
       FROM projects p JOIN users u ON u.id = p.created_by
       WHERE p.id = $1 LIMIT 1`,
      [projectId]
    );
    if (proj.rows.length > 0) {
      createdByRole  = String(proj.rows[0].creator_role ?? "user");
      tenantId       = String(proj.rows[0].tenant_id ?? "");
    }
  } catch { /* fall through */ }

  // 1º) Os slots do TENANT dono do projeto — inclusive quando quem criou é zentriz_admin.
  //     Ordem invertida de propósito (era zentriz_llm_config primeiro): sob a lei, quem paga o
  //     LLM é o dono do projeto. Um zentriz_admin operando dentro do tenant X consome o slot de X.
  if (tenantId) {
    const configs = await getTenantLlmConfigs(tenantId);
    const usaveis = configs.filter(
      (c) => c.provider && c.modelId && slotUsability(c.provider, c.credentials, c.byocExempt).usable,
    );
    if (usaveis.length > 0) {
      if (strategy === "strongest") {
        const { slot, why, slotModels } = pickStrongestSlot(configs);
        const escolhido = slot ?? usaveis[0];
        // O vencedor vai à frente; o RESTO mantém a ordem do tenant. A contingência de um Cyborg
        // que escolheu por força continua sendo a fila dele — força não reordena quem paga.
        const resto = usaveis.filter((c) => c !== escolhido);
        return [
          { ...toResolved(escolhido), selection: { strategy, why, slotModels } },
          ...resto.map(toResolved),
        ];
      }
      return usaveis.map(toResolved);
    }
  }

  // 2º) Só para zentriz_admin: os slots da CONTA DE GESTÃO — linhas de BANCO explicitamente
  //     cadastradas, não `.env`. É o único caso em que a conta da Zentriz é a resposta certa,
  //     porque quem pediu o trabalho é a própria Zentriz.
  //
  //     ⚠️ 2026-09-10: aqui havia `LIMIT 1` sem `ORDER BY`. Era inofensivo enquanto o índice
  //     `((TRUE))` garantia uma linha só; a migration 126 abriu a fila (0..3) e, sem ordenação,
  //     o Postgres devolveria linha ARBITRÁRIA — a contingência viraria a principal por sorteio.
  if (createdByRole === "zentriz_admin") {
    const res = await pool.query(
      `SELECT provider, model_id, model_id_fallback, credentials, priority
       FROM zentriz_llm_config
       WHERE is_active = TRUE
       ORDER BY priority ASC`
    );
    const fila = (res.rows as Record<string, unknown>[])
      .map((row): TenantLlmConfig => ({
        provider:              String(row.provider ?? ""),
        modelId:               String(row.model_id ?? ""),
        modelIdFallback:       row.model_id_fallback ? String(row.model_id_fallback) : null,
        credentials:           (row.credentials as Record<string, string>) ?? {},
        maxConcurrentProjects: DEFAULT_MAX_CONCURRENT_PROJECTS,
        dailyTokenQuota:       null,
        deadpoolTokenReserve:  0,
        isDefault:             false,
        priority:              Number(row.priority ?? 0),
        // A conta de gestão é dona da própria fatura; mas ainda assim exigimos credencial
        // PRÓPRIA no slot (`byocExempt: false`) — sem `.env`, como manda a LEI.
        byocExempt:            false,
      }))
      .filter((c) => c.provider && c.modelId && slotUsability(c.provider, c.credentials, false).usable);
    // A fila inteira: a conta de gestão também merece contingência quando o slot 0 falha ao vivo.
    if (fila.length > 0) return fila.map(toResolved);
  }

  // ⚖️ LEI 2026-09-10 — sem slot utilizável NÃO há default. Antes daqui saíam dois retornos com
  // `GENESIS_LLM_PROVIDER`/`CLAUDE_MODEL`: era por eles que a fatura ia para a Zentriz em silêncio.
  throw new LlmSlotNotConfiguredError();
}

export async function hasConcurrencySlot(tenantId: string): Promise<boolean> {
  try {
    const [configResult, runningResult] = await Promise.all([
      pool.query(
        `SELECT max_concurrent_projects FROM tenant_llm_configs
         WHERE tenant_id = $1 AND is_active = TRUE ORDER BY priority ASC LIMIT 1`,
        [tenantId]
      ),
      pool.query(
        `SELECT COUNT(*) AS running_count FROM projects
         WHERE tenant_id = $1 AND status = 'running'`,
        [tenantId]
      ),
    ]);
    const maxConcurrent = configResult.rows[0]
      ? Number(configResult.rows[0].max_concurrent_projects)
      : DEFAULT_MAX_CONCURRENT_PROJECTS;
    const runningCount = Number(runningResult.rows[0]?.running_count ?? 0);
    return runningCount < maxConcurrent;
  } catch {
    return true;
  }
}

export async function enqueueOrStart(
  projectId: string,
  tenantId: string
): Promise<"started" | "queued"> {
  const hasSlot = await hasConcurrencySlot(tenantId);
  if (hasSlot) return "started";
  await pool.query(
    `UPDATE projects SET status = 'queued', queued_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [projectId]
  );
  return "queued";
}

export interface SlotClaim {
  outcome: "started" | "queued";
  /** Status do projeto ANTES do claim — usado por revertSlotClaim se o dispatch falhar. */
  previousStatus: string | null;
}

/**
 * Claim ATÔMICO de slot de concorrência (RFC-0003, fix C2 — elimina o TOCTOU do
 * `enqueueOrStart`, onde N chamadas concorrentes liam a mesma contagem de 'running' e
 * todas decidiam "started", furando o teto).
 *
 * Serializa por tenant via `pg_advisory_xact_lock` e, DENTRO da mesma transação, conta os
 * projetos 'running' e RESERVA o slot marcando o projeto como 'running' (o próprio marcador
 * que a contagem observa) — ou o enfileira ('queued'). Como a reserva acontece sob o lock,
 * dois claimers do mesmo tenant nunca veem a mesma contagem estável duas vezes.
 *
 * Retorna também o status anterior, para reverter (revertSlotClaim) se o dispatch falhar.
 */
export async function claimSlotOrQueue(
  projectId: string,
  tenantId: string
): Promise<SlotClaim> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // hashtext(uuid::text) → int4, promovido ao overload bigint de pg_advisory_xact_lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenantId]);

    const cur = await client.query("SELECT status FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
    const previousStatus = (cur.rows[0]?.status as string | undefined) ?? null;

    const cfg = await client.query(
      `SELECT max_concurrent_projects FROM tenant_llm_configs
       WHERE tenant_id = $1 AND is_active = TRUE ORDER BY priority ASC LIMIT 1`,
      [tenantId]
    );
    const maxConcurrent = cfg.rows[0]
      ? Number(cfg.rows[0].max_concurrent_projects)
      : DEFAULT_MAX_CONCURRENT_PROJECTS;

    const cnt = await client.query(
      `SELECT COUNT(*) AS running_count FROM projects WHERE tenant_id = $1 AND status = 'running'`,
      [tenantId]
    );
    const runningCount = Number(cnt.rows[0]?.running_count ?? 0);

    if (runningCount < maxConcurrent) {
      await client.query(
        `UPDATE projects SET status = 'running', started_at = now(), updated_at = now(), stopped_by = NULL WHERE id = $1`,
        [projectId]
      );
      await client.query("COMMIT");
      return { outcome: "started", previousStatus };
    }

    await client.query(
      `UPDATE projects SET status = 'queued', queued_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [projectId]
    );
    await client.query("COMMIT");
    return { outcome: "queued", previousStatus };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reverte um claim de slot (status 'running' reservado) de volta ao status anterior quando o
 * dispatch subsequente falha — liberando o slot. Só age se o projeto ainda estiver 'running'
 * (não sobrescreve um estado já avançado pelo runner via callback).
 */
export async function revertSlotClaim(projectId: string, previousStatus: string | null): Promise<void> {
  if (!previousStatus) return;
  await pool.query(
    `UPDATE projects SET status = $1, started_at = NULL, updated_at = now()
     WHERE id = $2 AND status = 'running'`,
    [previousStatus, projectId]
  );
}
