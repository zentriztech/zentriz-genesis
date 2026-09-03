"use client";

// Editor da PASTA do produto (redesign Bancada Onda 2). Aberto ao clicar num card de
// produto na Bancada (/specs). Mostra os arquivos de spec de TODOS os projetos do produto
// numa árvore estilo VSCode (como a aba "Código" da fábrica, mas por-produto e editável).
// Fonte: GET /api/products/:id/spec-tree (índice); conteúdo por-arquivo via /spec-file.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import { apiGet } from "@/lib/api";
import { authStore } from "@/stores/authStore";
import { ProductSpecExplorer, type ProductSpecProject } from "@/components/ProductSpecExplorer";

interface ProductSpecTree {
  productId: string;
  productName: string;
  isInbox: boolean;
  projects: ProductSpecProject[];
  totalFiles: number;
  truncated: boolean;
}

export default function ProductSpecPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const productId = params?.id;
  const [data, setData] = useState<ProductSpecTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await apiGet<ProductSpecTree>(`/api/products/${productId}/spec-tree`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar a pasta do produto");
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => { load(); }, [load]);

  const projectCount = data?.projects.length ?? 0;

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2, flexWrap: "wrap", rowGap: 1 }}>
        <Button size="small" variant="text" startIcon={<ArrowBackIcon />} onClick={() => router.push("/specs")}
          sx={{ textTransform: "none" }}>
          Bancada
        </Button>
        <Inventory2OutlinedIcon sx={{ color: "#8B5CF6" }} />
        <Box sx={{ flexGrow: 1, minWidth: 200 }}>
          <Typography variant="h6" fontWeight={700}>
            {data?.productName ?? "Pasta do produto"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Edite os arquivos de spec do produto inteiro — cada projeto é uma pasta. Salvamento por
            arquivo com verificação de concorrência; projetos já em fábrica ficam somente leitura.
          </Typography>
        </Box>
        {data && (
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip size="small" variant="outlined" label={`${projectCount} projeto(s)`} sx={{ fontSize: "0.65rem", height: 20 }} />
            <Chip size="small" variant="outlined" label={`${data.totalFiles} arquivo(s)`} sx={{ fontSize: "0.65rem", height: 20 }} />
            <Button size="small" variant="outlined" startIcon={<AccountTreeOutlinedIcon sx={{ fontSize: "0.9rem" }} />}
              onClick={() => router.push(`/projects?product=${productId}`)} sx={{ textTransform: "none" }}>
              Ver na fábrica
            </Button>
          </Stack>
        )}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}><CircularProgress size={28} /></Box>
      ) : data && data.totalFiles === 0 ? (
        <Alert severity="info">
          Este produto ainda não tem arquivos de spec. Crie ou envie uma SPEC na Bancada e vincule-a a este produto.
        </Alert>
      ) : data ? (
        <ProductSpecExplorer
          projects={data.projects}
          truncated={data.truncated}
          totalFiles={data.totalFiles}
          readOnly={authStore.isZentrizAdmin}
        />
      ) : null}
    </Box>
  );
}
