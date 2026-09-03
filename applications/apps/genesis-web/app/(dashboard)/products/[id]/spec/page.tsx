"use client";

// Pivô Bancada (Opção 1): a tela dedicada /products/:id/spec virou REDUNDANTE — o editor
// da pasta do produto agora vive no próprio /spec (árvore "Pasta do produto" ao lado do
// editor + chat de IA + Validação/GAPs, dirigida pela árvore). Esta rota apenas RESOLVE o
// projeto representativo do produto e REDIRECIONA para /spec?editProjectId=…&productId=…
// (mantém links/bookmarks antigos vivos). Fonte: GET /api/products/:id/spec-tree.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { apiGet } from "@/lib/api";
import type { ProductSpecProject } from "@/components/ProductSpecExplorer";

interface ProductSpecTree {
  productId: string;
  productName: string;
  isInbox: boolean;
  projects: ProductSpecProject[];
  totalFiles: number;
  truncated: boolean;
}

// Projeto representativo do produto p/ abrir o editor: o que tem o arquivo primário;
// senão o primeiro projeto. (Em prod cada projeto tem 1 arquivo, então basta o 1º.)
function pickPrimaryProjectId(projects: ProductSpecProject[]): string | null {
  const withPrimaryFile = projects.find((p) => p.files.some((f) => f.isPrimary));
  return (withPrimaryFile ?? projects[0])?.projectId ?? null;
}

export default function ProductSpecRedirectPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const productId = params?.id;
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    if (!productId) return;
    let alive = true;
    apiGet<ProductSpecTree>(`/api/products/${productId}/spec-tree`)
      .then((tree) => {
        if (!alive) return;
        const proj = pickPrimaryProjectId(tree.projects ?? []);
        if (proj) router.replace(`/spec?editProjectId=${proj}&productId=${productId}`);
        else setEmpty(true);
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Falha ao abrir a pasta do produto"); });
    return () => { alive = false; };
  }, [productId, router]);

  if (error) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
        <Button variant="outlined" onClick={() => router.push("/specs")}>Voltar à Bancada</Button>
      </Box>
    );
  }

  if (empty) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info" sx={{ mb: 2 }}>
          Este produto ainda não tem specs. Crie ou envie uma SPEC na Bancada e vincule-a a este produto.
        </Alert>
        <Button variant="outlined" onClick={() => router.push("/specs")}>Voltar à Bancada</Button>
      </Box>
    );
  }

  return (
    <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ py: 10 }}>
      <CircularProgress size={28} />
      <Typography variant="body2" color="text.secondary">Abrindo a pasta do produto…</Typography>
    </Stack>
  );
}
