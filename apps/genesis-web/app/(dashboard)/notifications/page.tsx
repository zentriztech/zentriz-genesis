"use client";

import { observer } from "mobx-react-lite";
import { motion } from "framer-motion";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { notificationsStore } from "@/stores/notificationsStore";

const itemMotion = {
  initial: { opacity: 0, x: -8 },
  animate: (i: number) => ({ opacity: 1, x: 0, transition: { delay: i * 0.05 } }),
};

const MotionListItem = motion(ListItem);

function NotificationsPageInner() {
  return (
    <Box>
      <Typography variant="h4" gutterBottom>Notificações</Typography>
      <Button size="small" onClick={() => notificationsStore.markAllRead()} sx={{ mb: 2 }}>Marcar todas como lidas</Button>
      <List>
        {notificationsStore.list.map((n, i) => (
          <MotionListItem
            key={n.id}
            initial="initial"
            animate="animate"
            variants={itemMotion}
            custom={i}
            sx={{ bgcolor: n.read ? "transparent" : "action.hover" }}
          >
            <ListItemText primary={n.title} secondary={n.body} />
          </MotionListItem>
        ))}
      </List>
    </Box>
  );
}

export default observer(NotificationsPageInner);
