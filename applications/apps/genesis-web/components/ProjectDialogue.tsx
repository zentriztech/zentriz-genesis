"use client";

import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";
import Avatar from "@mui/material/Avatar";
import { apiGet } from "@/lib/api";
import { getAgentProfile } from "@/lib/agentProfiles";

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

  const fetchDialogue = async () => {
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
  };

  useEffect(() => {
    fetchDialogue();
    if (pollIntervalMs > 0) {
      const t = setInterval(fetchDialogue, pollIntervalMs);
      return () => clearInterval(t);
    }
  }, [projectId, pollIntervalMs]);

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
