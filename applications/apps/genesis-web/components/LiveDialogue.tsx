"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import { motion, AnimatePresence } from "framer-motion";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Collapse from "@mui/material/Collapse";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { apiGet } from "@/lib/api";
import { getAgentProfile } from "@/lib/agentProfiles";

const MotionBox = motion(Box);

// ── Types ─────────────────────────────────────────────────────────────────────
export interface DialogueEntry {
  id: string;
  fromAgent: string;
  toAgent: string;
  eventType?: string;
  summaryHuman: string;
  requestId?: string;
  createdAt: string;
}

interface LiveDialogueProps {
  projectId: string;
  pollIntervalMs?: number;
  onEntriesLoaded?: (entries: DialogueEntry[]) => void;
  maxHeight?: number | string;
}

// ── Error block ───────────────────────────────────────────────────────────────
function parseErrorContent(text: string) {
  const idx = text.search(/\nTraceback /i);
  if (idx >= 0) return { message: text.slice(0, idx).trim(), stack: text.slice(idx).trim() };
  return { message: text, stack: "" };
}

function ErrorStack({ stack }: { stack: string }) {
  const [open, setOpen] = useState(false);
  if (!stack) return null;
  return (
    <Box sx={{ mt: 0.5 }}>
      <Button size="small" onClick={() => setOpen((o) => !o)} sx={{ textTransform: "none", px: 0, fontSize: "0.72rem" }}>
        {open ? "▲ Ocultar" : "▼ Mostrar"} traceback
      </Button>
      <Collapse in={open}>
        <Box
          component="pre"
          sx={{
            mt: 0.5, p: 1, bgcolor: "#EF444412", border: "1px solid #EF444430",
            borderRadius: 1, fontSize: "0.7rem", fontFamily: "monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto",
          }}
        >
          {stack}
        </Box>
      </Collapse>
    </Box>
  );
}

// ── Single entry ──────────────────────────────────────────────────────────────
function EntryBubble({ entry, isLast }: { entry: DialogueEntry; isLast: boolean }) {
  const from    = getAgentProfile(entry.fromAgent);
  const isStep  = entry.eventType === "step";
  const isError = entry.eventType === "error";
  const isWork  = entry.eventType === "agent_working";
  const { message: errMsg, stack: errStack } = isError ? parseErrorContent(entry.summaryHuman) : { message: "", stack: "" };

  const time = new Date(entry.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  if (isStep) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
        <Box sx={{ flex: 1, height: "1px", bgcolor: "divider" }} />
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap", px: 0.5 }}>
          {entry.summaryHuman}
        </Typography>
        <Box sx={{ flex: 1, height: "1px", bgcolor: "divider" }} />
      </Box>
    );
  }

  return (
    <MotionBox
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      sx={{ display: "flex", gap: 1.25, alignItems: "flex-start" }}
    >
      {/* Avatar */}
      <Avatar
        sx={{
          width: 32, height: 32, fontSize: "0.75rem", fontWeight: 700,
          bgcolor: from.color, flexShrink: 0, mt: 0.25,
          ...(isWork && isLast && {
            boxShadow: `0 0 0 2px ${from.color}44`,
            animation: "pulse 1.6s ease-in-out infinite",
            "@keyframes pulse": { "0%,100%": { boxShadow: `0 0 0 2px ${from.color}44` }, "50%": { boxShadow: `0 0 0 5px ${from.color}22` } },
          }),
        }}
      >
        {from.avatar}
      </Avatar>

      {/* Bubble */}
      <Box
        sx={{
          flexGrow: 1, minWidth: 0,
          bgcolor: isError ? "#EF444408" : isWork ? `${from.color}08` : "action.hover",
          border: "1px solid",
          borderColor: isError ? "#EF444430" : isWork ? `${from.color}22` : "divider",
          borderRadius: "4px 10px 10px 10px",
          px: 1.5, py: 1,
        }}
      >
        {/* Header */}
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.5 }}>
          <Typography variant="caption" fontWeight={600} sx={{ color: from.color }}>
            {from.name}
          </Typography>
          {entry.toAgent && entry.toAgent !== entry.fromAgent && (
            <Typography variant="caption" color="text.secondary">
              → {getAgentProfile(entry.toAgent).name}
            </Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="caption" color="text.secondary">{time}</Typography>
        </Stack>

        {/* Content */}
        {isError && errMsg ? (
          <>
            <Typography variant="body2" color="error" sx={{ fontSize: "0.78rem", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {errMsg}
            </Typography>
            <ErrorStack stack={errStack} />
          </>
        ) : (
          <Typography
            variant="body2"
            sx={{ fontSize: "0.8rem", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "text.primary", lineHeight: 1.6 }}
          >
            {entry.summaryHuman}
          </Typography>
        )}

        {/* "Thinking" dots for last agent_working entry */}
        {isWork && isLast && (
          <Stack direction="row" spacing={0.4} sx={{ mt: 0.75 }}>
            {[0, 1, 2].map((i) => (
              <Box
                key={i}
                sx={{
                  width: 4, height: 4, borderRadius: "50%", bgcolor: from.color,
                  animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                  "@keyframes bounce": { "0%,80%,100%": { transform: "scale(0.6)", opacity: 0.4 }, "40%": { transform: "scale(1)", opacity: 1 } },
                }}
              />
            ))}
          </Stack>
        )}
      </Box>
    </MotionBox>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
function LiveDialogueInner({ projectId, pollIntervalMs = 10000, onEntriesLoaded, maxHeight = 480 }: LiveDialogueProps) {
  const [entries, setEntries] = useState<DialogueEntry[]>([]);
  const [loading, setLoading]  = useState(true);
  const [error, setError]      = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const prevLen   = useRef(0);

  const fetch = useCallback(async () => {
    try {
      const data = await apiGet<DialogueEntry[]>(`/api/projects/${projectId}/dialogue`);
      const list  = Array.isArray(data) ? data : [];
      setEntries(list);
      setError(null);
      onEntriesLoaded?.(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar diálogo");
    } finally {
      setLoading(false);
    }
  }, [projectId, onEntriesLoaded]);

  useEffect(() => {
    fetch();
    if (pollIntervalMs > 0) {
      const t = setInterval(fetch, pollIntervalMs);
      return () => clearInterval(t);
    }
  }, [fetch, pollIntervalMs]);

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (entries.length > prevLen.current) {
      prevLen.current = entries.length;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries.length]);

  if (loading) {
    return (
      <Stack spacing={1} sx={{ p: 1 }}>
        {[1, 2, 3].map((i) => (
          <Box key={i} sx={{ height: 60, bgcolor: "action.hover", borderRadius: 1, animation: "shimmer 1.5s infinite", "@keyframes shimmer": { "0%,100%": { opacity: 0.6 }, "50%": { opacity: 1 } } }} />
        ))}
      </Stack>
    );
  }

  if (error) {
    return <Typography color="error" variant="body2" sx={{ p: 1 }}>{error}</Typography>;
  }

  if (entries.length === 0) {
    return (
      <Box sx={{ p: 3, textAlign: "center" }}>
        <Typography color="text.secondary" variant="body2">
          Aguardando início do diálogo entre agentes…
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        overflowY: "auto", maxHeight,
        px: 1.5, py: 1,
        display: "flex", flexDirection: "column", gap: 1,
        scrollbarWidth: "thin",
      }}
    >
      <AnimatePresence initial={false}>
        {entries.map((entry, i) => (
          <EntryBubble key={entry.id} entry={entry} isLast={i === entries.length - 1} />
        ))}
      </AnimatePresence>
      <div ref={bottomRef} />
    </Box>
  );
}

export const LiveDialogue = observer(LiveDialogueInner);
