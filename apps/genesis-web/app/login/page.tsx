"use client";

import { observer } from "mobx-react-lite";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { authStore } from "@/stores/authStore";

function LoginPageInner() {
  const router = useRouter();
  const [email, setEmail] = useState("user@tenant.com");
  const [password, setPassword] = useState("demo");
  const [role, setRole] = useState<"user" | "tenant_admin" | "zentriz_admin">("user");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    authStore.login(email, password, role);
    router.push("/dashboard");
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
      <Card sx={{ maxWidth: 400, width: "100%" }}>
        <CardContent sx={{ p: 3 }}>
          <Typography variant="h5" gutterBottom>
            Genesis — Login
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            genesis.zentriz.com.br
          </Typography>
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
            <Box sx={{ mt: 2, display: "flex", gap: 1, flexWrap: "wrap" }}>
              {(["user", "tenant_admin", "zentriz_admin"] as const).map((r) => (
                <Button
                  key={r}
                  size="small"
                  variant={role === r ? "contained" : "outlined"}
                  onClick={() => setRole(r)}
                >
                  {r === "user" ? "Usuário" : r === "tenant_admin" ? "Admin tenant" : "Zentriz"}
                </Button>
              ))}
            </Box>
            <Button type="submit" fullWidth variant="contained" sx={{ mt: 3 }}>
              Entrar
            </Button>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}

export default observer(LoginPageInner);
