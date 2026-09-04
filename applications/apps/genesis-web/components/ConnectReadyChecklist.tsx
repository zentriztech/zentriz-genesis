"use client";
/**
 * ConnectReadyChecklist — item 2 (extras de UI): checklist "Connect-ready" da spec no editor da Bancada.
 * Deriva do `spec-tree` (mesmo endpoint da árvore) o que a spec JÁ TEM e o que falta para chegar à
 * fábrica no padrão Genesis › Connect › Auto Care: spec primária, `connect.yaml` (declaração Connect),
 * `README.md` (manifesto/arquétipo), docs temáticos; em EVOLUÇÃO: `docs/rfc/RFC-NNNN-*.md` e `CHANGELOG.md`.
 * Só leitura e determinístico (sem LLM). A validação adversarial (aba GAPs) continua sendo o gate.
 */
import { useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { apiGet } from "@/lib/api";

interface TreeFile { path: string; ext: string; isPrimary: boolean }
interface TreeResponse { files: TreeFile[]; status?: string }

type Level = "ok" | "warn" | "fail";
export interface CheckItem { key: string; label: string; level: Level; hint: string }

/** Regras puras (testáveis): paths relativos da árvore → itens do checklist. */
export function computeConnectChecklist(paths: string[], opts: { isEvolution: boolean; hasPrimary: boolean }): CheckItem[] {
  const lower = paths.map((p) => p.replace(/^\/+/, "").toLowerCase());
  const has = (re: RegExp) => lower.some((p) => re.test(p));
  const items: CheckItem[] = [];
  items.push({
    key: "primary", label: "Spec principal",
    level: opts.hasPrimary ? "ok" : "fail",
    hint: opts.hasPrimary ? "Arquivo primário presente." : "Sem spec primária — a fábrica não tem o que construir.",
  });
  const hasConnect = has(/^connect\.ya?ml$/);
  items.push({
    key: "connect", label: "connect.yaml (declaração Connect)",
    level: hasConnect ? "ok" : "fail",
    hint: hasConnect
      ? "Declaração Connect presente: interfaces, eventos, runtime, ambientes e health model."
      : "Falta o connect.yaml na raiz — é o que torna a spec 'ready' para Genesis › Connect › Auto Care (o split gera; ou crie via Resolver GAPs).",
  });
  const hasReadme = has(/^readme\.md$/);
  items.push({
    key: "readme", label: "README.md (manifesto/arquétipo)",
    level: hasReadme ? "ok" : "warn",
    hint: hasReadme ? "README com frontmatter do arquétipo presente." : "Recomendado: README.md com frontmatter (arquétipo, tipo) — o Stage A avisa sem ele.",
  });
  const hasDocs = has(/^docs\/(?!rfc\/|adr\/)[^/]+\.md$/) || has(/^(dominio-modelo|requisitos|contratos|infra-deploy|decisoes)\.md$/);
  items.push({
    key: "docs", label: "Arquivos temáticos (domínio, contratos, infra)",
    level: hasDocs ? "ok" : "warn",
    hint: hasDocs ? "Há arquivos temáticos além da spec principal." : "Recomendado: contratos.md (OpenAPI/AsyncAPI mínimo), dominio-modelo.md, infra-deploy.md — o contractRef do Connect aponta para eles.",
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

export default function ConnectReadyChecklist({ projectId, reloadSignal = 0, isEvolution = false }: {
  projectId: string; reloadSignal?: number; isEvolution?: boolean;
}) {
  const [files, setFiles] = useState<TreeFile[] | null>(null);
  const [status, setStatus] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    apiGet<TreeResponse>(`/api/projects/${projectId}/spec-tree`)
      .then((t) => { if (!cancelled) { setFiles(t.files ?? []); setStatus(t.status ?? ""); } })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [projectId, reloadSignal]);

  const items = useMemo(() => {
    if (!files) return [];
    const raw = computeConnectChecklist(files.map((f) => f.path), { isEvolution, hasPrimary: files.some((f) => f.isPrimary) });
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
          <Tooltip key={it.key} title={it.hint} placement="right">
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ color: `${COLOR[it.level]}.main`, cursor: "help" }}>
              {ICON[it.level]}
              <Typography variant="caption" sx={{ color: "text.primary", fontSize: "0.7rem", lineHeight: 1.3 }}>{it.label}</Typography>
            </Stack>
          </Tooltip>
        ))}
      </Stack>
    </Box>
  );
}
