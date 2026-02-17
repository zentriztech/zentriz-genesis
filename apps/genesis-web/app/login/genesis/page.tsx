"use client";

import { observer } from "mobx-react-lite";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import { authStore } from "@/stores/authStore";

const cardMotion = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35 },
};

function LoginGenesisPageInner() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@zentriz.com");
  const [password, setPassword] = useState("#Jean@2026!");

  const [submitting, setSubmitting] = useState(false);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await authStore.login(email, password, "zentriz_admin");
      router.push("/dashboard");
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "grey.100",
      }}
    >
      <MotionCard sx={{ maxWidth: 400, width: "100%" }} {...cardMotion}>
        <CardContent sx={{ p: 3 }}>
          <Typography variant="h5" gutterBottom>
            Portal Genesis
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            genesis.zentriz.com.br — Acesso Zentriz
          </Typography>
          {authStore.loginError && (
            <Alert severity="error" sx={{ mb: 2 }}>{authStore.loginError}</Alert>
          )}
          <form onSubmit={handleSubmit}>
            <TextField
              fullWidth
              label="E-mail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              margin="normal"
              required
            />
            <TextField
              fullWidth
              label="Senha"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              margin="normal"
              required
            />
            <MotionButton
              type="submit"
              fullWidth
              variant="contained"
              sx={{ mt: 3 }}
              disabled={submitting}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              {submitting ? "Entrando…" : "Entrar"}
            </MotionButton>
          </form>
        </CardContent>
      </MotionCard>
    </Box>
  );
}

const MotionCard = motion(Card);
const MotionButton = motion(Button);

export default observer(LoginGenesisPageInner);
