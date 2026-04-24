"use client";

import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";

type Props = { children: React.ReactNode; fallback?: React.ReactNode };
type State = { hasError: boolean; message: string };

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message =
      error instanceof Error ? error.message : "Erro inesperado.";
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "40vh",
            gap: 2,
            p: 4,
          }}
        >
          <Typography variant="h5" color="error">
            Algo deu errado
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {this.state.message}
          </Typography>
          <Button
            variant="outlined"
            onClick={() => this.setState({ hasError: false, message: "" })}
          >
            Tentar novamente
          </Button>
        </Box>
      );
    }
    return this.props.children;
  }
}
