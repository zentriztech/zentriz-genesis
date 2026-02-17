"use client";

import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";

export default function SpecPage() {
  const [specRef, setSpecRef] = useState("spec/PRODUCT_SPEC.md");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Enviar spec ao CTO</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Envie a referência da especificação para iniciar o fluxo CTO → PM → Dev/QA/DevOps.
      </Typography>
      {submitted && <Alert severity="success" sx={{ mb: 2 }}>Spec enviada. O projeto será registrado.</Alert>}
      <form onSubmit={handleSubmit}>
        <TextField fullWidth label="Referência da spec" value={specRef} onChange={(e) => setSpecRef(e.target.value)} margin="normal" required />
        <Button type="submit" variant="contained" sx={{ mt: 2 }}>Enviar para o CTO</Button>
      </form>
    </Box>
  );
}
