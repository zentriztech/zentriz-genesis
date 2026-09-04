"use client";

import { useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react-lite";
import { motion } from "framer-motion";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import DeleteIcon from "@mui/icons-material/Delete";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CampaignIcon from "@mui/icons-material/Campaign";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";
import QuestionAnswerIcon from "@mui/icons-material/QuestionAnswer";
import type { Notification } from "@/types";
import { notificationsStore } from "@/stores/notificationsStore";

// ── Metadados por tipo: ícone, cor e rótulo ──────────────────────────────────
type NotifType = Notification["type"];

const TYPE_META: Record<NotifType, { label: string; color: string; icon: React.ReactNode }> = {
  project_finished:  { label: "Concluído",    color: "#22C55E", icon: <CheckCircleOutlineIcon /> },
  provisioning_done: { label: "Provisionado", color: "#0EA5E9", icon: <RocketLaunchIcon /> },
  blocked:           { label: "Bloqueio",     color: "#F59E0B", icon: <WarningAmberIcon /> },
  alert:             { label: "Alerta",       color: "#EF4444", icon: <CampaignIcon /> },
  // D3: a fábrica parou com perguntas para o humano (needs_spec_input) — responder no projeto.
  spec_question:     { label: "Pergunta da fábrica", color: "#8B5CF6", icon: <QuestionAnswerIcon /> },
};

const FALLBACK_META = { label: "Notificação", color: "#6366F1", icon: <NotificationsNoneIcon /> };

function metaFor(type: string) {
  return TYPE_META[type as NotifType] ?? FALLBACK_META;
}

// ── Agrupamento por data (Hoje / Ontem / Últimos 7 dias / Anteriores) ─────────
function dateBucket(iso: string, now: Date): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return "Hoje";
  if (days === 1) return "Ontem";
  if (days <= 7) return "Últimos 7 dias";
  return "Anteriores";
}

const BUCKET_ORDER = ["Hoje", "Ontem", "Últimos 7 dias", "Anteriores"];

// Tempo relativo curto em pt-BR ("há 5 min", "há 2 h", "há 3 d").
function relativeTime(iso: string, now: Date): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `há ${days} d`;
  return new Date(iso).toLocaleDateString("pt-BR");
}

const itemMotion = {
  initial: { opacity: 0, x: -8 },
  animate: (i: number) => ({ opacity: 1, x: 0, transition: { delay: Math.min(i, 8) * 0.04 } }),
};

const MotionPaper = motion(Paper);

function NotificationRow({ n, index, now }: { n: Notification; index: number; now: Date }) {
  const meta = metaFor(n.type);
  return (
    <MotionPaper
      variant="outlined"
      initial="initial"
      animate="animate"
      variants={itemMotion}
      custom={index}
      onClick={() => { if (!n.read) notificationsStore.markRead(n.id); }}
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 1.5,
        p: 1.5,
        borderRadius: 2,
        borderLeft: `3px solid ${meta.color}`,
        bgcolor: n.read ? "transparent" : alpha(meta.color, 0.06),
        cursor: n.read ? "default" : "pointer",
        transition: "background-color 0.15s, box-shadow 0.15s",
        "&:hover": { boxShadow: 2 },
      }}
    >
      <Avatar
        variant="rounded"
        sx={{
          bgcolor: alpha(meta.color, 0.15),
          color: meta.color,
          width: 38, height: 38,
          "& svg": { fontSize: "1.25rem" },
        }}
      >
        {meta.icon}
      </Avatar>

      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle2" sx={{ fontWeight: n.read ? 500 : 700, lineHeight: 1.3 }}>
            {n.title}
          </Typography>
          <Chip
            label={meta.label}
            size="small"
            sx={{
              height: 18, fontSize: "0.62rem", fontWeight: 700,
              bgcolor: alpha(meta.color, 0.15), color: meta.color,
            }}
          />
          {!n.read && (
            <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: meta.color, flexShrink: 0 }} />
          )}
        </Stack>
        {n.body && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {n.body}
          </Typography>
        )}
        <Typography variant="caption" color="text.disabled" sx={{ display: "block", mt: 0.5 }}>
          {relativeTime(n.createdAt, now)}
        </Typography>
      </Box>

      <Tooltip title="Remover">
        <IconButton
          size="small"
          onClick={(e) => { e.stopPropagation(); notificationsStore.remove(n.id); }}
          sx={{ flexShrink: 0 }}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </MotionPaper>
  );
}

const NotificationsPage = observer(function NotificationsPage() {
  const [filter, setFilter] = useState<NotifType | "all">("all");

  useEffect(() => {
    notificationsStore.startPolling();
    return () => notificationsStore.stopPolling();
  }, []);

  const all = notificationsStore.list;

  // Contagem por tipo (para os chips de filtro) — só tipos presentes viram chip.
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of all) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return counts;
  }, [all]);

  const filtered = filter === "all" ? all : all.filter((n) => n.type === filter);

  // Agrupa por data preservando a ordem (a lista já vem mais recente primeiro).
  const grouped = useMemo(() => {
    const now = new Date();
    const map = new Map<string, Notification[]>();
    for (const n of filtered) {
      const bucket = dateBucket(n.createdAt, now);
      if (!map.has(bucket)) map.set(bucket, []);
      map.get(bucket)!.push(n);
    }
    return { now, buckets: BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ b, items: map.get(b)! })) };
  }, [filtered]);

  const unread = notificationsStore.unreadCount;

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2, rowGap: 1 }}>
        <Box>
          <Typography variant="h4">Notificações</Typography>
          <Typography variant="body2" color="text.secondary">
            {all.length} no total{unread > 0 ? ` · ${unread} não lida${unread !== 1 ? "s" : ""}` : " · tudo lido"}
          </Typography>
        </Box>
        <Button
          size="small"
          variant="outlined"
          startIcon={<DoneAllIcon />}
          onClick={() => notificationsStore.markAllRead()}
          disabled={unread === 0}
        >
          Marcar todas como lidas
        </Button>
      </Stack>

      {notificationsStore.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {notificationsStore.error}
        </Alert>
      )}

      {/* Filtros por tipo — só aparecem tipos presentes */}
      {all.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <Chip
            label={`Todas · ${all.length}`}
            size="small"
            color={filter === "all" ? "primary" : "default"}
            variant={filter === "all" ? "filled" : "outlined"}
            onClick={() => setFilter("all")}
          />
          {(Object.keys(TYPE_META) as NotifType[])
            .filter((t) => typeCounts.has(t))
            .map((t) => {
              const meta = TYPE_META[t];
              const active = filter === t;
              return (
                <Chip
                  key={t}
                  label={`${meta.label} · ${typeCounts.get(t)}`}
                  size="small"
                  onClick={() => setFilter(active ? "all" : t)}
                  variant={active ? "filled" : "outlined"}
                  sx={{
                    fontWeight: 600,
                    ...(active
                      ? { bgcolor: meta.color, color: "#fff", "&:hover": { bgcolor: meta.color } }
                      : { borderColor: alpha(meta.color, 0.5), color: meta.color }),
                  }}
                />
              );
            })}
        </Stack>
      )}

      {notificationsStore.loading && all.length === 0 ? (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 6 }}>
          <CircularProgress />
        </Box>
      ) : filtered.length === 0 ? (
        <Paper variant="outlined" sx={{ textAlign: "center", py: 6, borderRadius: 2 }}>
          <NotificationsNoneIcon sx={{ fontSize: 40, color: "text.disabled", mb: 1 }} />
          <Typography color="text.secondary">
            {all.length === 0 ? "Nenhuma notificação por aqui." : "Nenhuma notificação neste filtro."}
          </Typography>
        </Paper>
      ) : (
        <Stack spacing={2.5}>
          {grouped.buckets.map(({ b, items }) => (
            <Box key={b}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: "block", mb: 1, letterSpacing: "0.08em" }}
              >
                {b}
              </Typography>
              <Stack spacing={1}>
                {items.map((n, i) => (
                  <NotificationRow key={n.id} n={n} index={i} now={grouped.now} />
                ))}
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
});

export default NotificationsPage;
