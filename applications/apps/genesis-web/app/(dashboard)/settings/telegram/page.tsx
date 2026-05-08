"use client";

import { useEffect, useState, useCallback } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import TelegramIcon from "@mui/icons-material/Telegram";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { apiGet, apiPost, apiDelete } from "@/lib/api";

const BOT_NAME = "@zgenezis_bot";

type TelegramStatus =
  | { linked: false }
  | { linked: true; username: string | null; linkedAt: string };

type LinkCodeResponse = {
  code: string;
  expiresAt: string;
  instruction: string;
  botName: string;
};

function LinkDialog({
  open,
  onClose,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [step, setStep]       = useState<"loading" | "ready" | "error">("loading");
  const [linkData, setLinkData] = useState<LinkCodeResponse | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [copied, setCopied]   = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep("loading");
    setError(null);
    apiPost<LinkCodeResponse>("/api/auth/telegram/link-code", {})
      .then((data) => { setLinkData(data); setStep("ready"); })
      .catch(() => { setError("Erro ao gerar código. Tente novamente."); setStep("error"); });
  }, [open]);

  // poll a cada 3s para detectar vinculação
  useEffect(() => {
    if (!open || step !== "ready") return;
    const interval = setInterval(async () => {
      try {
        const status = await apiGet<TelegramStatus>("/api/telegram/status");
        if (status.linked) { onLinked(); onClose(); }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [open, step, onLinked, onClose]);

  function copyInstruction() {
    if (!linkData) return;
    const msg = `/start ${linkData.code}`;
    navigator.clipboard.writeText(msg).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <TelegramIcon sx={{ color: "#229ED9" }} />
        Vincular Telegram
      </DialogTitle>
      <DialogContent>
        {step === "loading" && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {step === "error" && (
          <Alert severity="error">{error}</Alert>
        )}

        {step === "ready" && linkData && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <Typography color="text.secondary">
              Siga os passos abaixo para vincular sua conta Genesis ao Telegram:
            </Typography>

            <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              {/* Passo 1 */}
              <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
                <Box sx={{
                  minWidth: 28, height: 28, borderRadius: "50%",
                  bgcolor: "#229ED9", color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "0.85rem", fontWeight: 700, flexShrink: 0,
                }}>1</Box>
                <Box>
                  <Typography fontWeight={600}>Abra o Telegram</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Busque por <strong>{BOT_NAME}</strong> ou clique no link abaixo.
                  </Typography>
                  <Button
                    size="small"
                    variant="outlined"
                    href={`https://t.me/${BOT_NAME.replace("@", "")}`}
                    target="_blank"
                    sx={{ mt: 0.5, borderRadius: 2 }}
                  >
                    Abrir {BOT_NAME}
                  </Button>
                </Box>
              </Box>

              {/* Passo 2 */}
              <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
                <Box sx={{
                  minWidth: 28, height: 28, borderRadius: "50%",
                  bgcolor: "#229ED9", color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "0.85rem", fontWeight: 700, flexShrink: 0,
                }}>2</Box>
                <Box sx={{ flex: 1 }}>
                  <Typography fontWeight={600}>Envie o comando de vinculação</Typography>
                  <Box sx={{
                    mt: 1, p: 1.5, borderRadius: 2,
                    bgcolor: "#1e1e2e", fontFamily: "monospace",
                    fontSize: "1rem", letterSpacing: 1, color: "#e2e8f0",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                  }}>
                    <span>/start {linkData.code}</span>
                    <Button
                      size="small"
                      onClick={copyInstruction}
                      startIcon={<ContentCopyIcon fontSize="small" />}
                      sx={{ ml: 1, minWidth: 0, color: "#94a3b8", "&:hover": { color: "#e2e8f0" } }}
                    >
                      {copied ? "Copiado!" : "Copiar"}
                    </Button>
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    Código válido por 10 minutos. Aguardando confirmação...
                  </Typography>
                </Box>
              </Box>
            </Box>

            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <CircularProgress size={14} />
              <Typography variant="caption" color="text.secondary">
                Aguardando vinculação no Telegram...
              </Typography>
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} variant="outlined" sx={{ borderRadius: 2 }}>Cancelar</Button>
      </DialogActions>
    </Dialog>
  );
}

function UnlinkDialog({
  open,
  onClose,
  onUnlinked,
}: {
  open: boolean;
  onClose: () => void;
  onUnlinked: () => void;
}) {
  const [loading, setLoading] = useState(false);

  async function handleUnlink() {
    setLoading(true);
    try {
      await apiDelete("/api/auth/telegram/unlink");
      onUnlinked();
      onClose();
    } catch {
      // ignorar
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
      <DialogTitle>Revogar vinculação</DialogTitle>
      <DialogContent>
        <Typography>
          Ao revogar, você deixará de receber notificações no Telegram e não poderá
          mais usar os comandos do bot. Deseja continuar?
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} variant="outlined" sx={{ borderRadius: 2 }}>Cancelar</Button>
        <Button
          onClick={handleUnlink}
          variant="contained"
          color="error"
          disabled={loading}
          sx={{ borderRadius: 2 }}
        >
          {loading ? <CircularProgress size={18} /> : "Revogar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function TelegramSettingsPage() {
  const [status, setStatus]         = useState<TelegramStatus | null>(null);
  const [loading, setLoading]       = useState(true);
  const [linkOpen, setLinkOpen]     = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet<TelegramStatus>("/api/telegram/status");
      setStatus(data);
    } catch {
      setStatus({ linked: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 600 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 3 }}>
        <TelegramIcon sx={{ fontSize: 32, color: "#229ED9" }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>Telegram</Typography>
          <Typography variant="body2" color="text.secondary">
            Receba notificações e controle pipelines pelo {BOT_NAME}
          </Typography>
        </Box>
      </Box>

      <Card variant="outlined" sx={{ borderRadius: 3 }}>
        <CardContent sx={{ p: 3 }}>
          {status?.linked ? (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <CheckCircleIcon sx={{ color: "success.main", fontSize: 28 }} />
                <Box>
                  <Typography fontWeight={600}>Conta vinculada</Typography>
                  {status.username && (
                    <Typography variant="body2" color="text.secondary">
                      @{status.username}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    Vinculado em {new Date(status.linkedAt).toLocaleDateString("pt-BR")}
                  </Typography>
                </Box>
                <Chip label="Ativo" color="success" size="small" sx={{ ml: "auto" }} />
              </Box>

              <Divider />

              <Box>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
                  Notificações ativas
                </Typography>
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                  {["Pipeline concluído", "Projeto aceito", "Task BLOCKED", "Cyborg PASS/FAIL", "Pipeline parado"].map((n) => (
                    <Chip key={n} label={n} size="small" variant="outlined" />
                  ))}
                </Box>
              </Box>

              <Divider />

              <Box>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
                  Comandos disponíveis no bot
                </Typography>
                <Box component="pre" sx={{
                  bgcolor: "#1e1e2e", color: "#e2e8f0", borderRadius: 2, p: 1.5,
                  fontSize: "0.78rem", fontFamily: "monospace",
                  whiteSpace: "pre-wrap", m: 0,
                }}>
{`📋 Consultas
/list                — produtos e projetos com barra de progresso
/status              — todos os projetos (incluindo parados/falhos)
/status <id>         — detalhes: progresso, tasks, 2 últimas mensagens
/tasks <id>          — tasks pendentes (não-DONE)
/log <id>            — últimas 10 mensagens do diálogo

➕ Criação
/new product <desc>  — cria produto com projetos numerados
/new project <desc>  — cria projeto standalone
📎 Envie PDF/TXT/MD com caption "product" ou "project"

⚠️  Requerem confirmação (código 4 dígitos):
/run <id>            — iniciar pipeline
/stop <id>           — interromper pipeline com segurança
/accept <id>         — aceitar projeto finalizado
/reject <id>         — rejeitar projeto
/delete project:<id> — remover projeto do banco (arquivos mantidos)
/delete product:<id> — remover produto e filhos do banco (arquivos mantidos)

🔗 /unlink            — revogar vinculação Telegram`}
                </Box>
              </Box>

              <Button
                variant="outlined"
                color="error"
                startIcon={<LinkOffIcon />}
                onClick={() => setUnlinkOpen(true)}
                sx={{ alignSelf: "flex-start", borderRadius: 2 }}
              >
                Revogar vinculação
              </Button>
            </Box>
          ) : (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Typography color="text.secondary">
                Vincule sua conta para receber notificações em tempo real e controlar
                pipelines diretamente pelo Telegram, sem precisar abrir o portal.
              </Typography>
              <Button
                variant="contained"
                startIcon={<TelegramIcon />}
                onClick={() => setLinkOpen(true)}
                sx={{
                  alignSelf: "flex-start", borderRadius: 2,
                  bgcolor: "#229ED9", "&:hover": { bgcolor: "#1a8bbf" },
                }}
              >
                Vincular Telegram
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>

      <LinkDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        onLinked={() => { fetchStatus(); setLinkOpen(false); }}
      />
      <UnlinkDialog
        open={unlinkOpen}
        onClose={() => setUnlinkOpen(false)}
        onUnlinked={() => { setStatus({ linked: false }); setUnlinkOpen(false); }}
      />
    </Box>
  );
}
