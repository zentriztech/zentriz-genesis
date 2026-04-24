"use client";

import { useEffect } from "react";
import { observer } from "mobx-react-lite";
import { motion } from "framer-motion";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DeleteIcon from "@mui/icons-material/Delete";
import { notificationsStore } from "@/stores/notificationsStore";

const itemMotion = {
  initial: { opacity: 0, x: -8 },
  animate: (i: number) => ({ opacity: 1, x: 0, transition: { delay: i * 0.05 } }),
};

const MotionListItem = motion(ListItem);

const NotificationsPage = observer(function NotificationsPage() {
  useEffect(() => {
    notificationsStore.startPolling();
    return () => notificationsStore.stopPolling();
  }, []);

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Notificações
      </Typography>

      {notificationsStore.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {notificationsStore.error}
        </Alert>
      )}

      <Button
        size="small"
        onClick={() => notificationsStore.markAllRead()}
        disabled={notificationsStore.unreadCount === 0}
        sx={{ mb: 2 }}
      >
        Marcar todas como lidas
      </Button>

      {notificationsStore.loading && notificationsStore.list.length === 0 ? (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
          <CircularProgress />
        </Box>
      ) : notificationsStore.list.length === 0 ? (
        <Typography color="text.secondary">Nenhuma notificação.</Typography>
      ) : (
        <List>
          {notificationsStore.list.map((n, i) => (
            <MotionListItem
              key={n.id}
              initial="initial"
              animate="animate"
              variants={itemMotion}
              custom={i}
              sx={{
                bgcolor: n.read ? "transparent" : "action.hover",
                borderRadius: 1,
                mb: 0.5,
                cursor: n.read ? "default" : "pointer",
              }}
              onClick={() => {
                if (!n.read) notificationsStore.markRead(n.id);
              }}
              secondaryAction={
                <Tooltip title="Remover">
                  <IconButton
                    edge="end"
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      notificationsStore.remove(n.id);
                    }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              }
            >
              <ListItemText
                primary={n.title}
                secondary={n.body || new Date(n.createdAt).toLocaleString("pt-BR")}
              />
            </MotionListItem>
          ))}
        </List>
      )}
    </Box>
  );
});

export default NotificationsPage;
