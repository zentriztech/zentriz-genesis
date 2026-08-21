/**
 * uiuxExtract.ts — Item 3: extração de definições UI/UX de Figma/Canva.
 *
 * Dado uma conexão de ferramenta (Figma/Canva) e projetos escolhidos no form de spec,
 * o Genesis busca a estrutura de design e SINTETIZA um arquivo de spec especializado
 * em UI/UX, identificando a descrição MACRO (páginas, telas/frames, grupos) e MICRO
 * (componentes, textos, elementos individuais com geometria, tipografia e cor).
 *
 * As funções puras (walk/summarize/render) são testáveis sem rede; os fetchers HTTP
 * seguem o padrão fetch+AbortController de cnpjLookup.ts (base URL + token + timeout).
 *
 * Figma: Personal Access Token via header X-Figma-Token (sem app OAuth — self-service).
 * Canva: Connect API (OAuth2 + PKCE) — requer app registrado no Developer Portal; o
 *   fetcher usa um access token armazenado. Sem token configurado, lança erro claro.
 */

import { createHash, randomBytes } from "crypto";

export type UiuxProvider = "figma" | "canva";

const FIGMA_API_BASE = process.env.FIGMA_API_BASE ?? "https://api.figma.com";
const CANVA_API_BASE = process.env.CANVA_API_BASE ?? "https://api.canva.com/rest/v1";

// ── Config do app OAuth do Canva (Connect API) ────────────────────────────────
// Registrado uma vez no Developer Portal da Zentriz (ver project/docs/integrations/
// canva-oauth-setup.md). CLIENT_ID/SECRET são da CONTA ZENTRIZ (não do tenant); cada
// tenant apenas autoriza (consent) e recebe tokens próprios. Sem CLIENT_ID/SECRET o
// fluxo OAuth fica indisponível e a UI orienta o admin — nada quebra.
const CANVA_CLIENT_ID = (process.env.CANVA_CLIENT_ID ?? "").trim();
const CANVA_CLIENT_SECRET = (process.env.CANVA_CLIENT_SECRET ?? "").trim();
const CANVA_AUTHORIZE_URL = process.env.CANVA_AUTHORIZE_URL ?? "https://www.canva.com/api/oauth/authorize";
const CANVA_TOKEN_URL = process.env.CANVA_TOKEN_URL ?? "https://api.canva.com/rest/v1/oauth/token";
// Escopos mínimos p/ ler metadados e conteúdo de designs + perfil (account_ref).
const CANVA_SCOPES =
  process.env.CANVA_SCOPES ?? "design:meta:read design:content:read folder:read asset:read profile:read";

/** true quando o app OAuth do Canva está configurado (CLIENT_ID + CLIENT_SECRET). */
export function isCanvaOAuthConfigured(): boolean {
  return Boolean(CANVA_CLIENT_ID && CANVA_CLIENT_SECRET);
}

/**
 * redirect_uri do callback OAuth do Canva. DEVE bater EXATAMENTE com o registrado no
 * Developer Portal. Prioriza CANVA_REDIRECT_URI explícito; senão deriva de GENESIS_PUBLIC_URL.
 * Vazio quando não há como determinar (a UI/rota trata como "não configurado").
 */
export function canvaRedirectUri(): string {
  const explicit = (process.env.CANVA_REDIRECT_URI ?? "").trim();
  if (explicit) return explicit;
  const base = (process.env.GENESIS_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (base && /^https?:\/\//.test(base)) return `${base}/api/tenant/uiux-connections/canva/callback`;
  return "";
}

/** URL para onde o browser volta após o consent (relativa → mesmo origin do portal). */
export function canvaPostAuthUrl(): string {
  return (process.env.CANVA_POST_AUTH_URL ?? "/settings/ui-ux").trim() || "/settings/ui-ux";
}

// Limites de segurança para não explodir custo/latência num único request de spec.
const MAX_FILES_PER_EXTRACT = 8;
const MAX_MICRO_ITEMS = 400;
const MAX_TEXT_PREVIEW = 80;
const HTTP_TIMEOUT_MS = 20_000;

// ── Tipos Figma (parciais, defensivos) ────────────────────────────────────────

export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface FigmaNode {
  id?: string;
  name?: string;
  type?: string;
  characters?: string;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x?: number; y?: number; width?: number; height?: number } | null;
  layoutMode?: string;
  componentId?: string;
  visible?: boolean;
  fills?: Array<{ type?: string; visible?: boolean; opacity?: number; color?: FigmaColor }>;
  style?: { fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeightPx?: number };
}

export interface FigmaFileExtract {
  fileKey: string;
  fileName: string;
  document: FigmaNode;
}

// ── Estruturas de resumo (saída das funções puras) ─────────────────────────────

interface MicroItem {
  path: string;
  type: string;
  name: string;
  text?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  font?: string;
  color?: string;
}

interface FrameSummary {
  name: string;
  width?: number;
  height?: number;
  layout: string;
  childCount: number;
}

interface PageSummary {
  name: string;
  frames: FrameSummary[];
}

export interface FileSummary {
  fileKey: string;
  fileName: string;
  pages: PageSummary[];
  micro: MicroItem[];
  componentCounts: Record<string, number>;
  colorCounts: Record<string, number>;
  typographyCounts: Record<string, number>;
  truncated: boolean;
}

// ── Utils puros ────────────────────────────────────────────────────────────────

/** Converte cor Figma (0..1 por canal) para hex #RRGGBB (alpha descartado). */
export function rgbaToHex(color?: FigmaColor | null): string | undefined {
  if (!color || typeof color.r !== "number" || typeof color.g !== "number" || typeof color.b !== "number") {
    return undefined;
  }
  const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const hx = (v: number) => to255(v).toString(16).padStart(2, "0");
  return `#${hx(color.r)}${hx(color.g)}${hx(color.b)}`.toUpperCase();
}

function firstSolidFill(node: FigmaNode): string | undefined {
  if (!Array.isArray(node.fills)) return undefined;
  for (const f of node.fills) {
    if (f && f.visible !== false && f.type === "SOLID" && f.color) {
      return rgbaToHex(f.color);
    }
  }
  return undefined;
}

function fontDescriptor(node: FigmaNode): string | undefined {
  const s = node.style;
  if (!s) return undefined;
  const parts: string[] = [];
  if (s.fontFamily) parts.push(s.fontFamily);
  if (typeof s.fontSize === "number") parts.push(`${Math.round(s.fontSize)}px`);
  if (typeof s.fontWeight === "number") parts.push(`w${s.fontWeight}`);
  return parts.length ? parts.join(" ") : undefined;
}

function round(v?: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function inc(map: Record<string, number>, key?: string) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

// ── Walk puro do documento Figma ────────────────────────────────────────────────

/**
 * Percorre o documento de um arquivo Figma e produz um resumo estruturado.
 * MACRO: CANVAS (páginas) e FRAMEs de topo (telas). MICRO: nós relevantes
 * (frames, grupos, componentes, textos, vetores) com geometria/tipografia/cor.
 */
export function summarizeFigmaFile(extract: FigmaFileExtract): FileSummary {
  const summary: FileSummary = {
    fileKey: extract.fileKey,
    fileName: extract.fileName,
    pages: [],
    micro: [],
    componentCounts: {},
    colorCounts: {},
    typographyCounts: {},
    truncated: false,
  };

  const doc = extract.document;
  const canvases = Array.isArray(doc?.children) ? doc.children.filter((c) => c && c.type === "CANVAS") : [];

  // Se não há CANVAS (ex.: subtree via /nodes), trata o próprio doc como uma página.
  const pageNodes = canvases.length ? canvases : [doc].filter(Boolean);

  for (const page of pageNodes) {
    const pageSummary: PageSummary = { name: page.name ?? "(sem nome)", frames: [] };
    const topFrames = Array.isArray(page.children)
      ? page.children.filter((c) => c && (c.type === "FRAME" || c.type === "COMPONENT" || c.type === "COMPONENT_SET"))
      : [];

    for (const frame of topFrames) {
      pageSummary.frames.push({
        name: frame.name ?? "(frame)",
        width: round(frame.absoluteBoundingBox?.width),
        height: round(frame.absoluteBoundingBox?.height),
        layout: frame.layoutMode && frame.layoutMode !== "NONE" ? `auto (${frame.layoutMode.toLowerCase()})` : "livre",
        childCount: Array.isArray(frame.children) ? frame.children.length : 0,
      });
    }
    summary.pages.push(pageSummary);

    // MICRO: DFS a partir dos frames de topo da página.
    const walk = (node: FigmaNode, pathParts: string[]) => {
      if (summary.micro.length >= MAX_MICRO_ITEMS) {
        summary.truncated = true;
        return;
      }
      if (!node || node.visible === false) return;
      const type = node.type ?? "NODE";
      const name = node.name ?? "";
      const here = [...pathParts, name || type];

      const RELEVANT = new Set([
        "FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE",
        "TEXT", "RECTANGLE", "VECTOR", "ELLIPSE", "LINE", "IMAGE",
      ]);
      if (RELEVANT.has(type)) {
        const color = firstSolidFill(node);
        const font = type === "TEXT" ? fontDescriptor(node) : undefined;
        const item: MicroItem = {
          path: here.slice(0, -1).join(" › ") || page.name || "",
          type,
          name: name || type,
          text: type === "TEXT" && node.characters ? truncate(node.characters, MAX_TEXT_PREVIEW) : undefined,
          width: round(node.absoluteBoundingBox?.width),
          height: round(node.absoluteBoundingBox?.height),
          x: round(node.absoluteBoundingBox?.x),
          y: round(node.absoluteBoundingBox?.y),
          font,
          color,
        };
        summary.micro.push(item);

        if (type === "COMPONENT" || type === "COMPONENT_SET" || type === "INSTANCE") inc(summary.componentCounts, name || type);
        if (color) inc(summary.colorCounts, color);
        if (font) inc(summary.typographyCounts, font);
      }

      if (Array.isArray(node.children)) {
        for (const child of node.children) walk(child, here);
      }
    };

    for (const frame of topFrames) walk(frame, [page.name ?? ""]);
  }

  return summary;
}

// ── Renderer puro → markdown de spec UI/UX ──────────────────────────────────────

function topEntries(map: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/** Renderiza o arquivo de spec especializado em UI/UX a partir dos resumos. */
export function renderUiuxSpecMarkdown(
  provider: UiuxProvider,
  accountLabel: string,
  summaries: FileSummary[],
): string {
  const providerName = provider === "figma" ? "Figma" : "Canva";
  const lines: string[] = [];

  lines.push(`# Especificação UI/UX — ${accountLabel}`);
  lines.push("");
  lines.push(`> Gerado automaticamente pelo Genesis a partir de **${providerName}**.`);
  lines.push(`> Fonte: ${summaries.length} arquivo(s) de design. Descrições macro (páginas/telas) e micro (grupos e elementos individuais).`);
  lines.push("");

  // Sumário macro consolidado.
  lines.push("## 1. Visão Macro (estrutura de telas)");
  lines.push("");
  for (const f of summaries) {
    lines.push(`### 📄 ${f.fileName}`);
    if (!f.pages.length) {
      lines.push("- _(sem páginas detectadas)_");
    }
    for (const page of f.pages) {
      lines.push(`- **Página:** ${page.name} — ${page.frames.length} tela(s)`);
      for (const fr of page.frames) {
        const dim = fr.width && fr.height ? `${fr.width}×${fr.height}px` : "dimensão n/d";
        lines.push(`  - 🖼️ **${fr.name}** — ${dim} · layout ${fr.layout} · ${fr.childCount} elemento(s) diretos`);
      }
    }
    lines.push("");
  }

  // Detalhamento micro por arquivo.
  lines.push("## 2. Visão Micro (objetos e elementos)");
  lines.push("");
  for (const f of summaries) {
    lines.push(`### 📄 ${f.fileName}`);
    if (!f.micro.length) {
      lines.push("- _(nenhum elemento extraído)_");
    }
    let lastPath = "";
    for (const m of f.micro) {
      if (m.path !== lastPath) {
        lines.push(`- **${m.path || "(raiz)"}**`);
        lastPath = m.path;
      }
      const geo = m.width && m.height ? ` — ${m.width}×${m.height}px` : "";
      const pos = typeof m.x === "number" && typeof m.y === "number" ? ` @ (${m.x}, ${m.y})` : "";
      const txt = m.text ? ` · texto: “${m.text}”` : "";
      const font = m.font ? ` · fonte ${m.font}` : "";
      const color = m.color ? ` · cor ${m.color}` : "";
      lines.push(`  - \`[${m.type}]\` ${m.name}${geo}${pos}${txt}${font}${color}`);
    }
    if (f.truncated) lines.push(`  - _(lista truncada em ${MAX_MICRO_ITEMS} elementos)_`);
    lines.push("");
  }

  // Inventário de componentes e tokens (agregado cross-file).
  const comps: Record<string, number> = {};
  const colors: Record<string, number> = {};
  const fonts: Record<string, number> = {};
  for (const f of summaries) {
    for (const [k, v] of Object.entries(f.componentCounts)) comps[k] = (comps[k] ?? 0) + v;
    for (const [k, v] of Object.entries(f.colorCounts)) colors[k] = (colors[k] ?? 0) + v;
    for (const [k, v] of Object.entries(f.typographyCounts)) fonts[k] = (fonts[k] ?? 0) + v;
  }

  lines.push("## 3. Inventário de componentes");
  lines.push("");
  const compEntries = topEntries(comps, 60);
  if (!compEntries.length) lines.push("- _(nenhum componente reutilizável detectado)_");
  for (const [name, count] of compEntries) lines.push(`- **${name}** ×${count}`);
  lines.push("");

  lines.push("## 4. Design tokens detectados");
  lines.push("");
  lines.push("### 4.1 Paleta de cores");
  const colorEntries = topEntries(colors, 40);
  if (!colorEntries.length) lines.push("- _(sem cores sólidas detectadas)_");
  for (const [hex, count] of colorEntries) lines.push(`- \`${hex}\` ×${count}`);
  lines.push("");
  lines.push("### 4.2 Tipografia");
  const fontEntries = topEntries(fonts, 30);
  if (!fontEntries.length) lines.push("- _(sem estilos de texto detectados)_");
  for (const [font, count] of fontEntries) lines.push(`- ${font} ×${count}`);
  lines.push("");

  lines.push("## 5. Notas para implementação");
  lines.push("");
  lines.push("- Este documento é a fonte de verdade UI/UX; combine-o com a spec funcional para o build.");
  lines.push("- Reproduza a paleta e a tipografia acima como design tokens antes de montar as telas.");
  lines.push("- Cada tela (Frame) da Visão Macro corresponde a uma rota/página do produto.");
  lines.push("");

  return lines.join("\n");
}

// ── Fetchers HTTP (Figma) ────────────────────────────────────────────────────────

async function figmaFetch<T>(pathAndQuery: string, token: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${FIGMA_API_BASE}${pathAndQuery}`, {
      headers: { "X-Figma-Token": token, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 403 || res.status === 401) {
      throw new Error("Token Figma inválido ou sem acesso (403/401).");
    }
    if (res.status === 404) {
      throw new Error("Recurso Figma não encontrado (404).");
    }
    if (!res.ok) {
      throw new Error(`Figma API retornou ${res.status}.`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface UiuxProjectRef {
  id: string;
  name: string;
}

/** Lista os "projetos" de uma conta Figma (requer team_id em account_ref). */
export async function listFigmaProjects(token: string, teamId: string): Promise<UiuxProjectRef[]> {
  const data = await figmaFetch<{ projects?: Array<{ id: string; name: string }> }>(
    `/v1/teams/${encodeURIComponent(teamId)}/projects`,
    token,
  );
  return (data.projects ?? []).map((p) => ({ id: String(p.id), name: p.name }));
}

async function listFigmaProjectFiles(token: string, projectId: string): Promise<Array<{ key: string; name: string }>> {
  const data = await figmaFetch<{ files?: Array<{ key: string; name: string }> }>(
    `/v1/projects/${encodeURIComponent(projectId)}/files`,
    token,
  );
  return (data.files ?? []).map((f) => ({ key: String(f.key), name: f.name }));
}

async function fetchFigmaFile(token: string, fileKey: string): Promise<FigmaFileExtract> {
  // depth=4 limita a profundidade (páginas → frames → grupos → elementos) para conter payload.
  const data = await figmaFetch<{ name?: string; document?: FigmaNode }>(
    `/v1/files/${encodeURIComponent(fileKey)}?depth=4&geometry=paths`,
    token,
  );
  return { fileKey, fileName: data.name ?? fileKey, document: data.document ?? {} };
}

// ── Fetchers HTTP (Canva) — requer app OAuth + access token ─────────────────────

async function canvaFetch<T>(pathAndQuery: string, accessToken: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${CANVA_API_BASE}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("Token Canva inválido/expirado. Reautorize a conta (OAuth).");
    }
    if (!res.ok) throw new Error(`Canva API retornou ${res.status}.`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Lista os designs/pastas de uma conta Canva (Connect API). */
export async function listCanvaProjects(accessToken: string): Promise<UiuxProjectRef[]> {
  const data = await canvaFetch<{ items?: Array<{ id: string; title?: string }> }>(
    `/designs`,
    accessToken,
  );
  return (data.items ?? []).map((d) => ({ id: String(d.id), name: d.title ?? d.id }));
}

// ── OAuth2 + PKCE (Canva Connect API) ─────────────────────────────────────────────

/** base64url (sem padding) de um Buffer — formato exigido pelo PKCE (RFC 7636). */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Gera um par PKCE: code_verifier (aleatório) + code_challenge (S256 do verifier). */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64)); // ~86 chars (dentro de 43..128)
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Gera um 'state' opaco e imprevisível para amarrar authorize↔callback. */
export function generateOAuthState(): string {
  return base64url(randomBytes(32));
}

/** Monta a URL de autorização do Canva (o browser é redirecionado para ela). */
export function buildCanvaAuthorizeUrl(opts: {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}): string {
  const u = new URL(CANVA_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CANVA_CLIENT_ID);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", CANVA_SCOPES);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  return u.toString();
}

export interface CanvaTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/** POST form-encoded ao token endpoint do Canva (client confidencial → HTTP Basic). */
async function canvaTokenRequest(body: Record<string, string>): Promise<CanvaTokenSet> {
  if (!isCanvaOAuthConfigured()) {
    throw new Error("App OAuth do Canva não configurado (CANVA_CLIENT_ID/SECRET ausentes).");
  }
  const basic = Buffer.from(`${CANVA_CLIENT_ID}:${CANVA_CLIENT_SECRET}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
      },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Não reflete o corpo do upstream (pode vazar detalhe para o cliente/logs de chamador
      // não privilegiado). Só o status entra na mensagem; drena o corpo para liberar a conexão.
      await res.text().catch(() => "");
      throw new Error(`Canva token endpoint retornou ${res.status}.`);
    }
    return (await res.json()) as CanvaTokenSet;
  } finally {
    clearTimeout(timer);
  }
}

/** Troca o authorization code (+ PKCE verifier) por access/refresh tokens. */
export async function exchangeCanvaCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<CanvaTokenSet> {
  return canvaTokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: CANVA_CLIENT_ID,
  });
}

/** Renova o access token a partir do refresh token. */
export async function refreshCanvaToken(refreshToken: string): Promise<CanvaTokenSet> {
  return canvaTokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CANVA_CLIENT_ID,
  });
}

/** Perfil da conta autorizada (best-effort) — usado como account_ref/label. */
export async function fetchCanvaAccountRef(accessToken: string): Promise<string | null> {
  try {
    const me = await canvaFetch<{ team_id?: string; user_id?: string }>(`/users/me`, accessToken);
    return me.team_id ?? me.user_id ?? null;
  } catch {
    return null;
  }
}

// ── Extração de designs Canva (macro) ─────────────────────────────────────────────
// A Connect API do Canva NÃO expõe a árvore de nós/elementos de um design (ao contrário
// do Figma). Extraímos o nível MACRO disponível: título, nº de páginas, dimensões e links.
// O nível MICRO (elementos individuais) fica registrado como limitação explícita da API.

interface CanvaDesignMeta {
  id: string;
  title: string;
  pageCount: number | null;
  width: number | null;
  height: number | null;
  viewUrl: string | null;
  editUrl: string | null;
}

async function fetchCanvaDesign(accessToken: string, designId: string): Promise<CanvaDesignMeta> {
  const data = await canvaFetch<{
    design?: {
      id?: string;
      title?: string;
      page_count?: number;
      urls?: { view_url?: string; edit_url?: string };
      thumbnail?: { width?: number; height?: number };
    };
  }>(`/designs/${encodeURIComponent(designId)}`, accessToken);
  const d = data.design ?? {};
  return {
    id: String(d.id ?? designId),
    title: d.title ?? designId,
    pageCount: typeof d.page_count === "number" ? d.page_count : null,
    width: typeof d.thumbnail?.width === "number" ? d.thumbnail.width : null,
    height: typeof d.thumbnail?.height === "number" ? d.thumbnail.height : null,
    viewUrl: d.urls?.view_url ?? null,
    editUrl: d.urls?.edit_url ?? null,
  };
}

/** Renderiza a spec UI/UX (macro) a partir dos designs Canva. */
export function renderCanvaSpecMarkdown(accountLabel: string, designs: CanvaDesignMeta[]): string {
  const lines: string[] = [];
  lines.push(`# Especificação UI/UX — ${accountLabel}`);
  lines.push("");
  lines.push(`> Gerado automaticamente pelo Genesis a partir de **Canva** (Connect API).`);
  lines.push(`> Fonte: ${designs.length} design(s). A API do Canva expõe estrutura macro (telas/páginas);`);
  lines.push(`> o detalhamento micro por elemento não é disponibilizado pela API pública do Canva.`);
  lines.push("");

  lines.push("## 1. Visão Macro (designs / telas)");
  lines.push("");
  if (!designs.length) lines.push("- _(nenhum design acessível)_");
  for (const d of designs) {
    const dim = d.width && d.height ? `${d.width}×${d.height}px (thumb)` : "dimensão n/d";
    const pages = d.pageCount != null ? `${d.pageCount} página(s)` : "páginas n/d";
    lines.push(`### 🖼️ ${d.title}`);
    lines.push(`- **ID:** \`${d.id}\` · ${pages} · ${dim}`);
    if (d.viewUrl) lines.push(`- **Visualizar:** ${d.viewUrl}`);
    if (d.editUrl) lines.push(`- **Editar:** ${d.editUrl}`);
    lines.push("");
  }

  lines.push("## 2. Notas para implementação");
  lines.push("");
  lines.push("- Cada design Canva corresponde a uma tela/artefato visual do produto.");
  lines.push("- A API do Canva não fornece geometria por elemento; use os links acima como referência visual.");
  lines.push("- Combine este documento com a spec funcional para o build.");
  lines.push("");
  return lines.join("\n");
}

// ── Credenciais por provider ─────────────────────────────────────────────────────

export interface UiuxCredentials {
  // Figma
  accessToken?: string; // PAT (figma) ou OAuth access token (canva)
  teamId?: string;
  // Canva
  refreshToken?: string;
  tokenExpiresAt?: string; // ISO — quando o access token do Canva expira (p/ refresh proativo)
}

/** Chave de credencial usada pelo endpoint /test para checar "configurado". */
export const UIUX_REQUIRED_KEY: Record<UiuxProvider, keyof UiuxCredentials> = {
  figma: "accessToken",
  canva: "accessToken",
};

// ── Orquestrador de listagem de projetos ─────────────────────────────────────────

export async function listProjectsForConnection(
  provider: UiuxProvider,
  creds: UiuxCredentials,
  accountRef: string | null,
): Promise<UiuxProjectRef[]> {
  if (provider === "figma") {
    if (!creds.accessToken) throw new Error("Token Figma ausente na conexão.");
    const teamId = creds.teamId || accountRef || "";
    if (!teamId) throw new Error("Figma: informe o Team ID na conexão para listar projetos.");
    return listFigmaProjects(creds.accessToken, teamId);
  }
  if (!creds.accessToken) throw new Error("Canva: conexão sem access token. Requer app OAuth configurado.");
  return listCanvaProjects(creds.accessToken);
}

// ── Orquestrador de extração → { filename, content } ─────────────────────────────

export interface ExtractedUiuxSpec {
  filename: string;
  content: string;
  fileCount: number;
}

/**
 * Busca a estrutura de design dos projetos escolhidos e renderiza a spec UI/UX.
 * Lança em erro de credencial/rede; o chamador decide se degrada ou propaga.
 */
export async function extractUiuxSpec(opts: {
  provider: UiuxProvider;
  creds: UiuxCredentials;
  accountRef: string | null;
  accountLabel: string;
  projectIds: string[];
}): Promise<ExtractedUiuxSpec> {
  const { provider, creds, accountRef, accountLabel, projectIds } = opts;

  if (provider === "canva") {
    if (!creds.accessToken) {
      throw new Error("Canva: conexão sem access token. Reautorize a conta (OAuth).");
    }
    const designs: CanvaDesignMeta[] = [];
    for (const designId of projectIds) {
      if (designs.length >= MAX_FILES_PER_EXTRACT) break;
      try {
        designs.push(await fetchCanvaDesign(creds.accessToken, designId));
      } catch {
        // Design inacessível/removido: pula, mantém os demais.
        continue;
      }
    }
    if (!designs.length) {
      throw new Error("Nenhum design Canva pôde ser lido (verifique o acesso da conta autorizada).");
    }
    const content = renderCanvaSpecMarkdown(accountLabel || accountRef || "Conta Canva", designs);
    return { filename: "10-uiux-spec.md", content, fileCount: designs.length };
  }
  if (!creds.accessToken) throw new Error("Token Figma ausente.");

  // Expande projetos → arquivos (cap MAX_FILES_PER_EXTRACT). projectIds vêm do listFigmaProjects
  // (são IDs de PROJETO, nunca fileKeys), então um projeto que falha ao listar é apenas pulado —
  // NÃO tratamos o id como fileKey (isso garantiria um 404 depois e abortaria tudo).
  const fileKeys: Array<{ key: string; name: string }> = [];
  for (const projectId of projectIds) {
    if (fileKeys.length >= MAX_FILES_PER_EXTRACT) break;
    try {
      const files = await listFigmaProjectFiles(creds.accessToken, projectId);
      for (const f of files) {
        if (fileKeys.length >= MAX_FILES_PER_EXTRACT) break;
        fileKeys.push(f);
      }
    } catch {
      // Projeto inacessível/inválido: pula, mantém os demais.
      continue;
    }
  }

  if (!fileKeys.length) throw new Error("Nenhum arquivo Figma encontrado para os projetos escolhidos.");

  // Um arquivo inacessível (não compartilhado com o token, 404, timeout) não deve abortar a
  // extração inteira: pula o arquivo e segue com os que deram certo.
  const summaries: FileSummary[] = [];
  for (const fk of fileKeys) {
    try {
      const extract = await fetchFigmaFile(creds.accessToken, fk.key);
      if (!extract.fileName || extract.fileName === fk.key) extract.fileName = fk.name;
      summaries.push(summarizeFigmaFile(extract));
    } catch {
      continue;
    }
  }

  if (!summaries.length) {
    throw new Error("Nenhum arquivo Figma pôde ser lido (verifique o compartilhamento com o token).");
  }

  const content = renderUiuxSpecMarkdown(provider, accountLabel || accountRef || "Conta de design", summaries);
  return { filename: "10-uiux-spec.md", content, fileCount: summaries.length };
}
