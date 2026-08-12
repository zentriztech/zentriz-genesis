"use client";

import { useEffect } from "react";
import { observer } from "mobx-react-lite";
import { useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import RefreshIcon from "@mui/icons-material/Refresh";
import { deadpoolStore } from "@/stores/deadpoolStore";

export default observer(function DeadpoolKnowledgePage() {
  const router = useRouter();

  useEffect(() => {
    void deadpoolStore.loadKnowledge();
  }, []);

  const { knowledge, knowledgeLoading, knowledgeError, knowledgeLoaded } = deadpoolStore;

  return (
    <Box sx={{ maxWidth: 960, mx: "auto", p: { xs: 2, md: 4 } }}>
      <Stack direction="row" alignItems="center" spacing={1.5} mb={3}>
        <Button startIcon={<ArrowBackIcon />} onClick={() => router.push("/deadpool")} size="small">
          Voltar
        </Button>
        <MenuBookIcon sx={{ color: "#EF4444", fontSize: 28 }} />
        <Typography variant="h5" fontWeight={700}>Base de conhecimento</Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Recarregar">
          <IconButton onClick={() => void deadpoolStore.loadKnowledge()}><RefreshIcon /></IconButton>
        </Tooltip>
      </Stack>

      {knowledgeError && <Alert severity="error" sx={{ mb: 3 }}>{knowledgeError}</Alert>}

      {knowledgeLoading && !knowledgeLoaded ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
          <CircularProgress />
        </Box>
      ) : knowledge.length === 0 ? (
        <Card variant="outlined"><CardContent>
          <Typography color="text.secondary">Nenhuma entrada de conhecimento disponível.</Typography>
        </CardContent></Card>
      ) : (
        <Stack spacing={2}>
          {knowledge.map((k, i) => (
            <Card key={i} variant="outlined">
              <CardContent>
                <Stack direction="row" alignItems="center" spacing={1} mb={0.5} flexWrap="wrap">
                  <Typography variant="subtitle1" fontWeight={700}>{k.title ?? "—"}</Typography>
                  {k.category && (
                    <Chip label={k.category} size="small" sx={{ bgcolor: "#EF444422", color: "#EF4444", fontWeight: 600 }} />
                  )}
                </Stack>
                {k.summary && (
                  <Typography variant="body2" color="text.secondary" mb={1}>{k.summary}</Typography>
                )}
                {k.recommended_action && (
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    <strong>Ação recomendada:</strong> {k.recommended_action}
                  </Typography>
                )}
                {Array.isArray(k.tags) && k.tags.length > 0 && (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {k.tags.map((t, ti) => (
                      <Chip key={ti} label={t} size="small" variant="outlined" />
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}
    </Box>
  );
});
