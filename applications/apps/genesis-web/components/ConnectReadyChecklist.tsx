"use client";
/**
 * ConnectReadyChecklist — item 2 (extras de UI): checklist "Connect-ready" da spec no editor da Bancada.
 * Deriva do `spec-tree` (mesmo endpoint da árvore) o que a spec JÁ TEM e o que falta para chegar à
 * fábrica no padrão Genesis › Connect › Auto Care: spec primária, `connect.yaml` (declaração Connect),
 * `README.md` (manifesto/arquétipo), docs temáticos; em EVOLUÇÃO: `docs/rfc/RFC-NNNN-*.md` e `CHANGELOG.md`.
 * Só leitura e determinístico (sem LLM). A validação adversarial (aba GAPs) continua sendo o gate.
 */
import { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { apiGet, apiPost } from "@/lib/api";

interface TreeFile { path: string; ext: string; isPrimary: boolean }
interface TreeResponse { files: TreeFile[]; status?: string }

type Level = "ok" | "warn" | "fail";
export interface CheckItem { key: string; label: string; level: Level; hint: string }

/** Nomes que NÃO são arquivo temático: manifesto, declaração, changelog e as pastas de RFC/ADR. */
const RESERVADOS_RE = /^(readme\.md|changelog\.md|connect\.ya?ml|docs\/(rfc|adr)\/.*)$/;

/** Regras puras (testáveis): paths relativos da árvore → itens do checklist. */
export function computeConnectChecklist(
  paths: string[],
  opts: { isEvolution: boolean; hasPrimary: boolean; primaryPath?: string | null },
): CheckItem[] {
  const lower = paths.map((p) => p.replace(/^\/+/, "").toLowerCase());
  const has = (re: RegExp) => lower.some((p) => re.test(p));
  const primaria = (opts.primaryPath ?? "").replace(/^\/+/, "").toLowerCase();
  const items: CheckItem[] = [];
  items.push({
    key: "primary", label: "Spec principal",
    level: opts.hasPrimary ? "ok" : "fail",
    hint: opts.hasPrimary ? "Arquivo primário presente." : "Sem spec primária — a fábrica não tem o que construir.",
  });
  // 🔴 GAP-133 — o item era inalcançável E a dica mentia sobre como alcançá-lo. Medido em prod
  // (NVX LastMile, 2026-09-09): `connect.yaml` marcado FAIL desde sempre, sem NENHUM finding da
  // validação pedindo o artefato — logo o laço nunca despacha ninguém para criá-lo. E as duas saídas
  // que a dica prometia não existem: o splitter tem `connect.yaml` em `_RESERVED_NAMES` (nunca batiza
  // uma peça assim) e "Resolver GAPs" só escreve em arquivo `.md` que JÁ está na árvore. Dizer ao Jean
  // "o split gera; ou crie via Resolver GAPs" era mandá-lo tentar dois caminhos fechados.
  const hasConnect = has(/^connect\.ya?ml$/);
  items.push({
    key: "connect", label: "connect.yaml (declaração Connect)",
    level: hasConnect ? "ok" : "fail",
    hint: hasConnect
      ? "Declaração Connect presente: interfaces, eventos, runtime, ambientes e health model."
      : "Falta o connect.yaml na raiz. Clique em \"Gerar\" ao lado: o ARQUITETO (LLM) lê a spec e declara interfaces, eventos, runtime, ambientes e health model — a identidade (systemId/serviceId/owners) vem do produto, não do modelo. O laço autônomo também gera ao terminar uma run. Sem a declaração a Fábrica ainda constrói, mas emite os manifests por heurística e MARCA como sintéticos — não é 'ready' para Genesis › Connect › Auto Care.",
  });
  const hasReadme = has(/^readme\.md$/);
  items.push({
    key: "readme", label: "README.md (manifesto/arquétipo)",
    level: hasReadme ? "ok" : "warn",
    hint: hasReadme ? "README com frontmatter do arquétipo presente." : "Recomendado: README.md com frontmatter (arquétipo, tipo) — o Stage A avisa sem ele.",
  });
  // 🔴 GAP-134 — o item media NOME, não FATO. A regra antiga só aceitava `docs/*.md` ou 5 nomes
  // exatos (`dominio-modelo|requisitos|contratos|infra-deploy|decisoes`), então o NVX LastMile — com
  // 13 arquivos temáticos na raiz (`modelo-dados.md`, `contratos-erros.md`, `infraestrutura-deploy.md`,
  // `privacidade-lgpd.md`…) — ficava AMARELO para sempre, e nenhuma rodada podia mudar isso: o nome
  // que a regra esperava não é o nome que o agente escolheu. Como dividir a spec e batizar cada peça é
  // decisão do AGENTE (Lei: Genesis é 100% LLM), exigir nome fixo aqui era automação fixa disfarçada.
  // O fato é a CONTAGEM: quantos `.md` existem além da primária e dos reservados.
  const tematicos = lower.filter((p) => p.endsWith(".md") && p !== primaria && !RESERVADOS_RE.test(p));
  const hasDocs = tematicos.length > 0;
  items.push({
    key: "docs", label: "Arquivos temáticos (domínio, contratos, infra)",
    level: hasDocs ? "ok" : "warn",
    hint: hasDocs
      ? `${tematicos.length} arquivo(s) temático(s) além da spec principal — o contractRef do Connect aponta para eles. O nome de cada peça é decisão do agente que dividiu a spec, não uma lista fixa.`
      : "Spec em UM arquivo só: nada além da primária. Dividir por tema (domínio, contratos, infra) é o que dá ao Connect um contractRef por assunto — quem escolhe o corte e os nomes é o agente (\"Dividir spec\" ou Resolver GAPs).",
  });
  if (opts.isEvolution) {
    const hasRfc = has(/^docs\/rfc\/rfc-\d{4}-[a-z0-9][a-z0-9-]*\.md$/);
    items.push({
      key: "rfc", label: "RFC de evolução (docs/rfc/RFC-NNNN-*.md)",
      level: hasRfc ? "ok" : "fail",
      hint: hasRfc ? "RFC presente — o gate exige Gherkin nos critérios e files_allowed no Impacto." : "Evolução sem RFC não promove (EVOLUTION_RFC_REQUIRED). Use \"Gerar RFC / CHANGELOG\" ou escreva a partir do modelo.",
    });
    const hasChangelog = has(/^changelog\.md$/);
    items.push({
      key: "changelog", label: "CHANGELOG.md (Unreleased)",
      level: hasChangelog ? "ok" : "warn",
      hint: hasChangelog ? "CHANGELOG presente — será versionado no aceite (SemVer pela compatibilidade do RFC)." : "Recomendado: CHANGELOG.md com `## [Unreleased]` — o aceite fecha a versão automaticamente.",
    });
  }
  return items;
}

const ICON: Record<Level, React.ReactNode> = {
  ok: <CheckCircleOutlineIcon sx={{ fontSize: 14 }} />,
  warn: <WarningAmberIcon sx={{ fontSize: 14 }} />,
  fail: <ErrorOutlineIcon sx={{ fontSize: 14 }} />,
};
const COLOR: Record<Level, "success" | "warning" | "error"> = { ok: "success", warn: "warning", fail: "error" };

/** Resposta de `POST /api/projects/:id/connect-declaration` — tudo que foi descartado vem DECLARADO. */
interface DeclResponse {
  ok: boolean; path: string; action: "created" | "updated";
  warnings?: string[]; truncated?: string[]; modelUsed?: string | null; interfaces?: number;
}

export default function ConnectReadyChecklist({ projectId, reloadSignal = 0, isEvolution = false, onGenerated }: {
  projectId: string; reloadSignal?: number; isEvolution?: boolean; onGenerated?: (path: string) => void;
}) {
  const [files, setFiles] = useState<TreeFile[] | null>(null);
  const [status, setStatus] = useState<string>("");
  // 🔴 GAP-133: o item deixa de ser pendência MUDA — daqui sai o pedido ao arquiteto. É síncrono
  // (a rota espera o LLM, nginx permite 300 s), então o botão precisa dizer que leva minutos.
  const [gerando, setGerando] = useState(false);
  const [declOut, setDeclOut] = useState<DeclResponse | null>(null);
  const [declErr, setDeclErr] = useState<string | null>(null);

  const gerarDeclaracao = async () => {
    setGerando(true); setDeclErr(null); setDeclOut(null);
    try {
      const r = await apiPost<DeclResponse>(`/api/projects/${projectId}/connect-declaration`, {});
      setDeclOut(r);
      onGenerated?.(r.path);
    } catch (e) {
      setDeclErr(e instanceof Error ? e.message : "Falha ao gerar a declaração Connect.");
    } finally { setGerando(false); }
  };
  useEffect(() => {
    let cancelled = false;
    apiGet<TreeResponse>(`/api/projects/${projectId}/spec-tree`)
      .then((t) => { if (!cancelled) { setFiles(t.files ?? []); setStatus(t.status ?? ""); } })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [projectId, reloadSignal]);

  const items = useMemo(() => {
    if (!files) return [];
    const raw = computeConnectChecklist(files.map((f) => f.path), {
      isEvolution,
      hasPrimary: files.some((f) => f.isPrimary),
      // GAP-134: sem saber QUEM é a primária, ela mesma contaria como "arquivo temático".
      primaryPath: files.find((f) => f.isPrimary)?.path ?? null,
    });
    // Spec legada já ACEITA: pendências viram recomendações (não há o que "promover" — evitar alarme vermelho).
    return status === "accepted" ? raw.map((i) => (i.level === "fail" ? { ...i, level: "warn" as Level } : i)) : raw;
  }, [files, isEvolution, status]);
  if (!files) return null;
  const fails = items.filter((i) => i.level === "fail").length;
  const warns = items.filter((i) => i.level === "warn").length;

  return (
    <Box sx={{ mb: 1, p: 1, border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
        <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>Connect-ready</Typography>
        <Chip size="small" variant="outlined"
          color={fails > 0 ? "error" : warns > 0 ? "warning" : "success"}
          label={fails > 0 ? `${fails} pendência${fails > 1 ? "s" : ""}` : warns > 0 ? `${warns} recomendaç${warns > 1 ? "ões" : "ão"}` : "pronta"}
          sx={{ height: 18, fontSize: "0.65rem" }} />
      </Stack>
      <Stack spacing={0.25}>
        {items.map((it) => (
          <Stack key={it.key} direction="row" spacing={0.5} alignItems="center">
            <Tooltip title={it.hint} placement="right">
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ color: `${COLOR[it.level]}.main`, cursor: "help", minWidth: 0 }}>
                {ICON[it.level]}
                <Typography variant="caption" sx={{ color: "text.primary", fontSize: "0.7rem", lineHeight: 1.3 }}>{it.label}</Typography>
              </Stack>
            </Tooltip>
            {it.key === "connect" && it.level !== "ok" && (
              <Tooltip title="Pede ao arquiteto (LLM) a declaração Connect a partir da spec. Leva de 30 s a 2 min e grava `connect.yaml` na raiz.">
                <span>
                  <Button size="small" variant="outlined" onClick={() => void gerarDeclaracao()} disabled={gerando}
                    startIcon={gerando ? <CircularProgress size={10} /> : undefined}
                    sx={{ py: 0, px: 0.75, minWidth: 0, fontSize: "0.62rem", lineHeight: 1.4 }}>
                    {gerando ? "gerando…" : "Gerar"}
                  </Button>
                </span>
              </Tooltip>
            )}
          </Stack>
        ))}
      </Stack>
      {/* O corte e o descarte são DITOS: identidade imposta, campo fora do vocabulário, spec truncada. */}
      {declErr && <Alert severity="error" sx={{ mt: 0.75, py: 0, fontSize: "0.68rem" }}>{declErr}</Alert>}
      {declOut && (
        <Alert severity={(declOut.warnings?.length ?? 0) + (declOut.truncated?.length ?? 0) > 0 ? "warning" : "success"}
          sx={{ mt: 0.75, py: 0, fontSize: "0.68rem" }}>
          <Typography variant="caption" sx={{ display: "block", fontWeight: 700 }}>
            {declOut.action === "created" ? "connect.yaml criado" : "connect.yaml atualizado"}
            {typeof declOut.interfaces === "number" ? ` — ${declOut.interfaces} interface(s)` : ""}
            {declOut.modelUsed ? ` · ${declOut.modelUsed}` : ""}
          </Typography>
          {[...(declOut.warnings ?? []), ...(declOut.truncated ?? [])].map((w, i) => (
            <Typography key={i} variant="caption" sx={{ display: "block", fontSize: "0.64rem", lineHeight: 1.35 }}>• {w}</Typography>
          ))}
        </Alert>
      )}
    </Box>
  );
}
