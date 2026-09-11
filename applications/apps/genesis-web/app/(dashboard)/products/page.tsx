"use client";

// "Meus produtos" (RFC-0003 F3). Um PRODUTO agrupa projetos relacionados. Aqui só
// aparecem produtos ativos (GET /api/products) — os projetos-rascunho e o desenho ficam
// na Bancada (/specs). Clicar num produto abre /products/:id/projects (drilldown). O
// lifecycle_status distingue produto ainda na Bancada (draft) de já em fábrica (running).
// Promover produto inteiro é OPERAÇÃO → o master (zentriz_admin) também pode (C6).
//
// Migração 097 (requisito do Jean, 2026-09-06): "Promover à fábrica" entrega o produto TODO, na
// ordem de interdependência decidida pelo arquiteto, e NÃO inicia nada — o produto fica
// `lifecycle_status='promoted'`. Daí saem duas ações: "Ver ordem e iniciar" (abre o plano por onda
// e inicia SÓ a onda pendente mais baixa, de dentro dele) e "Devolver à Bancada".
//
// Padronização 2026-09-06 (revisão adversarial da Bancada): rótulos/tooltips/textos de resultado
// vêm de `lib/factoryActions.ts`; promover e devolver passam por `ConfirmActionDialog` (N1); o
// aviso de página tem severidade honesta. Ver
// `project/docs/plans/BANCADA-REVISAO-ADVERSARIAL-PADRONIZACAO-2026-09-06.md`.
//
// Excluir: com confirmação por reescrita do ID. Sem projetos → apaga de verdade. Com
// projetos → arquiva (oculta do portal), preservando tudo no banco (apagar é arriscado).

import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import UndoRoundedIcon from "@mui/icons-material/UndoRounded";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import { apiGet, apiPost, apiDeleteJson, withQuery } from "@/lib/api";
// UI/UX 2026-09-11 (Jean): *"os botões são iguais e ocupam muito espaço, cada um em uma linha"*.
// O card de produto declara suas ações UMA vez e a barra escolhe a forma (primária com rótulo +
// ⋮). `breakpoint="always"` porque a estreiteza aqui é do CARD (≈300 px na grade de 3 colunas),
// não do viewport — esperar o breakpoint empilharia botões `fullWidth` até num monitor de 1440.
import ActionOverflowBar, { type BarAction } from "@/components/ActionOverflowBar";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
import { authStore } from "@/stores/authStore";
import { ProductCertificateChip, type ProductFactoryCertificate } from "@/components/FactoryCertificate";
import {
  PromotionPlanDialog, describeStartResult,
  type PromotionPlanItem, type PromotionPlanMeta, type StartWaveResult,
} from "@/components/PromotionPlanDialog";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
// Rastreabilidade (Jean, 2026-09-07): três relatórios em PDF do mapeamento da construção. O MESMO
// controle usado na Bancada — produto da Bancada e da Fábrica são o mesmo objeto.
import { TraceabilityReportsButton } from "@/components/TraceabilityReports";
// Padronização 2026-09-06: rótulo/tooltip/texto de resultado das ações de fábrica vêm de UM módulo.
import {
  FACTORY_LABEL, FACTORY_TOOLTIP, promoteConfirmBody, promotedProductNotice, normalizedProductNotice,
  promoteGate, normalizeLabel, type PromotionVerdict,
} from "@/lib/factoryActions";

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  lifecycle_status: string | null;
  created_at: string;
  project_count: number;
  /** §4.15: true = INBOX "Rascunhos" (a API já o oculta aqui por padrão; defesa extra client-side). */
  is_inbox?: boolean;
  /** §4.15: true = produto homônimo de um App solo (auto-criado ao promover do inbox ou na migração 064). */
  solo_app?: boolean;
  /** Certificado Genesis Factory agregado (AND dos projetos na Bancada). Ausente com a flag off. */
  factoryCertificate?: ProductFactoryCertificate | null;
  /**
   * RFC-0008 Emenda 01 — a documentação de decisão está em dia com a spec ATUAL?
   * `true` destrava o promover · `false` trava · `null` = o servidor não checou aqui (produto
   * grande demais); nesse caso o botão fica habilitado e quem decide é o `/promote`, que sempre
   * computa o hash de verdade e responde 409 NOT_NORMALIZED se estiver fora de dia.
   */
  normalized?: boolean | null;
  normalized_at?: string | null;
  /**
   * Veredito ÚNICO do servidor (`services/promotability.ts`). É ele que manda; `normalized` é só
   * fallback para ambiente antigo. Distingue "falta doc" (normalizar destrava) de "já saiu da
   * Bancada" (normalizar documenta, mas não destrava promoção nenhuma).
   */
  promotion?: PromotionVerdict | null;
}

// Rótulo + cor do ciclo de vida do produto (Bancada vs fábrica vs terminal).
function lifecycleChip(ls: string | null): { label: string; color: "default" | "info" | "success" | "warning" | "secondary" } {
  switch (ls) {
    case "draft": return { label: "Na Bancada", color: "warning" };
    // Migração 097: promovido = a fábrica RECEBEU o produto todo, na ordem, e não iniciou nada.
    // Rótulo explícito porque "em fábrica" aqui seria mentira (nenhum projeto está rodando).
    case "promoted": return { label: "Promovido — aguardando início", color: "secondary" };
    case "running": return { label: "Em fábrica", color: "info" };
    case "completed":
    case "accepted": return { label: "Concluído", color: "success" };
    default: return { label: ls ?? "—", color: "default" };
  }
}

function ProductsPageInner() {
  const router = useRouter();
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // B3 (revisão adversarial): o aviso de página era SEMPRE verde — um início recusado por gate
  // aparecia como sucesso. A severidade acompanha o resultado real (fonte: describeStartResult).
  const [noticeSeverity, setNoticeSeverity] = useState<"success" | "warning">("success");
  const [busyId, setBusyId] = useState<string | null>(null);
  // Confirmação N1 (escada de guardas): promover produto inteiro e devolver à Bancada.
  const [confirmAction, setConfirmAction] = useState<
    { kind: "promote" | "unpromote"; product: ProductRow } | null
  >(null);

  // Estado do diálogo do PLANO de promoção (ordem por onda) — migração 097.
  const [planOpen, setPlanOpen] = useState(false);
  const [planProduct, setPlanProduct] = useState<ProductRow | null>(null);
  const [planMeta, setPlanMeta] = useState<PromotionPlanMeta | null>(null);
  const [planItems, setPlanItems] = useState<PromotionPlanItem[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [startedNotice, setStartedNotice] = useState<string | null>(null);
  const [startedSeverity, setStartedSeverity] = useState<"success" | "warning">("success");

  // Relatórios em PDF: no card a ação é um item do menu ⋮; a lista dos três perfis é a instância
  // `hosted` (uma só, fora da grade), ancorada no ícone do card que foi clicado.
  const [reportsAnchor, setReportsAnchor] = useState<{ el: HTMLElement; product: ProductRow } | null>(null);

  // Estado do diálogo de exclusão.
  const [deleteTarget, setDeleteTarget] = useState<ProductRow | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [ack, setAck] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Master escopa por tenant selecionado no topo (null = todos).
  const scopeTenantId = tenantScopeStore.selectedTenantId;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await apiGet<ProductRow[]>(withQuery("/api/products", { tenantId: scopeTenantId }));
      // A API já exclui o INBOX aqui (sem ?includeInbox), mas filtramos por garantia (§5.9).
      setProducts(Array.isArray(data) ? data.filter((p) => p.is_inbox !== true) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar produtos");
    } finally {
      setLoading(false);
    }
  }, [scopeTenantId]);

  useEffect(() => { load(); }, [load]);

  // ── Promoção do produto INTEIRO, na ordem de interdependência, SEM iniciar (migração 097) ──
  // Antes esta ação promovia só as RAÍZES e as disparava na hora. Agora todos os projetos entram
  // (status `promoted`, inerte) na ordem que o agente arquiteto decidiu, e o início é um clique
  // separado — requisito do Jean (2026-09-06).
  /** Aviso de página com severidade honesta (B3). */
  const showNotice = (msg: string, severity: "success" | "warning" = "success") => {
    setNoticeSeverity(severity); setNotice(msg);
  };

  const promote = async (p: ProductRow) => {
    setBusyId(p.id);
    setPlanError(null); setStartedNotice(null);
    try {
      const res = await apiPost<{
        promotionId: string; promoted: string[]; waves: number; plan: PromotionPlanItem[];
        notes?: string | null; warnings?: string[]; edgesSource?: string | null; modelUsed?: string | null;
      }>(`/api/products/${p.id}/promote`, {});
      showNotice(promotedProductNotice(res.promoted.length, res.waves));
      setPlanProduct(p);
      setPlanMeta({
        promotionId: res.promotionId, notes: res.notes ?? null, warnings: res.warnings ?? [],
        edgesSource: res.edgesSource ?? null, modelUsed: res.modelUsed ?? null,
      });
      setPlanItems(res.plan ?? []);
      setPlanOpen(true);
      await load();
    } catch (e) {
      // O planejador é um agente: sem agents / JSON inválido / ciclo ⇒ 422 e NADA é promovido.
      setError(e instanceof Error ? e.message : "Falha ao promover o produto");
    } finally {
      setBusyId(null);
    }
  };

  // ── [Normalizar] — passo condicionado ANTES de promover (RFC-0008 Emenda 01) ──
  // Pedido do Jean (2026-09-11): "se adicionar uma etapa antes de promover (condicionado), tipo:
  // [Normalizar] e ele cria/atualiza os docs(RFC e os que fizer sentido) possiveis e destrava o
  // botao de promover para a fabrica". O conteúdo é decisão de agente; falha ⇒ 422 e nada é escrito.
  const normalize = async (p: ProductRow) => {
    setBusyId(p.id);
    setError(null);
    try {
      const res = await apiPost<{
        status: "normalized" | "already_normalized"; summary?: string;
        written?: Array<{ path: string }>; skippedProjects?: Array<{ title: string; reason: string }>;
        warnings?: string[]; truncated?: string[]; message?: string;
      }>(`/api/products/${p.id}/normalize`, {});
      if (res.status === "already_normalized") {
        showNotice(res.message ?? "A spec não mudou desde a última normalização — nada a refazer.");
      } else {
        const skipped = res.skippedProjects?.length ?? 0;
        showNotice(
          `${normalizedProductNotice(res.written?.length ?? 0, skipped, p.lifecycle_status === "draft")}${res.summary ? ` — ${res.summary}` : ""}`,
          skipped > 0 || (res.warnings?.length ?? 0) > 0 ? "warning" : "success",
        );
      }
      await load();
    } catch (e) {
      // 422: o normalizador recusou (spec não sustenta RFC honesto, agente fora do ar, JSON inválido).
      setError(e instanceof Error ? e.message : "Falha ao normalizar o produto");
    } finally {
      setBusyId(null);
    }
  };

  // Plano vigente (a UI mostra a ordem por onda, com o status de cada projeto).
  // B6: este diálogo é TAMBÉM o caminho de início — nenhuma tela dispara `/start` às cegas.
  const openPlan = async (p: ProductRow) => {
    setBusyId(p.id);
    setPlanError(null); setStartedNotice(null);
    try {
      const res = await apiGet<{
        promotion: PromotionPlanMeta | null; items: PromotionPlanItem[];
      }>(`/api/products/${p.id}/promotion`);
      setPlanProduct(p);
      setPlanMeta(res.promotion);
      setPlanItems(res.items ?? []);
      setPlanOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar a ordem de promoção");
    } finally {
      setBusyId(null);
    }
  };

  // Início EXPLÍCITO: dispara só a onda mais baixa pendente; as seguintes entram pela cascata de
  // accept, cada uma passando pelo gate de dependência.
  const startProduct = async (p: ProductRow) => {
    setBusyId(p.id); setPlanError(null); setStartedNotice(null);
    try {
      const res = await apiPost<StartWaveResult>(`/api/products/${p.id}/start`, {});
      // O motivo é o do SERVIDOR (não um palpite "dependência ou fila") — ver describeStartResult.
      const { message: msg, severity } = describeStartResult(res);
      setStartedNotice(msg);
      setStartedSeverity(severity);
      // B3: o mesmo texto na página, com a MESMA severidade (antes era sempre verde).
      showNotice(msg, severity);
      // Recarrega o plano para o diálogo refletir os status novos (e não prometer início já feito).
      try {
        const fresh = await apiGet<{ promotion: PromotionPlanMeta | null; items: PromotionPlanItem[] }>(
          `/api/products/${p.id}/promotion`,
        );
        setPlanMeta(fresh.promotion); setPlanItems(fresh.items ?? []);
      } catch { /* o notice acima já informou o resultado */ }
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Falha ao iniciar o produto";
      setPlanError(msg); setError(planOpen ? null : msg);
    } finally {
      setBusyId(null);
    }
  };

  // Saída da promoção: promovido volta a rascunho (a spec destrava). Recusado se a fábrica começou.
  const unpromote = async (p: ProductRow) => {
    setBusyId(p.id);
    try {
      const res = await apiPost<{ returned: string[] }>(`/api/products/${p.id}/unpromote`, {});
      showNotice(`Produto devolvido à Bancada — ${res.returned.length} projeto(s) voltaram a rascunho.`);
      setPlanOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao devolver o produto à Bancada");
    } finally {
      setBusyId(null);
    }
  };

  const copyId = async (id: string) => {
    try { await navigator.clipboard.writeText(id); showNotice("ID copiado para a área de transferência."); }
    catch { setError("Não foi possível copiar automaticamente — selecione e copie manualmente."); }
  };

  const openDelete = (p: ProductRow) => {
    setDeleteTarget(p);
    setConfirmText("");
    setAck(false);
    setError(null);
  };
  const closeDelete = () => {
    if (deleting) return;
    setDeleteTarget(null);
    setConfirmText("");
    setAck(false);
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiDeleteJson<{ mode: string; message?: string }>(`/api/products/${deleteTarget.id}`, {
        confirmId: confirmText.trim(),
        acknowledge: ack,
      });
      showNotice(res.message ?? "Produto excluído.");
      setDeleteTarget(null);
      setConfirmText("");
      setAck(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao excluir o produto");
    } finally {
      setDeleting(false);
    }
  };

  const hasProjects = (deleteTarget?.project_count ?? 0) > 0;
  const idMatches = !!deleteTarget && confirmText.trim() === deleteTarget.id;
  const canDelete = idMatches && (!hasProjects || ack);

  /**
   * Ações do card de produto — declaradas UMA vez, exibidas pela `ActionOverflowBar`.
   *
   * Medição do estado anterior (Playwright, mesmo tenant): 6 linhas de controles por card em
   * 320/600/900/1440 px, porque [Normalizar], [Promover produto inteiro] / [Ver ordem e iniciar] +
   * [Devolver à Bancada] / [Ver ordem de entrada] e [Relatórios (PDF)] eram todos `fullWidth`,
   * um por linha, com peso visual parecido. Nada foi removido: a PRÓXIMA ação do fluxo vira o
   * botão primário (único `contained` do card) e as demais vão para o ⋮, com rótulo e explicação.
   *
   * A ordem do fluxo (quem é primária) segue o ciclo de vida, não a estética:
   *   documentar (normalizar) → promover → ver a ordem e iniciar → (depois) consultar a ordem.
   */
  const productCardActions = (p: ProductRow, gate: ReturnType<typeof promoteGate>): BarAction[] => {
    const busy = busyId === p.id;
    const ls = p.lifecycle_status;
    const temDocs = p.normalized === true;
    const acoes: BarAction[] = [];

    // 1) Normalizar — existe em QUALQUER estado do ciclo de vida (documentar ≠ promover).
    if (p.project_count > 0) {
      acoes.push({
        key: "normalize",
        label: busy ? FACTORY_LABEL.normalizing : normalizeLabel(p.promotion, p.normalized ?? null),
        icon: <AutoFixHighOutlinedIcon sx={{ fontSize: "0.9rem" }} />,
        tooltip: FACTORY_TOOLTIP.normalize,
        variant: temDocs ? "outlined" : "contained",
        color: temDocs ? "inherit" : "primary",
        disabled: busy, busy,
        // Enquanto a documentação não está em dia, normalizar É o próximo passo — e o único
        // caminho para destravar o promover.
        primary: !temDocs,
        onClick: () => { void normalize(p); },
      });
    }
    // 2) Promover produto inteiro — só na Bancada e só se o SERVIDOR liberou (gate.show).
    if (ls === "draft" && gate.show) {
      acoes.push({
        key: "promote",
        label: FACTORY_LABEL.promoteProduct,
        icon: <RocketLaunchIcon sx={{ fontSize: "0.9rem" }} />,
        tooltip: FACTORY_TOOLTIP.promoteProduct,
        variant: temDocs ? "contained" : "outlined",
        color: "success",
        disabled: busy, busy,
        primary: temDocs || p.project_count === 0,
        // N1: admitir N projetos (e pagar o planejador) passa por confirmação.
        onClick: () => setConfirmAction({ kind: "promote", product: p }),
      });
    }
    // 3) Promovido e parado: abrir a ordem (o início acontece lá dentro, com o nº da onda) ou voltar.
    if (ls === "promoted") {
      acoes.push({
        key: "openPlanAndStart",
        label: FACTORY_LABEL.openPlanAndStart,
        icon: <PlayArrowRoundedIcon sx={{ fontSize: "0.95rem" }} />,
        tooltip: FACTORY_TOOLTIP.openPlanAndStart,
        variant: "contained", color: "success",
        disabled: busy, busy, primary: true,
        onClick: () => { void openPlan(p); },
      });
      acoes.push({
        key: "unpromote",
        label: FACTORY_LABEL.unpromote,
        icon: <UndoRoundedIcon sx={{ fontSize: "0.9rem" }} />,
        tooltip: FACTORY_TOOLTIP.unpromote,
        variant: "outlined", color: "warning",
        disabled: busy,
        onClick: () => setConfirmAction({ kind: "unpromote", product: p }),
      });
    }
    // 4) Já em fábrica (ou terminal): a ordem gravada continua consultável (leitura).
    if (ls !== "draft" && ls !== "promoted") {
      acoes.push({
        key: "openPlan",
        label: "Ver ordem de entrada",
        icon: <AccountTreeOutlinedIcon sx={{ fontSize: "0.9rem" }} />,
        tooltip: "Mostra a ordem por onda com que a fábrica recebeu este produto.",
        variant: "outlined", color: "inherit",
        disabled: busy,
        // Sem ação de escrita aqui: a leitura é o que resta, então ela é a primária.
        primary: temDocs,
        onClick: () => { void openPlan(p); },
      });
    }
    // 5) Relatórios em PDF — em qualquer estado: o valor é contar a construção.
    acoes.push({
      key: "reports",
      label: "Relatórios (PDF)",
      icon: <PictureAsPdfOutlinedIcon sx={{ fontSize: "0.9rem" }} />,
      tooltip: "Resumido, completo ou misto — o mapeamento da construção do produto.",
      onClick: (el) => setReportsAnchor({ el, product: p }),
    });
    return acoes;
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
        <Inventory2OutlinedIcon sx={{ color: "#8B5CF6" }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>Meus produtos</Typography>
          <Typography variant="body2" color="text.secondary">
            Um produto agrupa projetos relacionados. Abra um produto para ver seus projetos e o grafo de execução.
          </Typography>
        </Box>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert severity={noticeSeverity} sx={{ mb: 2, whiteSpace: "pre-line" }} onClose={() => setNotice(null)}>{notice}</Alert>}

      {loading ? (
        <LinearProgress sx={{ borderRadius: 1 }} />
      ) : products.length === 0 ? (
        <Card sx={{ textAlign: "center", py: 6 }}>
          <CardContent>
            <Typography variant="body2" color="text.secondary">
              {authStore.isZentrizAdmin
                ? "Este tenant ainda não possui produtos."
                : "Nenhum produto ainda. Decomponha uma spec ou ideia na Bancada para criar um produto."}
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "1fr 1fr 1fr" }, gap: 2 }}>
          {products.map((p) => {
            const lc = lifecycleChip(p.lifecycle_status);
            // Veredito único do servidor: mostrar/esconder o Promover e com que motivo.
            const gate = promoteGate(p.promotion, p.normalized ?? null);
            // Homônimos (mesmo name no tenant) recebem sufixo curto client-side p/ desambiguar —
            // sem mexer no name do banco (§5.9).
            const nameClash = products.filter((o) => o.name === p.name).length > 1;
            const displayName = nameClash ? `${p.name} ·${p.id.slice(0, 8)}` : p.name;
            return (
              <Card key={p.id} variant="outlined" sx={{ display: "flex", flexDirection: "column" }}>
                <CardActionArea onClick={() => router.push(`/products/${p.id}/projects`)} sx={{ flexGrow: 1 }}>
                  <CardContent>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} sx={{ mb: 0.25 }}>
                      {/* Até 2 linhas e depois reticências: numa grade de 3 colunas a 900 px sobram
                          ~180 px e "Simple Blog Platform" virava título de TRÊS linhas, empurrando
                          todo o card. O nome inteiro fica no `title` (e o card já leva ao produto). */}
                      <Typography
                        variant="subtitle1" fontWeight={700} title={displayName}
                        sx={{
                          lineHeight: 1.3, minWidth: 0, flexGrow: 1,
                          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                        }}
                      >
                        {displayName}
                      </Typography>
                      {/* Medido a 900 px: com "App solo (auto-criado)" + "Em fábrica" nesta linha, o
                          conteúdo passava 53 px para FORA do card (o ícone de excluir saía da área
                          clicável) e o título era espremido em três linhas. Os chips de estado
                          desceram para a faixa de metadados do card — mesma informação, mesma
                          ordem de leitura, e o título recupera a largura. */}
                      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ flexShrink: 0, minWidth: 0 }}>
                        {/* Excluir — só o ícone, canto superior direito, na mesma linha do título. */}
                        <Tooltip title="Excluir produto">
                          <IconButton
                            size="small" color="error" aria-label="Excluir produto"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openDelete(p); }}
                            // Alvo ≥ 24×24 (WCAG 2.5.8) — medido em 20×20 antes. Ícone inalterado.
                            sx={{ p: 0.5 }}
                          >
                            <DeleteOutlineIcon sx={{ fontSize: "1rem" }} />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </Stack>
                    {/* ID do produto (letra pequena) — copiável para colar na confirmação de exclusão. */}
                    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 1, minWidth: 0 }}>
                      {/* Uma linha com reticências em vez de `break-all` em duas: o UUID continua
                          visível (prefixo), inteiro no tooltip e íntegro no botão de copiar — que é
                          para o que ele serve aqui (colar na confirmação de exclusão). */}
                      <Tooltip title={p.id}>
                        <Typography
                          variant="caption" color="text.secondary" fontFamily="monospace" noWrap
                          sx={{ fontSize: "0.65rem", minWidth: 0, flex: "1 1 auto" }}
                        >
                          {p.id}
                        </Typography>
                      </Tooltip>
                      <Tooltip title="Copiar ID">
                        <IconButton
                          size="small"
                          aria-label="Copiar ID do produto"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void copyId(p.id); }}
                          // Alvo ≥ 24×24 (WCAG 2.5.8) — medido em 17×17 antes; `p: 0.5` sozinho dava
                          // 21×21 porque o ícone é 0.8rem, então a caixa vai explícita.
                          sx={{ p: 0.5, width: 26, height: 26, flexShrink: 0 }}
                        >
                          <ContentCopyIcon sx={{ fontSize: "0.8rem" }} />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    {p.description && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1, lineHeight: 1.5 }}>
                        {p.description}
                      </Typography>
                    )}
                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                      {/* Estado do ciclo de vida: primeiro chip da faixa (é o metadado que manda no
                          que o card oferece). Saiu da linha do título para devolver largura ao nome. */}
                      <Chip label={lc.label} size="small" color={lc.color} sx={{ fontSize: "0.62rem", height: 20 }} />
                      <Chip
                        label={`${p.project_count} projeto${p.project_count !== 1 ? "s" : ""}`}
                        size="small" variant="outlined" sx={{ fontSize: "0.62rem", height: 20 }}
                      />
                      {p.solo_app && (
                        <Tooltip title="Produto criado automaticamente para um App que roda sozinho (ao promover do inbox ou na migração 064).">
                          <Chip label="App solo (auto-criado)" size="small" variant="outlined" color="secondary" sx={{ fontSize: "0.62rem", height: 20 }} />
                        </Tooltip>
                      )}
                      {/* A6: agregado em AND, sempre com n/m explícito (nunca porcentagem). */}
                      {p.factoryCertificate && p.factoryCertificate.total > 0 && (
                        <ProductCertificateChip certificate={p.factoryCertificate} />
                      )}
                      {/* RFC-0008 Emenda 01: o estado da documentação de decisão fica VISÍVEL no
                          card — o humano entende por que o promover está travado sem abrir nada.
                          2026-09-11: vale em QUALQUER estado do ciclo de vida — produto que já foi
                          à Fábrica também precisa de RFC/ADR (e agora pode ganhá-los). */}
                      {p.project_count > 0 && p.normalized !== null && (
                        <Chip
                          label={p.normalized ? "Docs em dia" : "Docs pendentes"}
                          size="small"
                          color={p.normalized ? "success" : "default"}
                          variant="outlined"
                          sx={{ fontSize: "0.62rem", height: 20 }}
                        />
                      )}
                    </Stack>
                  </CardContent>
                </CardActionArea>
                {/* UMA linha de ação por card (2026-09-11). Antes eram até quatro botões `fullWidth`
                    empilhados — [Normalizar], [Promover produto inteiro] / [Ver ordem e iniciar] +
                    [Devolver à Bancada] / [Ver ordem de entrada] e [Relatórios (PDF)] — todos com o
                    mesmo peso, medidos em 6 linhas de controles por card em TODAS as larguras.
                    Nada saiu da tela: a próxima ação do fluxo é o botão primário e o resto está no ⋮.

                    [Normalizar] continua em QUALQUER estado do ciclo de vida: o adversarial mediu
                    que 13 dos 15 produtos estavam fora da Bancada e, pela regra antiga, nunca
                    poderiam ganhar RFC/ADR. Documentar não é promover.

                    Quem decide se [Promover] aparece é o SERVIDOR (`promotability.ts`); quando ele
                    veta, o lugar não fica mudo — a razão vai ao lado, senão o sumiço vira beco sem
                    saída (pedido do Jean, 2026-09-11). */}
                <Box sx={{ px: 2, pb: 2, pt: 0, display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
                  <ActionOverflowBar
                    actions={productCardActions(p, gate)}
                    breakpoint="always"
                    ariaLabel={`Ações do produto ${p.name}`}
                  />
                  {p.lifecycle_status === "draft" && !gate.show && (
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0 }}>
                      {gate.message}
                    </Typography>
                  )}
                </Box>
              </Card>
            );
          })}
        </Box>
      )}

      {/* Uma única instância `hosted` dos relatórios, ancorada no ⋮ do card clicado: assim o menu
          dos três perfis não é remontado por card e nunca abre no canto da tela. */}
      <TraceabilityReportsButton
        variant="hosted"
        hostAnchor={reportsAnchor?.el ?? null}
        onHostClose={() => setReportsAnchor(null)}
        productId={reportsAnchor?.product.id ?? null}
        productName={reportsAnchor?.product.name ?? null}
      />

      {/* Migração 097 — ordem de entrada na fábrica (por onda). Abre ao promover e no "Ver ordem".
          `onStart` vai sempre: o próprio diálogo só mostra o botão quando há onda pendente (o
          `lifecycle_status` do card pode estar velho — o produto acabou de ser promovido). */}
      <PromotionPlanDialog
        open={planOpen}
        onClose={() => { setPlanOpen(false); setPlanError(null); setStartedNotice(null); }}
        productName={planProduct?.name ?? null}
        meta={planMeta}
        items={planItems}
        onStart={planProduct ? () => { if (planProduct) void startProduct(planProduct); } : undefined}
        starting={!!planProduct && busyId === planProduct.id}
        startError={planError}
        startedNotice={startedNotice}
        startedSeverity={startedSeverity}
      />

      {/* Confirmação N1 padronizada (mesma em /specs e na Bancada): promover o produto inteiro e
          devolver à Bancada. Não repete texto — o corpo vem de `lib/factoryActions.ts`. */}
      <ConfirmActionDialog
        open={!!confirmAction}
        title={confirmAction?.kind === "unpromote" ? FACTORY_LABEL.unpromote : FACTORY_LABEL.promoteProduct}
        message={
          confirmAction?.kind === "unpromote"
            ? FACTORY_TOOLTIP.unpromote
            : promoteConfirmBody("product", {
                productName: confirmAction?.product.name ?? null,
                siblings: confirmAction?.product.project_count ?? null,
              })
        }
        confirmLabel={confirmAction?.kind === "unpromote" ? FACTORY_LABEL.unpromote : FACTORY_LABEL.promoteProduct}
        busy={!!confirmAction && busyId === confirmAction.product.id}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          const act = confirmAction;
          setConfirmAction(null);
          if (!act) return;
          if (act.kind === "promote") void promote(act.product);
          else void unpromote(act.product);
        }}
      />

      {/* Diálogo de exclusão — reescrever o ID + (se houver projetos) marcar a caixa. */}
      <Dialog open={!!deleteTarget} onClose={closeDelete} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <DeleteOutlineIcon color="error" /> Excluir produto
        </DialogTitle>
        <DialogContent>
          {deleteTarget && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Alert severity={hasProjects ? "warning" : "error"}>
                {hasProjects
                  ? `Este produto tem ${deleteTarget.project_count} projeto(s). Por segurança ele NÃO será apagado — apenas ocultado do portal (arquivado). Os projetos e o histórico permanecem no banco e a ação é reversível.`
                  : "Este produto não tem projetos e será REMOVIDO definitivamente do banco. Esta ação não pode ser desfeita."}
              </Alert>

              <Box>
                <Typography variant="caption" color="text.secondary">Produto</Typography>
                <Typography variant="body2" fontWeight={700}>{deleteTarget.name}</Typography>
              </Box>

              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  ID (copie e cole abaixo para confirmar)
                </Typography>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography variant="caption" fontFamily="monospace" sx={{ wordBreak: "break-all" }}>
                    {deleteTarget.id}
                  </Typography>
                  <Tooltip title="Copiar ID">
                    <IconButton size="small" aria-label="Copiar ID" onClick={() => void copyId(deleteTarget.id)} sx={{ p: 0.25 }}>
                      <ContentCopyIcon sx={{ fontSize: "0.9rem" }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Box>

              <TextField
                label="Reescreva o ID para confirmar"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                fullWidth size="small" autoComplete="off"
                error={confirmText.trim().length > 0 && !idMatches}
                helperText={confirmText.trim().length > 0 && !idMatches ? "O ID não confere." : " "}
                inputProps={{ style: { fontFamily: "monospace", fontSize: "0.78rem" } }}
              />

              {hasProjects && (
                <FormControlLabel
                  control={<Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} color="warning" />}
                  label={
                    <Typography variant="body2">
                      Entendo o que estou fazendo: o produto será arquivado (oculto no portal), com os projetos preservados.
                    </Typography>
                  }
                />
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDelete} disabled={deleting}>Cancelar</Button>
          <Button
            color="error" variant="contained"
            startIcon={deleting ? <CircularProgress size={14} color="inherit" /> : <DeleteOutlineIcon />}
            disabled={deleting || !canDelete}
            onClick={doDelete}
          >
            {hasProjects ? "Arquivar" : "Excluir definitivamente"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default observer(ProductsPageInner);
