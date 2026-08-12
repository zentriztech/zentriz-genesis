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
  // As páginas do portal são pré-renderizadas (SSG) e o Next as marca com
  // `Cache-Control: s-maxage=31536000` — o que faz caches compartilhados (CDN/proxy/túnel)
  // e o cache heurístico do browser segurarem o SHELL do app por até 1 ano. Resultado: após
  // um deploy, o usuário continua vendo a UI antiga até esvaziar o cache manualmente.
  // Forçamos o DOCUMENTO HTML a `no-store` (sempre revalida contra a origem, que responde
  // rápido pelo full-route cache do próprio Next). Os assets versionados por hash em
  // `/_next/static/*` continuam `immutable` (excluídos abaixo) — sem perda de performance.
  async headers() {
    return [
      {
        source: "/((?!_next/static|_next/image|favicon.ico).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
