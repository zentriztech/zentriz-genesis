"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Link from "@mui/material/Link";
import { apiPostMultipart } from "@/lib/api";
import { projectsStore } from "@/stores/projectsStore";

const ACCEPT = ".md,.txt,.doc,.docx,.pdf";

type SubmitResponse = { projectId: string; status: string; message: string };

export default function SpecPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResponse | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFiles(e.target.files ?? null);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!files?.length) {
      setError("Selecione pelo menos um arquivo.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("title", title.trim() || "Spec sem título");
      for (let i = 0; i < files.length; i++) {
        formData.append("files", files[i]);
      }
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
        Envie um ou mais arquivos de especificação para iniciar o fluxo CTO → PM → Dev/QA/DevOps.
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
            Arquivo(s) de spec — pode enviar mais de um (ex.: principal + anexos)
          </Typography>
          <input
            accept={ACCEPT}
            type="file"
            multiple
            onChange={handleFileChange}
            style={{ display: "block", marginTop: 8 }}
          />
          {files?.length ? (
            <Typography variant="caption" display="block" sx={{ mt: 1 }}>
              {files.length} arquivo(s) selecionado(s): {Array.from(files).map((f) => f.name).join(", ")}
            </Typography>
          ) : null}
        </Box>
        <Button type="submit" variant="contained" sx={{ mt: 2 }} disabled={submitting}>
          {submitting ? "Enviando…" : "Enviar para o CTO"}
        </Button>
      </form>
    </Box>
  );
}
