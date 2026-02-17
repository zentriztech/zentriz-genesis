"use client";

import { observer } from "mobx-react-lite";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { notificationsStore } from "@/stores/notificationsStore";

function NotificationsPageInner() {
  return (
    <Box>
      <Typography variant="h4" gutterBottom>Notificações</Typography>
      <Button size="small" onClick={() => notificationsStore.markAllRead()} sx={{ mb: 2 }}>Marcar todas como lidas</Button>
      <List>
        {notificationsStore.list.map((n) => (
          <ListItem key={n.id} sx={{ bgcolor: n.read ? "transparent" : "action.hover" }}>
            <ListItemText primary={n.title} secondary={n.body} />
          </ListItem>
        ))}
      </List>
    </Box>
  );
}

export default observer(NotificationsPageInner);
