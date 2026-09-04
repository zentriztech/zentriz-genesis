"use client";
/**
 * /spec-questions — item 2 (extras de UI): fila de PERGUNTAS DA FÁBRICA (D3 `needs_spec_input`).
 * Lista as perguntas abertas de todos os projetos do tenant (GET /api/spec-questions) e leva ao projeto,
 * onde o SpecQuestionsPanel responde (só tenant_admin/owner). Perguntas sem resposta em 72h escalam.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import RefreshIcon from "@mui/icons-material/Refresh";
import QuestionAnswerIcon from "@mui/icons-material/QuestionAnswer";
import { apiGet } from "@/lib/api";
import { authStore } from "@/stores/authStore";

interface OpenQuestion {
  id: string;
  projectId: string;
  projectTitle: string;
  productId: string | null;
  round: number;
  stage: string | null;
  questions: unknown;
  createdAt: string;
  escalatedAt: string | null;
}

function questionLines(q: unknown): string[] {
  if (Array.isArray(q)) return q.map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "text" in x ? String((x as { text: unknown }).text) : JSON.stringify(x))).filter(Boolean);
  if (typeof q === "string") return [q];
  if (q && typeof q === "object") {
    const o = q as Record<string, unknown>;
    if (Array.isArray(o.questions)) return questionLines(o.questions);
    if (typeof o.text === "string") return [o.text];
  }
  return [];
}

function ageLabel(iso: string): string {
  const h = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (h < 1) return "agora";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default function SpecQuestionsQueuePage() {
  const [items, setItems] = useState<OpenQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await apiGet<{ questions: OpenQuestion[] }>("/api/spec-questions?limit=200");
      setItems(r.questions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar as perguntas");
      setItems([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <Box sx={{ p: { xs: 1.5, md: 3 }, maxWidth: 1000 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Perguntas da fábrica</Typography>
          <Typography variant="body2" color="text.secondary">
            Projetos parados em <code>needs_spec_input</code>: a fábrica achou a spec insuficiente e perguntou. Responda no projeto para retomar do checkpoint.
          </Typography>
        </Box>
        <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => void load()}>Atualizar</Button>
      </Stack>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {items === null ? (
        <Box sx={{ p: 4, textAlign: "center" }}><CircularProgress size={22} /></Box>
      ) : items.length === 0 ? (
        <Alert severity="success" icon={<QuestionAnswerIcon />}>Nenhuma pergunta em aberto — a fábrica não está esperando por ninguém.</Alert>
      ) : (
        <Stack spacing={1.5}>
          {items.map((q) => {
            const lines = questionLines(q.questions);
            const stale = Date.now() - new Date(q.createdAt).getTime() > 48 * 3_600_000;
            return (
              <Card key={q.id} variant="outlined" sx={{ borderColor: q.escalatedAt ? "error.main" : stale ? "warning.main" : "divider" }}>
                <CardContent sx={{ pb: "12px !important" }}>
                  <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} spacing={1} sx={{ mb: 1 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                      <Link href={`/projects/${q.projectId}`}>{q.projectTitle}</Link>
                    </Typography>
                    <Stack direction="row" spacing={0.75}>
                      <Chip size="small" variant="outlined" label={`rodada ${q.round}`} />
                      {q.stage && <Chip size="small" variant="outlined" label={q.stage} />}
                      <Chip size="small" color={q.escalatedAt ? "error" : stale ? "warning" : "default"} label={q.escalatedAt ? "escalada" : `há ${ageLabel(q.createdAt)}`} />
                    </Stack>
                  </Stack>
                  {lines.length ? (
                    <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
                      {lines.slice(0, 6).map((l, i) => <li key={i}><Typography variant="body2">{l}</Typography></li>)}
                      {lines.length > 6 && <Typography variant="caption" color="text.secondary">+{lines.length - 6} pergunta(s)</Typography>}
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary">(perguntas no projeto)</Typography>
                  )}
                  <Box sx={{ mt: 1.25, textAlign: "right" }}>
                    {/* zentriz_admin é conta de gestão: vê a fila de todos os tenants, mas não responde (403 no /answer). */}
                    <Button component={Link} href={`/projects/${q.projectId}`} size="small" variant="contained">
                      {authStore.user?.role === "zentriz_admin" ? "Ver projeto" : "Responder no projeto"}
                    </Button>
                  </Box>
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
