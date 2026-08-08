/**
 * mobileEasRenderer.ts — Cenário B / F3 (mobile source_only).
 *
 * Renderer PURO do kit de entrega mobile Expo/RN no nível `source_only` (o único nível
 * SEM fricção de credencial — ver 02-CENARIO-B, correção adversária B1). Gera:
 *   - app.config.ts        — config Expo (nome, slug, EAS projectId placeholder, extra.apiUrl)
 *   - eas.json             — perfis de build development/preview/production (EAS Build/Submit)
 *   - .github/workflows/eas-build.yml — CI que dispara EAS Build (o cliente conecta a conta Expo)
 *   - MOBILE-DEPLOY.md     — como conectar a conta Expo e disparar build/submit
 *
 * `preview_build`/`store_submit` NÃO entram aqui (exigem token Expo + credenciais de loja
 * + worker de polling assíncrono — F3+). Este renderer só materializa o código de scaffolding;
 * nenhum build é disparado, nenhum segredo é embutido (tokens vêm de secrets do GitHub/Expo).
 *
 * Determinístico e sem I/O — testável por snapshot. A escrita em disco / commit fica na borda.
 */

import type { RenderedFile } from "./composeRenderer.js";

export interface MobileEasParams {
  /** Nome de exibição do app (ex: "Zentriz Voices"). */
  appName: string;
  /** Slug Expo (kebab-case, sem espaços). Derivado do appName se ausente. */
  slug?: string;
  /** Bundle/package identifier reverso (ex: "br.com.zentriz.voices"). Derivado se ausente. */
  bundleId?: string;
  /**
   * URL do backend/BFF que o app consome. Fica em `extra.apiUrl` do app.config e é
   * lido via `expo-constants`. NUNCA embutir segredo aqui — é só a URL pública da API.
   */
  apiUrl?: string;
  /** Nível de entrega. F3 só suporta source_only; os demais são declarados mas geram aviso. */
  delivery?: "source_only" | "preview_build" | "store_submit";
}

/** kebab-case seguro para slug Expo a partir de um nome livre. */
export function toSlug(name: string): string {
  return (name || "app")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "app";
}

/** Identificador reverso default a partir do slug (br.com.zentriz.<slug-sem-hifen>). */
function defaultBundleId(slug: string): string {
  const seg = slug.replace(/-/g, "");
  return `br.com.zentriz.${seg || "app"}`;
}

function renderAppConfig(p: MobileEasParams, slug: string, bundleId: string): string {
  // apiUrl entra como default no extra; em runtime pode ser sobrescrito por env EXPO_PUBLIC_API_URL.
  const apiUrl = p.apiUrl ?? "";
  return [
    "import type { ExpoConfig, ConfigContext } from \"expo/config\";",
    "",
    "// Gerado pelo Genesis (source_only). Preencha EAS projectId após `eas init`.",
    "// A URL da API vem de EXPO_PUBLIC_API_URL (env) com fallback no extra.apiUrl.",
    "export default ({ config }: ConfigContext): ExpoConfig => ({",
    "  ...config,",
    `  name: ${JSON.stringify(p.appName)},`,
    `  slug: ${JSON.stringify(slug)},`,
    "  version: \"1.0.0\",",
    "  orientation: \"portrait\",",
    "  scheme: " + JSON.stringify(slug) + ",",
    "  userInterfaceStyle: \"automatic\",",
    "  newArchEnabled: true,",
    "  ios: {",
    "    supportsTablet: true,",
    `    bundleIdentifier: ${JSON.stringify(bundleId)},`,
    "  },",
    "  android: {",
    `    package: ${JSON.stringify(bundleId)},`,
    "  },",
    "  extra: {",
    `    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? ${JSON.stringify(apiUrl)},`,
    "    // eas.projectId é preenchido automaticamente por `eas init`.",
    "    eas: { projectId: process.env.EAS_PROJECT_ID ?? \"\" },",
    "  },",
    "});",
    "",
  ].join("\n");
}

function renderEasJson(): string {
  // Perfis padrão EAS. development = dev client; preview = APK/IPA interno; production = loja.
  const obj = {
    cli: { version: ">= 5.0.0", appVersionSource: "remote" },
    build: {
      development: {
        developmentClient: true,
        distribution: "internal",
      },
      preview: {
        distribution: "internal",
        android: { buildType: "apk" },
      },
      production: {
        autoIncrement: true,
      },
    },
    submit: {
      production: {},
    },
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

function renderEasWorkflow(p: MobileEasParams): string {
  // CI que dispara EAS Build. O cliente conecta a conta Expo (secret EXPO_TOKEN).
  // Sem EXPO_TOKEN o job falha claramente — não há build silencioso nem credencial da Zentriz.
  return [
    "name: eas-build",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      profile:",
    "        description: \"Perfil EAS (preview | production)\"",
    "        required: true",
    "        default: \"preview\"",
    "  push:",
    "    branches: [ main ]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with: { node-version: 20, cache: npm }",
    "      - name: Install deps",
    "        run: npm ci",
    "      - name: Setup EAS",
    "        uses: expo/expo-github-action@v8",
    "        with:",
    "          eas-version: latest",
    "          token: ${{ secrets.EXPO_TOKEN }}   # conecte sua conta Expo (Settings > Access Tokens)",
    "      - name: Guard — EXPO_TOKEN presente",
    "        run: |",
    "          if [ -z \"${{ secrets.EXPO_TOKEN }}\" ]; then",
    "            echo \"::error::Defina o secret EXPO_TOKEN (conta Expo) para disparar o EAS Build.\"; exit 1;",
    "          fi",
    "      - name: EAS Build (não-interativo)",
    "        run: eas build --platform all --profile \"${{ github.event.inputs.profile || 'preview' }}\" --non-interactive --no-wait",
    "",
    "# store_submit (eas submit) é gated por aprovação humana e exige credenciais de loja",
    "# no Secrets Manager — fora do escopo source_only (ver 02-CENARIO-B, B1).",
    "",
  ].join("\n");
}

function renderMobileDeployMd(p: MobileEasParams, slug: string): string {
  const apiLine = p.apiUrl
    ? `A API que o app consome está em \`${p.apiUrl}\` (sobrescreva com \`EXPO_PUBLIC_API_URL\`).`
    : "Defina a URL da API em `EXPO_PUBLIC_API_URL` (ou `extra.apiUrl` no `app.config.ts`).";
  return [
    "# Mobile — kit de entrega (Genesis · source_only)",
    "",
    `App **${p.appName}** (Expo/React Native). Entregue como código-fonte + kit EAS.`,
    "A Zentriz **não** dispara build nem guarda credenciais: você conecta sua conta Expo e controla lojas/assinatura.",
    "",
    apiLine,
    "",
    "## 1. Pré-requisitos",
    "```sh",
    "npm i -g eas-cli   # ou npx eas-cli",
    "npx expo install   # instala as deps",
    "```",
    "",
    "## 2. Conectar o projeto à sua conta Expo",
    "```sh",
    "eas login",
    "eas init            # cria o projeto Expo e preenche o projectId",
    "```",
    "",
    "## 3. Build de teste (APK/IPA interno)",
    "```sh",
    "eas build --profile preview --platform all",
    "```",
    "O EAS Build roda na nuvem da Expo (~10-40 min) e devolve um link/QR de instalação.",
    "",
    "## 4. Build de produção + envio às lojas",
    "```sh",
    "eas build --profile production --platform all",
    "eas submit --profile production --platform all   # requer credenciais ASC (iOS) / Play (Android)",
    "```",
    "",
    "## 5. CI (opcional)",
    "O workflow `.github/workflows/eas-build.yml` dispara o EAS Build. Configure no repositório:",
    "- secret `EXPO_TOKEN` (Expo → Settings → Access Tokens).",
    "",
    "> Perfis em `eas.json`: `development` (dev client), `preview` (APK/IPA interno), `production` (loja).",
    "> `slug` do app: `" + slug + "`.",
    "",
  ].join("\n");
}

/**
 * Bundle mobile source_only. Retorna avisos junto aos arquivos: se `delivery` pedir
 * preview_build/store_submit, o kit ainda é source_only (aviso), pois esses níveis
 * exigem subsistema assíncrono + credenciais que F3 não entrega.
 */
export function renderMobileEasBundle(params: MobileEasParams): { files: RenderedFile[]; warnings: string[] } {
  const slug = params.slug ? toSlug(params.slug) : toSlug(params.appName);
  const bundleId = params.bundleId ?? defaultBundleId(slug);
  const warnings: string[] = [];
  if (params.delivery && params.delivery !== "source_only") {
    warnings.push(
      `delivery '${params.delivery}' pedido, mas F3 entrega apenas 'source_only' ` +
      "(preview_build/store_submit exigem token Expo + credenciais de loja + worker de build — F3+). " +
      "Gerando o kit source_only; conecte sua conta Expo para disparar builds.",
    );
  }
  const files: RenderedFile[] = [
    { path: "app.config.ts", content: renderAppConfig(params, slug, bundleId) },
    { path: "eas.json", content: renderEasJson() },
    { path: ".github/workflows/eas-build.yml", content: renderEasWorkflow(params) },
    { path: "MOBILE-DEPLOY.md", content: renderMobileDeployMd(params, slug) },
  ];
  // Guarda de integridade: sem paths duplicados.
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`MOBILE_BUNDLE_PATH_COLLISION: ${f.path}`);
    seen.add(f.path);
  }
  return { files, warnings };
}
