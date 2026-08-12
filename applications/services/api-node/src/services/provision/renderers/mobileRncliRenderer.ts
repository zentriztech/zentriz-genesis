/**
 * mobileRncliRenderer.ts — Cenário B (mobile source_only, RN CLI PURO — sem Expo).
 *
 * Renderer do kit de entrega mobile para o tipo canônico `mobile_crossplatform`
 * (React Native CLI puro, política no-Expo do ecossistema). É o par do
 * `mobileEasRenderer.ts` (que atende SÓ `mobile_expo`, opt-in explícito do tenant).
 *
 * Contexto (bug que este arquivo corrige): antes, `deployMatrix` roteava
 * `mobile_crossplatform` para o canal `eas` e o dispatcher entregava o kit Expo —
 * exatamente os arquivos que a policy `project_types.yaml` PROÍBE para RN CLI
 * (`eas.json`, `app.config.ts`, `expo`). Este renderer entrega o caminho RN CLI real:
 *   - .env.example                       — API_URL lida via `react-native-config` (substitui EXPO_PUBLIC_*)
 *   - Gemfile                            — fastlane (build/submit RN CLI, substitui EAS)
 *   - fastlane/Appfile                   — package_name (Android) + app_identifier (iOS), placeholders
 *   - fastlane/Fastfile                  — lanes gradlew (Android .aab/.apk) + gym/pilot (iOS), submit gated
 *   - .github/workflows/mobile-build.yml — CI: Android `gradlew assembleRelease` + iOS build no simulador
 *   - MOBILE-DEPLOY.md                   — como buildar/assinar/submeter SEM Expo
 *
 * `preview_build`/`store_submit` NÃO disparam build aqui (exigem keystore Android +
 * certificados iOS + worker assíncrono — F3+); pedidos desses níveis viram aviso e o
 * kit permanece source_only. Determinístico e sem I/O — nenhum segredo é embutido
 * (assinatura vem de secrets do GitHub). A escrita em disco/commit fica na borda.
 */

import type { RenderedFile } from "./composeRenderer.js";
import { toSlug } from "./mobileEasRenderer.js";

export interface MobileRncliParams {
  /** Nome de exibição do app (ex: "Zentriz Voices"). */
  appName: string;
  /** Slug kebab-case (sem espaços). Derivado do appName se ausente. */
  slug?: string;
  /** Bundle/package identifier reverso (ex: "br.com.zentriz.voices"). Derivado se ausente. */
  bundleId?: string;
  /**
   * URL do backend/BFF que o app consome. Vai para `.env` (API_URL) e é lida em runtime
   * via `react-native-config` (Config.API_URL). NUNCA embutir segredo — só a URL pública.
   */
  apiUrl?: string;
  /** Nível de entrega. Só source_only builda de fato; os demais são declarados mas geram aviso. */
  delivery?: "source_only" | "preview_build" | "store_submit";
}

/** Identificador reverso default a partir do slug (br.com.zentriz.<slug-sem-hifen>). */
function defaultBundleId(slug: string): string {
  const seg = slug.replace(/-/g, "");
  return `br.com.zentriz.${seg || "app"}`;
}

function renderEnvExample(p: MobileRncliParams): string {
  // react-native-config lê este .env em build time e expõe via `Config.API_URL`.
  // Substitui o EXPO_PUBLIC_API_URL do mundo Expo (ver política no-Expo do ecossistema).
  const apiUrl = p.apiUrl ?? "https://api.example.com";
  return [
    "# Gerado pelo Genesis (source_only · React Native CLI).",
    "# Consumido por react-native-config → import Config from \"react-native-config\"; Config.API_URL",
    "# Copie para .env (não versione o .env real com segredos).",
    `API_URL=${apiUrl}`,
    "",
  ].join("\n");
}

function renderGemfile(): string {
  // Fastlane é o caminho de build/submit RN CLI (substitui EAS Build/Submit).
  return [
    "source \"https://rubygems.org\"",
    "",
    "gem \"fastlane\"",
    "",
  ].join("\n");
}

function renderAppfile(bundleId: string): string {
  // Placeholders: o tenant preenche apple_id/team_id ao conectar as credenciais de loja.
  return [
    "# fastlane Appfile (React Native CLI). Preencha os campos de loja ao submeter.",
    `package_name(${JSON.stringify(bundleId)})        # Google Play (Android)`,
    "",
    "for_platform :ios do",
    `  app_identifier(${JSON.stringify(bundleId)})     # Bundle ID (App Store)`,
    "  # apple_id(ENV[\"FASTLANE_APPLE_ID\"])           # e-mail da conta Apple Developer",
    "  # team_id(ENV[\"FASTLANE_TEAM_ID\"])             # Team ID (App Store Connect)",
    "end",
    "",
  ].join("\n");
}

function renderFastfile(): string {
  // Lanes RN CLI puro: Android via gradlew, iOS via gym. Store submit é gated (credenciais).
  return [
    "# fastlane Fastfile — React Native CLI (SEM Expo). Build e submit por plataforma.",
    "# Assinatura vem de secrets/credenciais do tenant; nada é embutido no repositório.",
    "",
    "platform :android do",
    "  desc \"Build de release (.aab) via Gradle\"",
    "  lane :build do",
    "    gradle(project_dir: \"android\", task: \"clean\")",
    "    gradle(project_dir: \"android\", task: \"bundle\", build_type: \"Release\")  # gera app-release.aab",
    "  end",
    "",
    "  desc \"Submete o .aab ao Google Play (requer JSON key da service account)\"",
    "  lane :submit do",
    "    # Gated: exige SUPPLY_JSON_KEY (Play Console service account) + track configurado.",
    "    upload_to_play_store(track: \"internal\", aab: \"android/app/build/outputs/bundle/release/app-release.aab\")",
    "  end",
    "end",
    "",
    "platform :ios do",
    "  desc \"Build de release (.ipa) via gym\"",
    "  lane :build do",
    "    # Gated: exige match/certificados no CI (App Store Connect API key ou fastlane match).",
    "    build_app(workspace: Dir[\"ios/*.xcworkspace\"].first, scheme: ENV[\"IOS_SCHEME\"], export_method: \"app-store\")",
    "  end",
    "",
    "  desc \"Submete ao TestFlight (requer App Store Connect API key)\"",
    "  lane :submit do",
    "    upload_to_testflight",
    "  end",
    "end",
    "",
  ].join("\n");
}

function renderCiWorkflow(): string {
  // CI RN CLI: Android roda gradlew assembleRelease (produz APK instalável, sem segredo);
  // iOS faz build no SIMULADOR (sem assinatura). Assinatura de loja / .aab assinado /
  // submit são gated por secrets (guarda com falha clara), espelhando o guard do kit EAS.
  return [
    "name: mobile-build",
    "on:",
    "  workflow_dispatch:",
    "  push:",
    "    branches: [ main ]",
    "jobs:",
    "  android:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with: { node-version: 20, cache: npm }",
    "      - uses: actions/setup-java@v4",
    "        with: { distribution: temurin, java-version: 17 }",
    "      - name: Install deps",
    "        run: npm ci",
    "      - name: Gradle assembleRelease (APK)",
    "        run: cd android && chmod +x ./gradlew && ./gradlew assembleRelease --no-daemon",
    "      - name: Upload APK",
    "        uses: actions/upload-artifact@v4",
    "        with:",
    "          name: android-apk",
    "          path: android/app/build/outputs/apk/release/*.apk",
    "      - name: Nota — .aab assinado e submit à loja são gated",
    "        run: |",
    "          if [ -z \"${{ secrets.ANDROID_KEYSTORE_BASE64 }}\" ]; then",
    "            echo \"::notice::Para .aab ASSINADO e envio ao Play, configure ANDROID_KEYSTORE_BASE64 + SUPPLY_JSON_KEY e rode 'bundle exec fastlane android submit'.\";",
    "          fi",
    "  ios:",
    "    runs-on: macos-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with: { node-version: 20, cache: npm }",
    "      - name: Install deps",
    "        run: npm ci",
    "      - name: CocoaPods",
    "        run: cd ios && pod install",
    "      - name: Build no simulador (sem assinatura)",
    "        run: |",
    "          WS=$(ls ios/*.xcworkspace | head -1)",
    "          SCHEME=$(basename \"$WS\" .xcworkspace)",
    "          xcodebuild -workspace \"$WS\" -scheme \"$SCHEME\" -sdk iphonesimulator -configuration Release build CODE_SIGNING_ALLOWED=NO",
    "      - name: Nota — .ipa e TestFlight são gated",
    "        run: echo \"::notice::Para .ipa e envio ao TestFlight/App Store, configure a App Store Connect API key e rode 'bundle exec fastlane ios submit'.\"",
    "",
    "# store_submit (Play/App Store) é gated por aprovação humana + credenciais de loja",
    "# no Secrets Manager — fora do escopo source_only (política no-Expo, RN CLI).",
    "",
  ].join("\n");
}

function renderMobileDeployMd(p: MobileRncliParams, slug: string): string {
  const apiLine = p.apiUrl
    ? `A API que o app consome está em \`${p.apiUrl}\` — definida em \`.env\` (\`API_URL\`) e lida via \`react-native-config\`.`
    : "Defina a URL da API em `.env` (`API_URL=`), lida em runtime via `react-native-config` (`Config.API_URL`).";
  return [
    "# Mobile — kit de entrega (Genesis · source_only · React Native CLI)",
    "",
    `App **${p.appName}** (React Native CLI puro, **sem Expo**). Entregue como código-fonte + kit de build.`,
    "A Zentriz **não** dispara build nem guarda credenciais: você controla assinatura, lojas e distribuição.",
    "",
    apiLine,
    "",
    "## 1. Pré-requisitos",
    "```sh",
    "npm ci                       # instala as deps",
    "gem install bundler && bundle install   # fastlane",
    "# Android: JDK 17 + Android SDK.  iOS: Xcode + CocoaPods (cd ios && pod install)",
    "```",
    "",
    "## 2. Rodar em desenvolvimento",
    "```sh",
    "npm run start                # Metro bundler",
    "npm run android              # ou: npm run ios",
    "```",
    "",
    "## 3. Build de release",
    "```sh",
    "# Android (.apk instalável / .aab para a loja):",
    "cd android && ./gradlew assembleRelease   # APK",
    "cd android && ./gradlew bundleRelease      # AAB (loja)",
    "",
    "# iOS (via fastlane gym; requer certificados):",
    "bundle exec fastlane ios build",
    "```",
    "",
    "## 4. Assinatura + envio às lojas (fastlane)",
    "```sh",
    "bundle exec fastlane android submit   # Google Play (requer SUPPLY_JSON_KEY)",
    "bundle exec fastlane ios submit       # TestFlight (requer App Store Connect API key)",
    "```",
    "Configure as credenciais como secrets do repositório — nunca comite chaves.",
    "",
    "## 5. CI (opcional)",
    "O workflow `.github/workflows/mobile-build.yml` builda o APK (Android) e compila no simulador (iOS).",
    "Para artefatos assinados e envio às lojas, configure os secrets:",
    "- Android: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `SUPPLY_JSON_KEY`.",
    "- iOS: App Store Connect API key (ou fastlane match).",
    "",
    "> Este app é **React Native CLI** (não Expo): a configuração vive em `.env` + código nativo `android/`/`ios/`, sem CLI de nuvem.",
    "> `slug` do app: `" + slug + "`.",
    "",
  ].join("\n");
}

/**
 * Bundle mobile source_only para React Native CLI puro. Retorna avisos junto aos arquivos:
 * se `delivery` pedir preview_build/store_submit, o kit ainda é source_only (aviso), pois
 * esses níveis exigem keystore/certificados + worker assíncrono que source_only não entrega.
 */
export function renderMobileRncliBundle(params: MobileRncliParams): { files: RenderedFile[]; warnings: string[] } {
  const slug = params.slug ? toSlug(params.slug) : toSlug(params.appName);
  const bundleId = params.bundleId ?? defaultBundleId(slug);
  const warnings: string[] = [];
  if (params.delivery && params.delivery !== "source_only") {
    warnings.push(
      `delivery '${params.delivery}' pedido, mas o kit RN CLI entrega apenas 'source_only' ` +
      "(preview_build/store_submit exigem keystore Android + certificados iOS + worker de build — F3+). " +
      "Gerando o kit source_only; configure as credenciais de assinatura para buildar/submeter.",
    );
  }
  const files: RenderedFile[] = [
    { path: ".env.example", content: renderEnvExample(params) },
    { path: "Gemfile", content: renderGemfile() },
    { path: "fastlane/Appfile", content: renderAppfile(bundleId) },
    { path: "fastlane/Fastfile", content: renderFastfile() },
    { path: ".github/workflows/mobile-build.yml", content: renderCiWorkflow() },
    { path: "MOBILE-DEPLOY.md", content: renderMobileDeployMd(params, slug) },
  ];
  // Guarda de integridade: sem paths duplicados.
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`MOBILE_RNCLI_BUNDLE_PATH_COLLISION: ${f.path}`);
    seen.add(f.path);
  }
  return { files, warnings };
}
