"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormControl from "@mui/material/FormControl";
import { motion } from "framer-motion";
import { apiGet, apiPost } from "@/lib/api";

type Plan = {
  id: string;
  name: string;
  slug: string;
  maxProjects: number;
  maxUsersPerTenant: number;
};

type SignupResponse = {
  message: string;
  tenant: { id: string; name: string; planId: string; status: string; createdAt: string };
};

const cardMotion = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35 },
};

export default function TenantSignupPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [tenantName, setTenantName] = useState("");
  const [planId, setPlanId] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SignupResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<Plan[]>("/api/plans")
      .then((data) => {
        if (!cancelled) {
          setPlans(data);
          if (data.length > 0 && !planId) setPlanId(data[0].id);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Não foi possível carregar os planos.");
      })
      .finally(() => {
        if (!cancelled) setLoadingPlans(false);
      });
    return () => { cancelled = true; };
  }, [planId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const data = await apiPost<SignupResponse>("/api/tenant/signup", {
        name: tenantName,
        planId,
        adminName,
        adminEmail,
        password,
      });
      setSuccess(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao cadastrar.");
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0d47a1 0%, #1565c0 50%, #1976d2 100%)",
          py: 3,
          px: 2,
        }}
      >
        <motion.div {...cardMotion}>
          <Card sx={{ maxWidth: 440, width: "100%", borderRadius: 3, boxShadow: 6 }}>
            <CardContent sx={{ p: 3 }}>
              <Typography variant="h5" gutterBottom color="success.main">
                Cadastro realizado
              </Typography>
              <Alert severity="success" sx={{ mt: 1, mb: 2 }}>
                {success.message}
              </Alert>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Você já pode acessar o painel do administrador. O tenant será ativado automaticamente após a confirmação do pagamento.
              </Typography>
              <Button component={Link} href="/login/tenant" variant="contained" fullWidth>
                Ir para o login
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "linear-gradient(135deg, #0d47a1 0%, #1565c0 50%, #1976d2 100%)",
        py: { xs: 3, md: 4 },
        px: 2,
      }}
    >
      <motion.div {...cardMotion} style={{ width: "100%", maxWidth: 560 }}>
        <Typography
          variant="h4"
          component="h1"
          align="center"
          sx={{ color: "white", fontWeight: 700, mb: 0.5 }}
        >
          Cadastre sua empresa
        </Typography>
        <Typography align="center" sx={{ color: "rgba(255,255,255,0.9)", mb: 3 }}>
          Escolha um plano e crie sua conta. Ativação após confirmação do pagamento.
        </Typography>

        <Card sx={{ borderRadius: 3, boxShadow: 6, overflow: "hidden" }}>
          <CardContent sx={{ p: 3 }}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            <form onSubmit={handleSubmit}>
              <TextField
                fullWidth
                label="Nome da empresa"
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                margin="normal"
                required
                placeholder="Ex.: Minha Empresa Ltda"
              />

              <FormControl component="fieldset" sx={{ mt: 2, width: "100%" }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Plano
                </Typography>
                {loadingPlans ? (
                  <Typography variant="body2" color="text.secondary">
                    Carregando planos…
                  </Typography>
                ) : (
                  <RadioGroup
                    row
                    value={planId}
                    onChange={(e) => setPlanId(e.target.value)}
                    sx={{ gap: 0 }}
                  >
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1} useFlexGap flexWrap="wrap">
                      {plans.map((plan) => (
                        <Card
                          key={plan.id}
                          variant="outlined"
                          sx={{
                            flex: { xs: "1 1 100%", sm: "1 1 0" },
                            minWidth: 140,
                            cursor: "pointer",
                            border: 2,
                            borderColor: planId === plan.id ? "primary.main" : "divider",
                            bgcolor: planId === plan.id ? "action.hover" : "transparent",
                            "&:hover": { borderColor: "primary.light" },
                          }}
                          onClick={() => setPlanId(plan.id)}
                        >
                          <FormControlLabel
                            value={plan.id}
                            control={<Radio size="small" />}
                            label={
                              <Box sx={{ py: 0.5 }}>
                                <Typography variant="subtitle2">{plan.name}</Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {plan.maxProjects} projetos · {plan.maxUsersPerTenant} usuários
                                </Typography>
                              </Box>
                            }
                            sx={{ m: 0, width: "100%", px: 1.5, py: 0.5 }}
                          />
                        </Card>
                      ))}
                    </Stack>
                  </RadioGroup>
                )}
              </FormControl>

              <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2, mb: 1 }}>
                Administrador (acesso tenant)
              </Typography>
              <TextField
                fullWidth
                label="Nome do administrador"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                margin="normal"
                required
                placeholder="Seu nome"
              />
              <TextField
                fullWidth
                label="E-mail"
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                margin="normal"
                required
                placeholder="admin@empresa.com"
              />
              <TextField
                fullWidth
                label="Senha"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                margin="normal"
                required
                placeholder="Mín. 8 caracteres"
                helperText="Mínimo 8 caracteres, máximo 128"
              />

              <Button
                type="submit"
                variant="contained"
                fullWidth
                size="large"
                sx={{ mt: 3 }}
                disabled={submitting || loadingPlans || !planId}
              >
                {submitting ? "Cadastrando…" : "Cadastrar empresa"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Typography align="center" sx={{ mt: 2 }}>
          <Link href="/login/tenant" style={{ color: "rgba(255,255,255,0.9)", textDecoration: "underline" }}>
            Já tem conta? Entrar
          </Link>
        </Typography>
      </motion.div>
    </Box>
  );
}
