"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import TextField from "@mui/material/TextField";
import InputAdornment from "@mui/material/InputAdornment";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import CircularProgress from "@mui/material/CircularProgress";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import { motion } from "framer-motion";
import { apiGet, apiPost } from "@/lib/api";
import { PlanInstallments } from "@/components/PlanInstallments";

const PRIMARY = "#6366F1";
const PRIMARY_D = "#4F46E5";
const ACCENT_GRADIENT = `linear-gradient(135deg, ${PRIMARY} 0%, ${PRIMARY_D} 100%)`;
const PAGE_BG = "linear-gradient(160deg, #0D0F14 0%, #12151d 55%, #0D0F14 100%)";

type Plan = {
  id: string;
  name: string;
  slug: string;
  maxProjects: number;
  maxUsersPerTenant: number;
  monthlyPriceCents: number;
};

type SignupResponse = {
  message: string;
  tenant: { id: string; name: string; planId: string; status: string; createdAt: string };
};

type RequestCodeResponse = {
  sent: boolean;
  devCode?: string;
  expiresAt?: string;
};

type CnpjResponse = {
  cnpj: string;
  name: string;
  tradeName?: string;
  email?: string;
  phone?: string;
  address?: {
    cep?: string;
    street?: string;
    number?: string;
    complement?: string;
    district?: string;
    city?: string;
    state?: string;
  };
};

type FieldErrors = {
  tenantName?: string;
  adminName?: string;
  adminEmail?: string;
  password?: string;
  confirmPassword?: string;
  planId?: string;
  code?: string;
};

const cardMotion = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35 },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function TenantSignupPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [tenantName, setTenantName] = useState("");
  const [planId, setPlanId] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState(false);
  const [success, setSuccess] = useState<SignupResponse | null>(null);

  // Verificação de e-mail por código
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeMsg, setCodeMsg] = useState<{ severity: "success" | "info" | "error"; text: string } | null>(null);

  // Dados adicionais da empresa (opcionais)
  const [cnpj, setCnpj] = useState("");
  const [cnpjBusy, setCnpjBusy] = useState(false);
  const [cnpjMsg, setCnpjMsg] = useState<{ severity: "success" | "error"; text: string } | null>(null);
  const [responsibleName, setResponsibleName] = useState("");
  const [responsiblePhone, setResponsiblePhone] = useState("");
  const [addressCep, setAddressCep] = useState("");
  const [addressStreet, setAddressStreet] = useState("");
  const [addressNumber, setAddressNumber] = useState("");
  const [addressComplement, setAddressComplement] = useState("");
  const [addressDistrict, setAddressDistrict] = useState("");
  const [addressCity, setAddressCity] = useState("");
  const [addressState, setAddressState] = useState("");

  const emailOk = EMAIL_RE.test(adminEmail.trim());
  const cnpjDigits = cnpj.replace(/\D+/g, "");

  async function handleSendCode() {
    if (!emailOk || sendingCode) return;
    setSendingCode(true);
    setCodeMsg(null);
    setError(null);
    try {
      const res = await apiPost<RequestCodeResponse>("/api/tenant/signup/request-code", {
        email: adminEmail.trim().toLowerCase(),
      });
      setCodeSent(true);
      if (res.devCode) {
        // Ambiente sem envio real (dev): mostra o código para prosseguir.
        setCode(res.devCode);
        setCodeMsg({ severity: "info", text: `Ambiente de desenvolvimento: código ${res.devCode} preenchido automaticamente.` });
      } else {
        setCodeMsg({ severity: "success", text: "Código enviado para o seu e-mail. Verifique a caixa de entrada." });
      }
    } catch (err) {
      setCodeMsg({ severity: "error", text: err instanceof Error ? err.message : "Não foi possível enviar o código." });
    } finally {
      setSendingCode(false);
    }
  }

  async function handleCnpjLookup() {
    if (cnpjDigits.length !== 14 || cnpjBusy) return;
    setCnpjBusy(true);
    setCnpjMsg(null);
    try {
      const data = await apiGet<CnpjResponse>(`/api/cnpj/${cnpjDigits}`);
      if (data.name && !tenantName.trim()) setTenantName(data.name);
      if (data.phone && !responsiblePhone.trim()) setResponsiblePhone(data.phone);
      const a = data.address ?? {};
      if (a.cep) setAddressCep(a.cep);
      if (a.street) setAddressStreet(a.street);
      if (a.number) setAddressNumber(a.number);
      if (a.complement) setAddressComplement(a.complement);
      if (a.district) setAddressDistrict(a.district);
      if (a.city) setAddressCity(a.city);
      if (a.state) setAddressState(a.state);
      setCnpjMsg({ severity: "success", text: `Dados de ${data.name || "CNPJ"} carregados.` });
    } catch (err) {
      setCnpjMsg({ severity: "error", text: err instanceof Error ? err.message : "Falha ao consultar CNPJ." });
    } finally {
      setCnpjBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiGet<Plan[]>("/api/plans")
      .then((data) => {
        if (!cancelled) {
          setPlans(data);
          if (data.length > 0) setPlanId((prev) => prev || data[0].id);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Não foi possível carregar os planos. Recarregue a página.");
      })
      .finally(() => {
        if (!cancelled) setLoadingPlans(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const validate = (): FieldErrors => {
    const errs: FieldErrors = {};
    if (!tenantName.trim()) errs.tenantName = "Informe o nome da empresa.";
    if (!adminName.trim()) errs.adminName = "Informe o nome do administrador.";
    if (!adminEmail.trim()) errs.adminEmail = "Informe o e-mail.";
    else if (!EMAIL_RE.test(adminEmail.trim())) errs.adminEmail = "E-mail inválido.";
    if (!password) errs.password = "Informe uma senha.";
    else if (password.length < 8) errs.password = "A senha deve ter no mínimo 8 caracteres.";
    if (!confirmPassword) errs.confirmPassword = "Confirme a senha.";
    else if (password !== confirmPassword) errs.confirmPassword = "As senhas não coincidem.";
    if (!planId) errs.planId = "Selecione um plano.";
    if (!code.trim()) errs.code = "Informe o código enviado ao seu e-mail.";
    else if (!/^\d{6}$/.test(code.trim())) errs.code = "O código tem 6 dígitos.";
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setError(null);
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      const data = await apiPost<SignupResponse>("/api/tenant/signup", {
        name: tenantName.trim(),
        planId,
        adminName: adminName.trim(),
        adminEmail: adminEmail.trim(),
        password,
        code: code.trim(),
        cnpj: cnpjDigits || undefined,
        responsibleName: responsibleName.trim() || undefined,
        responsiblePhone: responsiblePhone.trim() || undefined,
        addressCep: addressCep.trim() || undefined,
        addressStreet: addressStreet.trim() || undefined,
        addressNumber: addressNumber.trim() || undefined,
        addressComplement: addressComplement.trim() || undefined,
        addressDistrict: addressDistrict.trim() || undefined,
        addressCity: addressCity.trim() || undefined,
        addressState: addressState.trim() || undefined,
      });
      setSuccess(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao cadastrar. Tente novamente.");
    } finally {
      setSubmitting(false);
    }
  };

  // Revalida em tempo real depois da primeira tentativa de envio.
  const revalidate = () => {
    if (touched) setFieldErrors(validate());
  };

  // ── Tela de sucesso — conta criada porém PENDENTE de ativação ───────────────
  if (success) {
    return (
      <Box
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: PAGE_BG,
          py: { xs: 3, md: 4 },
          px: 2,
        }}
      >
        <motion.div {...cardMotion} style={{ width: "100%", maxWidth: 520 }}>
          <Card sx={{ borderRadius: 3, boxShadow: 8 }}>
            <Box sx={{ height: 4, background: ACCENT_GRADIENT }} />
            <CardContent sx={{ p: { xs: 2.5, sm: 4 } }}>
              <Typography variant="h5" component="h1" gutterBottom sx={{ color: "text.primary" }}>
                Cadastro recebido
              </Typography>

              <Alert severity="info" icon={false} sx={{ mt: 1, mb: 3 }}>
                <AlertTitle sx={{ fontWeight: 700 }}>Conta aguardando ativação</AlertTitle>
                Sua empresa <strong>{success.tenant.name}</strong> foi cadastrada com sucesso, mas a
                conta está <strong>inativa</strong>. Nenhum usuário conseguirá acessar até que a
                equipe da <strong>Zentriz</strong> ative o acesso. Você será avisado por e-mail
                assim que a ativação for concluída.
              </Alert>

              <Stepper activeStep={1} alternativeLabel sx={{ mb: 3 }}>
                <Step completed>
                  <StepLabel>Cadastro recebido</StepLabel>
                </Step>
                <Step>
                  <StepLabel>Aguardando ativação pela Zentriz</StepLabel>
                </Step>
                <Step>
                  <StepLabel>Acesso liberado</StepLabel>
                </Step>
              </Stepper>

              <Button
                component={Link}
                href="/login/tenant"
                variant="contained"
                fullWidth
                size="large"
              >
                Ir para o login
              </Button>
              <Typography variant="caption" color="text.secondary" align="center" sx={{ display: "block", mt: 1.5 }}>
                O login só funcionará após a ativação da conta pela Zentriz.
              </Typography>
            </CardContent>
          </Card>
        </motion.div>
      </Box>
    );
  }

  // ── Formulário de cadastro ──────────────────────────────────────────────────
  const middleIndex = Math.floor((plans.length - 1) / 2);

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: PAGE_BG,
        py: { xs: 3, md: 5 },
        px: 2,
      }}
    >
      <motion.div {...cardMotion} style={{ width: "100%", maxWidth: 640 }}>
        {/* Cores fixas (não tokens de tema): estes títulos ficam SOBRE o PAGE_BG escuro
            hardcoded. Usar text.primary/text.secondary os tornaria escuros e invisíveis
            no tema claro (regra de ouro: texto claro exige fundo escuro). */}
        <Typography
          variant="h4"
          component="h1"
          align="center"
          sx={{ color: "#F8FAFC", fontWeight: 700, mb: 0.5 }}
        >
          Cadastre sua empresa
        </Typography>
        <Typography align="center" sx={{ color: "rgba(248,250,252,0.72)", mb: { xs: 3, md: 4 } }}>
          Escolha um plano e crie sua conta. O acesso é liberado após a ativação pela Zentriz.
        </Typography>

        <Card sx={{ borderRadius: 3, boxShadow: 8, overflow: "hidden" }}>
          <Box sx={{ height: 4, background: ACCENT_GRADIENT }} />
          <CardContent sx={{ p: { xs: 2.5, sm: 4 } }}>
            {error && (
              <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            <form onSubmit={handleSubmit} noValidate>
              {/* ── Seleção de plano ── */}
              <Typography variant="subtitle2" sx={{ color: "text.primary", mb: 1.5 }}>
                Escolha o seu plano
              </Typography>

              {loadingPlans ? (
                <Stack direction="row" alignItems="center" spacing={1.5} sx={{ py: 2, color: "text.secondary" }}>
                  <CircularProgress size={18} />
                  <Typography variant="body2" color="text.secondary">
                    Carregando planos…
                  </Typography>
                </Stack>
              ) : (
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  spacing={1.5}
                  useFlexGap
                  flexWrap="wrap"
                  role="radiogroup"
                  aria-label="Planos disponíveis"
                >
                  {plans.map((plan, i) => {
                    const selected = planId === plan.id;
                    const recommended = plans.length >= 3 && i === middleIndex;
                    return (
                      <Card
                        key={plan.id}
                        variant="outlined"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={0}
                        onClick={() => {
                          setPlanId(plan.id);
                          if (touched) setFieldErrors((prev) => ({ ...prev, planId: undefined }));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setPlanId(plan.id);
                            if (touched) setFieldErrors((prev) => ({ ...prev, planId: undefined }));
                          }
                        }}
                        sx={{
                          flex: { xs: "1 1 100%", sm: "1 1 0" },
                          minWidth: { sm: 150 },
                          position: "relative",
                          cursor: "pointer",
                          borderWidth: 2,
                          borderColor: selected ? "primary.main" : "divider",
                          bgcolor: selected ? `${PRIMARY}1F` : "transparent",
                          transition: "border-color .15s, background-color .15s, transform .15s",
                          "&:hover": { borderColor: "primary.main", transform: "translateY(-2px)" },
                          "&:focus-visible": { outline: `2px solid ${PRIMARY}`, outlineOffset: 2 },
                        }}
                      >
                        {recommended && (
                          <Chip
                            label="Recomendado"
                            size="small"
                            sx={{
                              position: "absolute",
                              top: 8,
                              right: 8,
                              height: 20,
                              fontSize: "0.62rem",
                              fontWeight: 700,
                              color: "#fff",
                              background: ACCENT_GRADIENT,
                            }}
                          />
                        )}
                        <CardContent sx={{ p: 2, "&:last-child": { pb: 2 } }}>
                          <Typography variant="subtitle1" sx={{ color: selected ? "primary.main" : "text.primary" }}>
                            {plan.name}
                          </Typography>
                          <Divider sx={{ my: 1 }} />
                          <Typography variant="body2" color="text.secondary">
                            {plan.maxProjects} projetos
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {plan.maxUsersPerTenant} usuários
                          </Typography>
                          <PlanInstallments monthlyPriceCents={plan.monthlyPriceCents} sx={{ mt: 1 }} />
                        </CardContent>
                      </Card>
                    );
                  })}
                </Stack>
              )}
              {touched && fieldErrors.planId && (
                <Typography variant="caption" color="error" sx={{ mt: 0.5, display: "block" }}>
                  {fieldErrors.planId}
                </Typography>
              )}

              <Divider sx={{ my: 3 }} />

              {/* ── Dados da empresa ── */}
              <Typography variant="subtitle2" sx={{ color: "text.primary", mb: 0.5 }}>
                Dados da empresa
              </Typography>
              <TextField
                fullWidth
                label="CNPJ (opcional)"
                value={cnpj}
                onChange={(e) => setCnpj(e.target.value)}
                margin="normal"
                placeholder="00.000.000/0000-00"
                helperText="Consulte para preencher automaticamente nome e endereço."
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <Button
                        size="small"
                        onClick={handleCnpjLookup}
                        disabled={cnpjDigits.length !== 14 || cnpjBusy}
                      >
                        {cnpjBusy ? <CircularProgress size={16} /> : "Consultar"}
                      </Button>
                    </InputAdornment>
                  ),
                }}
              />
              {cnpjMsg && (
                <Alert severity={cnpjMsg.severity} sx={{ mt: 1 }} onClose={() => setCnpjMsg(null)}>
                  {cnpjMsg.text}
                </Alert>
              )}
              <TextField
                fullWidth
                label="Nome da empresa"
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                onBlur={revalidate}
                margin="normal"
                required
                placeholder="Ex.: Minha Empresa Ltda"
                error={touched && !!fieldErrors.tenantName}
                helperText={touched ? fieldErrors.tenantName : undefined}
              />

              <Typography variant="subtitle2" sx={{ color: "text.primary", mt: 2, mb: 0.5 }}>
                Administrador (acesso do tenant)
              </Typography>
              <TextField
                fullWidth
                label="Nome do administrador"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                onBlur={revalidate}
                margin="normal"
                required
                placeholder="Seu nome"
                error={touched && !!fieldErrors.adminName}
                helperText={touched ? fieldErrors.adminName : undefined}
              />
              <TextField
                fullWidth
                label="E-mail"
                type="email"
                value={adminEmail}
                onChange={(e) => {
                  setAdminEmail(e.target.value);
                  // E-mail mudou → código anterior não vale mais.
                  if (codeSent) {
                    setCodeSent(false);
                    setCode("");
                    setCodeMsg(null);
                  }
                }}
                onBlur={revalidate}
                margin="normal"
                required
                placeholder="admin@empresa.com"
                error={touched && !!fieldErrors.adminEmail}
                helperText={touched ? fieldErrors.adminEmail : undefined}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <Button
                        size="small"
                        onClick={handleSendCode}
                        disabled={!emailOk || sendingCode}
                      >
                        {sendingCode ? <CircularProgress size={16} /> : codeSent ? "Reenviar" : "Enviar código"}
                      </Button>
                    </InputAdornment>
                  ),
                }}
              />
              {codeMsg && (
                <Alert severity={codeMsg.severity} sx={{ mt: 1 }} onClose={() => setCodeMsg(null)}>
                  {codeMsg.text}
                </Alert>
              )}
              <TextField
                fullWidth
                label="Código de verificação"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D+/g, "").slice(0, 6))}
                onBlur={revalidate}
                margin="normal"
                required
                placeholder="6 dígitos enviados ao seu e-mail"
                disabled={!codeSent}
                error={touched && !!fieldErrors.code}
                helperText={
                  touched && fieldErrors.code
                    ? fieldErrors.code
                    : codeSent
                      ? "Digite o código de 6 dígitos que enviamos."
                      : "Clique em “Enviar código” no campo de e-mail acima."
                }
                inputProps={{ inputMode: "numeric", maxLength: 6 }}
              />
              <TextField
                fullWidth
                label="Senha"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={revalidate}
                margin="normal"
                required
                placeholder="Mín. 8 caracteres"
                error={touched && !!fieldErrors.password}
                helperText={touched && fieldErrors.password ? fieldErrors.password : "Mínimo de 8 caracteres."}
              />
              <TextField
                fullWidth
                label="Confirmar senha"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onBlur={revalidate}
                margin="normal"
                required
                placeholder="Repita a senha"
                error={touched && !!fieldErrors.confirmPassword}
                helperText={touched ? fieldErrors.confirmPassword : undefined}
              />

              <Divider sx={{ my: 3 }} />
              <Typography variant="subtitle2" sx={{ color: "text.primary", mb: 0.5 }}>
                Responsável e endereço (opcional)
              </Typography>
              <TextField
                fullWidth
                label="Nome do responsável"
                value={responsibleName}
                onChange={(e) => setResponsibleName(e.target.value)}
                margin="normal"
              />
              <TextField
                fullWidth
                label="Telefone do responsável"
                value={responsiblePhone}
                onChange={(e) => setResponsiblePhone(e.target.value)}
                margin="normal"
              />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField label="CEP" value={addressCep} onChange={(e) => setAddressCep(e.target.value)} margin="normal" sx={{ width: { sm: 180 } }} fullWidth />
                <TextField label="Logradouro" value={addressStreet} onChange={(e) => setAddressStreet(e.target.value)} margin="normal" fullWidth />
                <TextField label="Número" value={addressNumber} onChange={(e) => setAddressNumber(e.target.value)} margin="normal" sx={{ width: { sm: 120 } }} fullWidth />
              </Stack>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField label="Complemento" value={addressComplement} onChange={(e) => setAddressComplement(e.target.value)} margin="normal" fullWidth />
                <TextField label="Bairro" value={addressDistrict} onChange={(e) => setAddressDistrict(e.target.value)} margin="normal" fullWidth />
              </Stack>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField label="Cidade" value={addressCity} onChange={(e) => setAddressCity(e.target.value)} margin="normal" fullWidth />
                <TextField label="UF" value={addressState} onChange={(e) => setAddressState(e.target.value)} margin="normal" inputProps={{ maxLength: 2 }} sx={{ width: { sm: 100 } }} fullWidth />
              </Stack>

              <Alert severity="info" sx={{ mt: 2.5 }}>
                Após o cadastro, a conta é criada <strong>inativa</strong>. O acesso só é liberado
                depois que a Zentriz ativar sua empresa.
              </Alert>

              <Button
                type="submit"
                variant="contained"
                fullWidth
                size="large"
                sx={{ mt: 3 }}
                disabled={submitting || loadingPlans}
              >
                {submitting ? "Cadastrando…" : "Cadastrar empresa"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Typography align="center" sx={{ mt: 2.5 }}>
          <Link href="/login/tenant" style={{ color: PRIMARY, textDecoration: "none", fontWeight: 600 }}>
            Já tem conta? Entrar
          </Link>
        </Typography>
      </motion.div>
    </Box>
  );
}
