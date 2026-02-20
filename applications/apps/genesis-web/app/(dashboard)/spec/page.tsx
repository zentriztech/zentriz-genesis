"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Link from "@mui/material/Link";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import { motion, AnimatePresence } from "framer-motion";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { apiPostMultipart } from "@/lib/api";
import { projectsStore } from "@/stores/projectsStore";

const ACCEPT = ".md,.txt,.doc,.docx,.pdf";

type SubmitResponse = { projectId: string; status: string; message: string };

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export default function SpecPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResponse | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files;
    if (chosen?.length) {
      setFiles((prev) => [...prev, ...Array.from(chosen)]);
      setError(null);
    }
    e.target.value = "";
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!files.length) {
      setError("Selecione pelo menos um arquivo.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("title", title.trim() || "Spec sem título");
      files.forEach((file) => formData.append("files", file));
      const data = await apiPostMultipart<SubmitResponse>("/api/specs", formData);
      setResult(data);
      projectsStore.loadProjects();
      if (data.projectId) {
        setTimeout(() => router.push(`/projects/${data.projectId}`), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao enviar spec.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Enviar spec ao CTO
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Envie um ou mais arquivos de especificação para iniciar o pipeline: Spec → CTO → Engineer → PM → Dev/QA/DevOps.
        Formatos aceitos: <strong>.md</strong> (preferencial), .txt, .doc, .docx, .pdf.
      </Typography>

      {result && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {result.message}
          {result.projectId && (
            <>
              {" "}
              <Link href={`/projects/${result.projectId}`} onClick={(e) => { e.preventDefault(); router.push(`/projects/${result.projectId}`); }}>
                Ver projeto
              </Link>
            </>
          )}
          {result.status === "pending_conversion" && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Arquivos não-.md serão convertidos para Markdown pelo orquestrador; o fluxo será iniciado em seguida.
            </Typography>
          )}
        </Alert>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <form onSubmit={handleSubmit}>
        <TextField
          fullWidth
          label="Título do projeto (opcional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          margin="normal"
          placeholder="Ex.: API Voucher"
        />
        <Box sx={{ mt: 2, mb: 2 }}>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Arquivo(s) de spec — adicione um ou mais (ex.: principal + anexos)
          </Typography>
          <Button
            component="label"
            variant="outlined"
            size="small"
            sx={{ mt: 1 }}
          >
            Adicionar arquivos
            <input
              ref={inputRef}
              accept={ACCEPT}
              type="file"
              multiple
              hidden
              onChange={handleFileChange}
            />
          </Button>
          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1.5} sx={{ mt: 2 }}>
            <AnimatePresence mode="popLayout">
              {files.map((file, index) => (
                <motion.div
                  key={`${file.name}-${index}`}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.2 }}
                >
                  <Card
                    variant="outlined"
                    sx={{
                      width: 220,
                      borderRadius: 2,
                      borderColor: "divider",
                      "&:hover": { borderColor: "primary.main", boxShadow: 1 },
                      transition: "border-color 0.2s, box-shadow 0.2s",
                    }}
                  >
                    <CardContent sx={{ py: 1.5, px: 1.5, "&:last-child": { pb: 1.5 } }}>
                      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}>
                        <InsertDriveFileOutlinedIcon
                          sx={{ color: "primary.main", fontSize: 28, mt: 0.25 }}
                        />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body2" noWrap title={file.name}>
                            {file.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {getFileExtension(file.name).toUpperCase()} · {formatFileSize(file.size)}
                          </Typography>
                        </Box>
                        <IconButton
                          size="small"
                          aria-label="Remover arquivo"
                          onClick={() => removeFile(index)}
                          sx={{ color: "text.secondary", "&:hover": { color: "error.main" } }}
                        >
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </Box>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </AnimatePresence>
          </Stack>
        </Box>
        <Button type="submit" variant="contained" sx={{ mt: 2 }} disabled={submitting || files.length === 0}>
          {submitting ? "Enviando…" : "Enviar para o CTO"}
        </Button>
      </form>
    </Box>
  );
}
