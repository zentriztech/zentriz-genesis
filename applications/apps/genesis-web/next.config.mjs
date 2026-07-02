import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("./package.json");

// Server-side proxy: browser sempre faz fetch("/api/...") (URL relativa).
// Em local/dev: Next.js proxy /api/* → http://api:3000 (nome do serviço no Docker network).
// Em PROD (EC2): nginx intercepta /api/* antes do Next.js — este rewrite fica inerte.
// Isso ELIMINA a necessidade de NEXT_PUBLIC_API_BASE_URL. Bundle nunca contém URL absoluta.
// NEXT_INTERNAL_API_URL default apontando para 'api:3000' funciona no Docker Compose;
// para dev fora do Docker (npm run dev direto), defina NEXT_INTERNAL_API_URL=http://localhost:3000.
const INTERNAL_API = process.env.NEXT_INTERNAL_API_URL || "http://api:3000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${INTERNAL_API}/api/:path*` },
    ];
  },
};

export default nextConfig;
