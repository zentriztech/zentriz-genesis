"use client";

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";
import Avatar from "@mui/material/Avatar";
import Collapse from "@mui/material/Collapse";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import { apiGet } from "@/lib/api";
import { getAgentProfile } from "@/lib/agentProfiles";

/** Separa mensagem explicativa (fonte/API) do stack para exibir em destaque no portal. */
function parseErrorContent(fullText: string): { message: string; stack: string } {
  const traceStart =
    fullText.search(/\nTraceback \(stack\):?\s*\n/i) >= 0
      ? fullText.search(/\nTraceback \(stack\):?\s*\n/i)
      : fullText.search(/\nTraceback \(most recent call last\):?\s*\n/i);
  if (traceStart >= 0) {
    const message = fullText.slice(0, traceStart).trim();
    const stack = fullText.slice(traceStart).trim();
    return { message: message || fullText, stack };
  }
  const detalleMatch = fullText.match(/Detalhe:\s*([\s\S]+?)(?=\n\n|$)/);
  const apiMatch = fullText.match(/Claude API:\s*([\s\S]+?)(?=\n\n|$)/);
  const main = detalleMatch?.[1]?.trim() ?? apiMatch?.[1]?.trim() ?? fullText;
  return { message: main, stack: "" };
}

function ErrorStackBlock({ stack }: { stack: string }) {
  const [open, setOpen] = useState(false);
  if (!stack) return null;
  return (
    <Box sx={{ mt: 1 }}>
      <Button size="small" onClick={() => setOpen((o) => !o)} sx={{ textTransform: "none" }}>
        {open ? "Ocultar" : "Mostrar"} traceback (stack)
      </Button>
      <Collapse in={open}>
        <Box
          component="pre"
          sx={{
            mt: 0.5,
            p: 1,
            bgcolor: "action.hover",
            borderRadius: 1,
            fontSize: "0.75rem",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflow: "auto",
            maxHeight: 280,
          }}
        >
          {stack}
        </Box>
      </Collapse>
    </Box>
  );
}

export interface DialogueEntry {
  id: string;
  fromAgent: string;
  toAgent: string;
  eventType?: string;
  summaryHuman: string;
  requestId?: string;
  createdAt: string;
}

interface ProjectDialogueProps {
  projectId: string;
  pollIntervalMs?: number;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ProjectDialogueInner({ projectId, pollIntervalMs = 10000 }: ProjectDialogueProps) {
  const [entries, setEntries] = useState<DialogueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDialogue = useCallback(async () => {
    try {
      const data = await apiGet<DialogueEntry[]>(`/api/projects/${projectId}/dialogue`);
      setEntries(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar diálogo");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchDialogue();
    if (pollIntervalMs > 0) {
      const t = setInterval(fetchDialogue, pollIntervalMs);
      return () => clearInterval(t);
    }
  }, [fetchDialogue, pollIntervalMs]);

  if (loading) {
    return (
      <Typography color="text.secondary" variant="body2">
        Carregando diálogo…
      </Typography>
    );
  }
  if (error) {
    return (
      <Typography color="error" variant="body2">
        {error}
      </Typography>
    );
  }
  if (entries.length === 0) {
    return (
      <Typography color="text.secondary" variant="body2">
        Nenhuma mensagem no diálogo ainda. O diálogo será preenchido conforme os agentes conversarem.
      </Typography>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      {entries.map((entry) => {
        const fromProfile = getAgentProfile(entry.fromAgent);
        const isStep = entry.eventType === "step";
        const isError = entry.eventType === "error";
        const { message: errorMessage, stack: errorStack } = isError
          ? parseErrorContent(entry.summaryHuman)
          : { message: "", stack: "" };

        return (
          <Card
            key={entry.id}
            variant="outlined"
            sx={{
              overflow: "visible",
              borderLeft: isError ? "4px solid #c62828" : isStep ? "4px solid #546e7a" : undefined,
              bgcolor: isError ? "error.light" : isStep ? "action.hover" : undefined,
            }}
          >
            <CardContent sx={{ display: "flex", gap: 2, alignItems: "flex-start", py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Avatar
                sx={{
                  width: 40,
                  height: 40,
                  bgcolor: fromProfile.color,
                  fontSize: "1.25rem",
                }}
              >
                {fromProfile.avatar}
              </Avatar>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ color: fromProfile.color }}>
                  {fromProfile.name}
                  {entry.toAgent && entry.toAgent !== entry.fromAgent && (
                    <>
                      {" → "}
                      <Typography component="span" variant="body2" color="text.secondary">
                        {getAgentProfile(entry.toAgent).name}
                      </Typography>
                    </>
                  )}
                </Typography>
                {isError && errorMessage ? (
                  <>
                    <Alert severity="error" sx={{ mt: 0.5 }} variant="outlined">
                      <AlertTitle>[FONTE — Mensagem da API / erro]</AlertTitle>
                      <Typography component="span" variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {errorMessage}
                      </Typography>
                    </Alert>
                    {errorStack && (
                      <ErrorStackBlock stack={errorStack} />
                    )}
                  </>
                ) : (
                  <Typography
                    variant="body2"
                    sx={{
                      mt: 0.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: isError ? "monospace" : undefined,
                      fontSize: isError ? "0.8rem" : undefined,
                    }}
                  >
                    {entry.summaryHuman}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
                  {formatTime(entry.createdAt)}
                </Typography>
              </Box>
            </CardContent>
          </Card>
        );
      })}
    </Box>
  );
}

export const ProjectDialogue = observer(ProjectDialogueInner);
