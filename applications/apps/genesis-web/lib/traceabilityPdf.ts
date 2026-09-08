/**
 * traceabilityPdf.ts — desenha o PDF de rastreabilidade a partir dos FATOS da API.
 *
 * Pedido do Jean (2026-09-07): três relatórios (resumido / completo / misto) com o mapeamento da
 * construção do produto, "gerar arquivo e iniciar download".
 *
 * DIVISÃO: o servidor (`GET /api/products/:id/traceability?profile=…`) é a VERDADE — números,
 * hashes, cortes declarados. Aqui é só TINTA. O motivo de o PDF nascer no browser é o Mermaid: os
 * desenhos de arquitetura que o laço autônomo cria (`arquitetura-diagramas.md`) só viram figura num
 * browser, e este portal já renderiza Mermaid → SVG. Desenhar no servidor exigiria Chromium na
 * imagem da api (~300 MB) para produzir o mesmo SVG que o browser do usuário produz de graça.
 *
 * Regras que o desenho respeita:
 *  • fonte padrão (Helvetica/WinAnsi) ⇒ acentuação PT-BR sai correta, mas NADA de emoji (fora da
 *    tabela de caracteres: viraria lixo no papel). Marcadores são ASCII;
 *  • os CORTES declarados pelo servidor (`truncated[]`) vão IMPRESSOS numa seção própria — um
 *    relatório de rastreabilidade que esconde o que ficou de fora não é rastreabilidade;
 *  • os desenhos entram vetorizados (`svg2pdf`), não como bitmap: dá zoom sem borrar e o texto do
 *    diagrama continua selecionável;
 *  • diagrama que o Mermaid não conseguir desenhar entra como CÓDIGO — nunca desaparece calado.
 */
import { apiGet } from "./api";

export type TraceabilityProfile = "summary" | "full" | "mixed";

export const PROFILE_LABEL: Record<TraceabilityProfile, string> = {
  summary: "Resumido",
  full: "Completo",
  mixed: "Misto (revisão)",
};

export const PROFILE_HINT: Record<TraceabilityProfile, string> = {
  summary: "Identidade, certificado, GAPs por severidade, últimas validações e os desenhos.",
  full: "O mapeamento inteiro: arquivos com hash, findings, vereditos, constraints, rodadas e fábrica.",
  mixed: "O resumido mais o detalhe do que está ABERTO e do que mudou desde a última promoção.",
};

// ── a forma dos fatos (espelho tolerante de `services/productTraceability.ts`) ──

interface Cut { section: string; kept: number; total: number; limit: number }
interface CertCheck { id?: string; ok?: boolean | null; label?: string; detail?: string | null }
interface Cert { level?: string; code?: string | null; specHash?: string | null; checks?: CertCheck[] }
interface SpecFile { path: string; isPrimary: boolean; chars: number; contentSha256: string; judgedFullAtThisContent: boolean }
interface Project {
  id: string; title: string; status: string; projectType: string | null; versionNumber: number | null;
  createdAt: string | null; finishedAt: string | null; runCount: number | null;
  certificate: Cert | null;
  repo: { fullName: string | null; url: string | null; defaultBranch: string | null; shaDev: string | null; pushedAt: string | null } | null;
  spec: {
    specHash: string | null; totalChars: number; files: SpecFile[];
    diagrams: { path: string; chars: number; content: string } | null;
  };
}
export interface TraceabilityReport {
  profile: TraceabilityProfile;
  generatedAt: string;
  truncated: Cut[];
  changedSince: string | null;
  product: {
    id: string; name: string; description: string | null; status: string | null;
    lifecycleStatus: string | null; productHash: string | null; systemId: string | null;
    isInbox: boolean; soloApp: boolean; createdAt: string | null; projectsTotal: number;
  };
  projects: Project[];
  gaps: { counts: Record<string, number>; items: Array<{ projectId: string; severity: string; title: string; file: string | null; anchor: string | null; fingerprint: string | null; route: string | null }> };
  validations: Array<{ id: string; projectId: string; status: string; specHash: string | null; stageBRan: boolean | null; findings: number; findingsBySeverity: Record<string, number>; filesJudgedFull: number; filesTotal: number | null; createdAt: string | null; finishedAt: string | null }>;
  verdicts: Array<{ fingerprint: string; filePath: string | null; anchor: string | null; severityAt: string | null; title: string | null; impact: string | null; reason: string | null; factoryArtifact: string | null; recurrenceTimes: number | null; focusRounds: number | null; decidedByModel: string | null; createdAt: string | null; revokedAt: string | null }>;
  triage: Array<{ fingerprint: string; state: string; reasonCode: string | null; severityAt: string | null; recurrenceCount: number | null; actorRole: string | null; createdAt: string | null; revokedAt: string | null }>;
  constraints: { counts: Record<string, number>; items: Array<{ constraintKey: string; appliesTo: string | null; verifiableAt: string | null; severity: string | null; assertion: string | null; sourceAnchor: string | null }> };
  autonomyRuns: Array<{ id: string; status: string; mode: string | null; passes: number | null; round: number | null; maxRounds: number | null; gapsCurrent: number | null; createdAt: string | null; finishedAt: string | null; lastError: string | null; rounds: Array<Record<string, unknown>> }>;
  factory: {
    pipelineRuns: Array<{ runId: string | null; trigger: string | null; startedAt: string | null; finishedAt: string | null; durationSec: number | null; stopReason: string | null; inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null }>;
    tasks: Array<{ taskId: string | null; module: string | null; ownerRole: string | null; status: string | null; artifactsRef: string | null; updatedAt: string | null }>;
    tasksByStatus: Record<string, number>;
  };
  promotions: Array<{ id: string; status: string | null; model: string | null; edgesSource: string | null; createdAt: string | null; items: Array<{ projectId: string; wave: number | null; layer: string | null; dispatchedAt: string | null }> }>;
  deployments: Array<{ provider: string | null; class: string | null; lifecycle: string | null; status: string | null; appUrl: string | null; imageTag: string | null; createdAt: string | null; destroyedAt: string | null }>;
}

// ── formatação ────────────────────────────────────────────────────────────────

const PT = "pt-BR";

function dt(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(PT, { dateStyle: "short", timeStyle: "short" });
}
function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toLocaleString(PT);
}
function short(v: string | null | undefined, n = 12): string {
  return v ? (v.length > n ? `${v.slice(0, n)}…` : v) : "—";
}
function tallyLine(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join("   ") : "nenhum";
}
/**
 * Remove o que a fonte WinAnsi não desenha (emoji e afins) — no papel viraria lixo.
 * Sem a flag `u` (o target do tsconfig não a permite): os emoji vivem fora do BMP, então basta
 * varrer os pares surrogados, mais símbolos misc, seletor de variação e o ZWJ.
 */
function ascii(v: unknown): string {
  return String(v ?? "").replace(/[\uD800-\uDFFF☀-➿️‍]/g, "").trim();
}

// ── o escritor de páginas ─────────────────────────────────────────────────────

const A4 = { w: 595.28, h: 841.89 };
const M = { top: 52, right: 40, bottom: 46, left: 40 };
const COLOR = {
  ink: [22, 27, 34] as [number, number, number],
  soft: [110, 118, 129] as [number, number, number],
  rule: [208, 215, 222] as [number, number, number],
  accent: [11, 92, 168] as [number, number, number],
  danger: [176, 32, 32] as [number, number, number],
};

type Doc = import("jspdf").jsPDF;

class Writer {
  y = M.top;
  page = 1;
  constructor(readonly doc: Doc, readonly header: string) {}

  get width(): number { return A4.w - M.left - M.right; }

  /** Fundo da caixa útil: nenhuma linha de texto pode ter a base abaixo daqui (a faixa do rodapé
   *  vive em `A4.h - 24`, portanto FORA desta caixa). */
  get bottomLimit(): number { return A4.h - M.bottom; }

  need(h: number): void {
    if (this.y + h <= this.bottomLimit) return;
    this.newPage();
  }

  newPage(): void {
    this.doc.addPage();
    this.page += 1;
    this.y = M.top;
    this.pageHeader();
  }

  /**
   * Layout 2026-09-08 (Jean: "alguns textos ficam fora da página") — último recurso quando a quebra
   * do jsPDF não vence o token (hash de 64 chars, URL sem espaço, âncora colada): CORTA e marca com
   * "…". Cortar à vista é honesto; deixar o glifo atravessar a margem direita não é.
   * Mede com a fonte ATUAL — quem chama precisa tê-la escolhido antes.
   */
  clip(line: string, maxW: number): string {
    if (maxW <= 0) return "";
    if (this.doc.getTextWidth(line) <= maxW) return line;
    let s = line;
    while (s.length > 1 && this.doc.getTextWidth(`${s}…`) > maxW) s = s.slice(0, -1);
    return `${s}…`;
  }

  pageHeader(): void {
    this.doc.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(...COLOR.soft);
    // Nome de produto longo transbordava o cabeçalho pela direita: fica só a 1ª linha, cortada na caixa.
    this.doc.text(this.clip(ascii(this.header), this.width), M.left, M.top - 22);
    this.doc.setDrawColor(...COLOR.rule).setLineWidth(0.5);
    this.doc.line(M.left, M.top - 16, A4.w - M.right, M.top - 16);
  }

  /** Rodapé em TODAS as páginas, com a numeração final (chamado no fim). */
  stampFooters(total: number): void {
    for (let p = 1; p <= total; p++) {
      this.doc.setPage(p);
      this.doc.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(...COLOR.soft);
      this.doc.text(`Página ${p} de ${total}`, A4.w - M.right, A4.h - 24, { align: "right" });
      this.doc.text("Zentriz Genesis — relatório de rastreabilidade", M.left, A4.h - 24);
    }
  }

  /**
   * Título. Layout 2026-09-08 (Jean): título longo (nome de produto grande, rótulo de diagrama vindo
   * do Mermaid) era desenhado numa linha só e ATRAVESSAVA a margem direita. Agora QUEBRA em linhas.
   */
  private heading(text: string, size: number, lineH: number): string[] {
    this.doc.setFont("helvetica", "bold").setFontSize(size).setTextColor(...COLOR.ink);
    const lines = this.doc.splitTextToSize(ascii(text), this.width) as string[];
    this.need(lines.length * lineH + 14);
    for (const line of lines) {
      this.doc.setFont("helvetica", "bold").setFontSize(size).setTextColor(...COLOR.ink);
      this.doc.text(this.clip(line, this.width), M.left, this.y);
      this.y += lineH;
    }
    return lines;
  }

  h1(text: string): void {
    this.heading(text, 15, 18);
    this.y -= 10;
    this.doc.setDrawColor(...COLOR.accent).setLineWidth(1.2);
    this.doc.line(M.left, this.y, M.left + 70, this.y);
    this.y += 16;
  }

  h2(text: string): void {
    this.heading(text, 10.5, 13);
  }

  p(text: string, opts: { size?: number; color?: [number, number, number]; italic?: boolean } = {}): void {
    const size = opts.size ?? 8.6;
    this.doc.setFont("helvetica", opts.italic ? "italic" : "normal").setFontSize(size)
      .setTextColor(...(opts.color ?? COLOR.ink));
    const lines = this.doc.splitTextToSize(ascii(text), this.width) as string[];
    for (const line of lines) {
      this.need(size + 3.4);
      // `need` pode ter trocado de página, e o cabeçalho da nova redefine a fonte: reafirmar aqui,
      // senão o resto do parágrafo saía em 7,5 pt cinza (medido com uma fonte, desenhado com outra).
      this.doc.setFont("helvetica", opts.italic ? "italic" : "normal").setFontSize(size)
        .setTextColor(...(opts.color ?? COLOR.ink));
      this.doc.text(this.clip(line, this.width), M.left, this.y);
      this.y += size + 3.4;
    }
    this.y += 3;
  }

  /**
   * Grade de rótulo→valor em duas colunas (identidade, certificado, hashes).
   *
   * Layout 2026-09-08 (Jean) — antes só a PRIMEIRA linha do valor ia ao papel (`val[0]`): um id de
   * produto (36 chars) ou um hash não caberia em 153 pt e o resto DESAPARECIA sem aviso. Agora o par
   * cresce em altura e imprime o valor inteiro; o que nem a quebra vence sai cortado com "…".
   */
  kv(pairs: Array<[string, string]>): void {
    const colW = this.width / 2;
    const labelW = 96;
    const valW = colW - labelW - 8;
    const lineH = 11;
    for (let i = 0; i < pairs.length; i += 2) {
      const cells = [pairs[i], pairs[i + 1]].map((pair) => {
        if (!pair) return null;
        this.doc.setFont("helvetica", "bold").setFontSize(8.4);
        const raw = ascii(pair[1]) || "—";
        const lines = this.doc.splitTextToSize(raw, Math.max(valW, 20)) as string[];
        return { label: pair[0], lines: lines.map((l) => this.clip(l, valW)) };
      });
      const rowLines = Math.max(1, ...cells.map((c) => c?.lines.length ?? 1));
      this.need(rowLines * lineH + 6);
      for (let c = 0; c < 2; c++) {
        const cell = cells[c];
        if (!cell) continue;
        const x = M.left + c * colW;
        this.doc.setFont("helvetica", "normal").setFontSize(7.6).setTextColor(...COLOR.soft);
        this.doc.text(this.clip(ascii(cell.label), labelW - 4), x, this.y);
        this.doc.setFont("helvetica", "bold").setFontSize(8.4).setTextColor(...COLOR.ink);
        cell.lines.forEach((l, li) => this.doc.text(l, x + labelW, this.y + li * lineH));
      }
      this.y += rowLines * lineH + 4;
    }
    this.y += 4;
  }

  /**
   * Tabela simples: larguras em fração da largura útil. Quebra de página repete o cabeçalho.
   *
   * Layout 2026-09-08 (Jean) — duas vazões corrigidas:
   *  • fração somando mais de 1 jogava a última coluna FORA da folha ⇒ as frações são normalizadas
   *    pela soma (a tabela cabe na caixa útil, sempre);
   *  • linha mais alta que a página inteira (asserção de constraint, motivo do juiz) transbordava o
   *    rodapé porque `need()` só troca de página UMA vez ⇒ a linha agora CONTINUA na página
   *    seguinte, com o cabeçalho repetido, em vez de vazar.
   */
  table(cols: Array<{ head: string; frac: number }>, rows: string[][], opts: { size?: number } = {}): void {
    const size = opts.size ?? 7.4;
    const lineH = size + 2.2;
    const fracTotal = cols.reduce((s, c) => s + Math.max(c.frac, 0), 0) || 1;
    const widths = cols.map((c) => (Math.max(c.frac, 0) / fracTotal) * this.width);
    const drawHead = () => {
      this.need(18);
      this.doc.setFillColor(244, 246, 248);
      this.doc.rect(M.left, this.y - 8, this.width, 14, "F");
      this.doc.setFont("helvetica", "bold").setFontSize(size).setTextColor(...COLOR.soft);
      let x = M.left + 3;
      cols.forEach((c, i) => { this.doc.text(this.clip(ascii(c.head), widths[i] - 6), x, this.y); x += widths[i]; });
      this.y += 12;
    };
    drawHead();
    for (const row of rows) {
      // Medir com a MESMA fonte com que se desenha (antes media em negrito, herdado do cabeçalho).
      this.doc.setFont("helvetica", "normal").setFontSize(size);
      const cells = cols.map((_, i) => {
        const cellW = Math.max(widths[i] - 6, 12);
        const raw = ascii(row[i] ?? "");
        const lines = raw ? (this.doc.splitTextToSize(raw, cellW) as string[]) : [""];
        return lines.map((l) => this.clip(l, cellW));
      });
      const maxLines = Math.max(1, ...cells.map((c) => c.length));
      let li = 0;
      while (li < maxLines) {
        const fit = Math.floor((this.bottomLimit - this.y) / lineH);
        if (fit < 1) { this.newPage(); drawHead(); continue; }
        const take = Math.min(fit, maxLines - li);
        this.doc.setFont("helvetica", "normal").setFontSize(size).setTextColor(...COLOR.ink);
        let x = M.left + 3;
        cells.forEach((lines, i) => {
          for (let k = 0; k < take; k++) {
            const line = lines[li + k];
            if (line) this.doc.text(line, x, this.y + k * lineH);
          }
          x += widths[i];
        });
        this.y += take * lineH;
        li += take;
        if (li < maxLines) { this.newPage(); drawHead(); }
      }
      this.y += 3;
      this.doc.setDrawColor(...COLOR.rule).setLineWidth(0.3);
      this.doc.line(M.left, this.y - 3, A4.w - M.right, this.y - 3);
    }
    this.y += 8;
  }
}

// ── desenhos Mermaid → vetor ──────────────────────────────────────────────────

interface Diagram { title: string; code: string }

/** Extrai os blocos ```mermaid do documento de desenhos, com o título da seção anterior. */
export function parseMermaid(md: string): Diagram[] {
  const out: Diagram[] = [];
  const lines = md.split(/\r?\n/);
  let title = "Diagrama";
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{1,4}\s+(.+)$/.exec(lines[i]);
    if (h) { title = h[1].trim(); continue; }
    if (/^```mermaid\s*$/i.test(lines[i])) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      if (body.length) out.push({ title, code: body.join("\n") });
    }
  }
  return out;
}

/**
 * Desenha um diagrama no PDF. Falha do Mermaid ⇒ o CÓDIGO vai para o papel: um desenho que não sai
 * tem de aparecer como texto, nunca como página em branco.
 */
async function drawDiagram(w: Writer, d: Diagram, index: number): Promise<void> {
  w.h2(`${index}. ${d.title}`);
  let svgEl: SVGSVGElement | null = null;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;";
  document.body.appendChild(host);
  try {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "loose" });
    const { svg } = await mermaid.render(`pdf-mmd-${Date.now()}-${index}`, d.code);
    host.innerHTML = svg;
    svgEl = host.querySelector("svg");
  } catch {
    svgEl = null;
  }
  if (svgEl) {
    const bbox = svgEl.getBoundingClientRect();
    const natW = bbox.width || 900;
    const natH = bbox.height || 500;
    const scale = Math.min(w.width / natW, 1);
    const drawW = natW * scale;
    let drawH = natH * scale;
    // −14: o `need(drawH + 10)` abaixo tem de CABER numa página nova; com a altura útil cheia ele
    // pedia uma página que já estava em branco e o desenho ainda encostava no rodapé.
    const maxH = A4.h - M.top - M.bottom - 14;
    let finalW = drawW;
    if (drawH > maxH) { finalW = drawW * (maxH / drawH); drawH = maxH; }
    w.need(drawH + 10);
    try {
      const { svg2pdf } = await import("svg2pdf.js");
      await svg2pdf(svgEl, w.doc, { x: M.left, y: w.y, width: finalW, height: drawH });
      w.y += drawH + 12;
      document.body.removeChild(host);
      return;
    } catch {
      /* cai no fallback de código abaixo */
    }
  }
  document.body.removeChild(host);
  w.p("Não foi possível desenhar este diagrama neste dispositivo — o código Mermaid vai abaixo, na íntegra:",
    { italic: true, color: COLOR.soft, size: 7.6 });
  w.doc.setFont("courier", "normal").setFontSize(7).setTextColor(...COLOR.ink);
  for (const line of d.code.split(/\r?\n/)) {
    for (const piece of w.doc.splitTextToSize(line, w.width) as string[]) {
      w.need(10);
      // O courier volta a ser a fonte corrente após a troca de página feita pelo `need`.
      w.doc.setFont("courier", "normal").setFontSize(7).setTextColor(...COLOR.ink);
      w.doc.text(w.clip(piece, w.width), M.left, w.y);
      w.y += 9;
    }
  }
  w.y += 8;
}

// ── o relatório ───────────────────────────────────────────────────────────────

function sevOrder(s: string): number {
  return s === "blocker" ? 0 : s === "warning" ? 1 : 2;
}

async function render(r: TraceabilityReport): Promise<Doc> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const w = new Writer(doc, `${ascii(r.product.name)} — rastreabilidade (${PROFILE_LABEL[r.profile]}) — gerado em ${dt(r.generatedAt)}`);
  w.pageHeader();
  const detailed = r.profile !== "summary";

  // ── capa/identidade ──
  w.h1(`Rastreabilidade — ${r.product.name}`);
  w.p(PROFILE_HINT[r.profile], { italic: true, color: COLOR.soft });
  if (r.product.description) w.p(r.product.description);
  w.kv([
    ["Produto (id)", r.product.id],
    ["Hash do produto", short(r.product.productHash, 20)],
    ["Ciclo de vida", r.product.lifecycleStatus ?? "—"],
    ["Situação", r.product.status ?? "—"],
    ["System id", r.product.systemId ?? "—"],
    ["Criado em", dt(r.product.createdAt)],
    ["Projetos", num(r.product.projectsTotal)],
    ["Perfil / gerado em", `${PROFILE_LABEL[r.profile]} — ${dt(r.generatedAt)}`],
  ]);
  if (r.profile === "mixed") {
    w.p(r.changedSince
      ? `Recorte de revisão: só o que mudou desde a última promoção (${dt(r.changedSince)}), mais tudo o que segue aberto.`
      : "Este produto nunca foi promovido — não existe recorte temporal, então o relatório mostra a construção inteira. (Dizer \"nada mudou\" aqui seria falso.)",
      { italic: true, color: COLOR.accent });
  }

  // ── o que está em aberto ──
  w.h1("GAPs em aberto");
  w.p(`Contagem por severidade na última validação de cada projeto: ${tallyLine(r.gaps.counts)}.`);
  if (detailed && r.gaps.items.length) {
    const rows = r.gaps.items.slice().sort((a, b) => sevOrder(a.severity) - sevOrder(b.severity))
      .map((g) => [g.severity, g.title, g.file ?? "—", g.anchor ?? "—", short(g.fingerprint, 10)]);
    w.table([
      { head: "Severidade", frac: 0.11 }, { head: "GAP", frac: 0.36 },
      { head: "Arquivo", frac: 0.2 }, { head: "Âncora", frac: 0.23 }, { head: "Impressão", frac: 0.1 },
    ], rows);
  }

  // ── projetos: spec, certificado, repositório ──
  for (const p of r.projects) {
    w.h1(`Projeto — ${p.title}`);
    w.kv([
      ["Situação", p.status],
      ["Tipo", p.projectType ?? "—"],
      ["Versão", num(p.versionNumber)],
      ["Execuções", num(p.runCount)],
      ["Criado em", dt(p.createdAt)],
      ["Concluído em", dt(p.finishedAt)],
      ["Spec (chars)", num(p.spec.totalChars)],
      ["Hash da spec", short(p.spec.specHash, 20)],
      ["Certificado", p.certificate?.level ?? "—"],
      ["Código do certificado", p.certificate?.code ?? "—"],
      ["Repositório", p.repo?.fullName ?? "—"],
      ["Último push", dt(p.repo?.pushedAt ?? null)],
    ]);
    if (p.certificate?.checks?.length) {
      w.h2("Certificado Genesis Factory — verificações");
      w.table([
        { head: "Check", frac: 0.08 }, { head: "Resultado", frac: 0.12 }, { head: "O que diz", frac: 0.8 },
      ], p.certificate.checks.map((c) => [
        c.id ?? "—",
        c.ok === true ? "passou" : c.ok === false ? "REPROVOU" : "indeterminado",
        `${c.label ?? ""}${c.detail ? ` — ${c.detail}` : ""}`,
      ]));
    }
    if (detailed && p.spec.files.length) {
      w.h2("Inventário da spec (hash por arquivo)");
      w.p("\"Julgado por inteiro\" só é sim quando o hash lido pelo juiz adversarial é o hash do arquivo que está no disco agora.",
        { italic: true, color: COLOR.soft, size: 7.6 });
      w.table([
        { head: "Arquivo", frac: 0.4 }, { head: "Principal", frac: 0.1 }, { head: "Chars", frac: 0.11 },
        { head: "SHA-256", frac: 0.22 }, { head: "Julgado por inteiro", frac: 0.17 },
      ], p.spec.files.map((f) => [
        f.path, f.isPrimary ? "sim" : "—", num(f.chars), short(f.contentSha256, 16),
        f.judgedFullAtThisContent ? "sim" : "não",
      ]));
    }
  }

  // ── desenhos da arquitetura ──
  const comDesenhos = r.projects.filter((p) => p.spec.diagrams);
  if (comDesenhos.length) {
    for (const p of comDesenhos) {
      w.h1(`Arquitetura desenhada — ${p.title}`);
      w.p(`Fonte: \`${p.spec.diagrams!.path}\` (${num(p.spec.diagrams!.chars)} chars), criado pelo laço autônomo quando a arquitetura fechou.`,
        { italic: true, color: COLOR.soft });
      const diagrams = parseMermaid(p.spec.diagrams!.content);
      if (!diagrams.length) w.p("O documento de desenhos existe, mas nenhum bloco Mermaid foi encontrado nele.");
      for (let i = 0; i < diagrams.length; i++) await drawDiagram(w, diagrams[i], i + 1);
    }
  } else {
    w.h1("Arquitetura desenhada");
    w.p("Ainda não existe documento de desenhos (`arquitetura-diagramas.md`). O laço autônomo o cria quando o juiz declara a arquitetura fechada — até então, desenhar seria desenhar uma arquitetura que ainda muda.",
      { italic: true, color: COLOR.soft });
  }

  // ── validações ──
  if (r.validations.length) {
    w.h1("Validações adversariais");
    w.table([
      { head: "Quando", frac: 0.16 }, { head: "Resultado", frac: 0.12 }, { head: "Hash da spec", frac: 0.14 },
      { head: "Estágio B", frac: 0.1 }, { head: "Achados", frac: 0.28 }, { head: "Cobertura", frac: 0.2 },
    ], r.validations.map((v) => [
      dt(v.createdAt), v.status, short(v.specHash, 12), v.stageBRan === null ? "—" : v.stageBRan ? "rodou" : "não rodou",
      `${v.findings} (${tallyLine(v.findingsBySeverity)})`,
      v.filesTotal ? `${v.filesJudgedFull}/${v.filesTotal} arquivos por inteiro` : `${v.filesJudgedFull} arquivo(s)`,
    ]));
  }

  // ── vereditos e triagem (o que sustenta "aberto mas não impeditivo") ──
  if (detailed && r.verdicts.length) {
    w.h1("Vereditos de promovibilidade (o juiz)");
    w.p("Cada linha é um GAP que segue aberto porque o juiz declarou que ele NÃO impede promover — com o artefato da fábrica que o resolve.", { italic: true, color: COLOR.soft });
    w.table([
      { head: "Quando", frac: 0.13 }, { head: "GAP", frac: 0.26 }, { head: "Arquivo/âncora", frac: 0.22 },
      { head: "Impacto", frac: 0.13 }, { head: "Resolve na fábrica", frac: 0.18 }, { head: "Reinc.", frac: 0.08 },
    ], r.verdicts.map((v) => [
      dt(v.createdAt), v.title ?? short(v.fingerprint, 10), `${v.filePath ?? "—"}${v.anchor ? ` / ${v.anchor}` : ""}`,
      v.impact ?? "—", v.factoryArtifact ?? "—",
      `${num(v.recurrenceTimes)}${v.revokedAt ? " (revogado)" : ""}`,
    ]));
  }
  if (detailed && r.triage.length) {
    w.h1("Triagem de achados");
    w.table([
      { head: "Quando", frac: 0.14 }, { head: "Estado", frac: 0.13 }, { head: "Motivo", frac: 0.22 },
      { head: "Severidade", frac: 0.13 }, { head: "Quem", frac: 0.16 }, { head: "Reinc.", frac: 0.1 }, { head: "Revogado", frac: 0.12 },
    ], r.triage.map((t) => [
      dt(t.createdAt), t.state, t.reasonCode ?? "—", t.severityAt ?? "—", t.actorRole ?? "—",
      num(t.recurrenceCount), t.revokedAt ? dt(t.revokedAt) : "—",
    ]));
  }

  // ── constraints declaradas (o Policy Gate) ──
  w.h1("Constraints declaradas (Policy Gate)");
  w.p(`Por (aplica-se a / verificável em / severidade): ${tallyLine(r.constraints.counts)}.`);
  if (detailed && r.constraints.items.length) {
    w.table([
      { head: "Chave", frac: 0.16 }, { head: "Aplica-se a", frac: 0.12 }, { head: "Verificável em", frac: 0.12 },
      { head: "Sev.", frac: 0.08 }, { head: "Asserção", frac: 0.52 },
    ], r.constraints.items.map((c) => [
      c.constraintKey, c.appliesTo ?? "—", c.verifiableAt ?? "—", c.severity ?? "—", c.assertion ?? "—",
    ]));
  }

  // ── o diário do laço autônomo ──
  if (detailed && r.autonomyRuns.length) {
    w.h1("Laço autônomo — execuções");
    w.table([
      { head: "Início", frac: 0.14 }, { head: "Fim", frac: 0.14 }, { head: "Desfecho", frac: 0.12 },
      { head: "Modo", frac: 0.1 }, { head: "Passes", frac: 0.1 }, { head: "Rodadas", frac: 0.1 }, { head: "GAPs", frac: 0.3 },
    ], r.autonomyRuns.map((a) => [
      dt(a.createdAt), dt(a.finishedAt), a.status, a.mode ?? "—",
      `${num(a.passes)}/${num(a.maxRounds)}`, num(a.round), num(a.gapsCurrent),
    ]));
    for (const a of r.autonomyRuns) {
      if (!a.rounds.length) continue;
      w.h2(`Rodadas da execução de ${dt(a.createdAt)} (${a.status})`);
      w.table([
        { head: "#", frac: 0.05 }, { head: "Passe", frac: 0.07 }, { head: "Arquivo", frac: 0.22 },
        { head: "GAPs antes", frac: 0.09 }, { head: "O que aconteceu", frac: 0.57 },
      ], a.rounds.map((x) => [
        String(x.round ?? "—"), String(x.pass ?? "—"), String(x.filePath ?? "—"),
        String(x.gapsBefore ?? "—"), String(x.note ?? x.error ?? "—"),
      ]), { size: 6.8 });
      if (a.lastError) w.p(`Desfecho declarado: ${a.lastError}`, { size: 7.6, color: COLOR.soft, italic: true });
    }
  }

  // ── fábrica: execuções, tarefas, promoções, deploys ──
  if (r.factory.pipelineRuns.length || Object.keys(r.factory.tasksByStatus).length) {
    w.h1("Fábrica — execuções e tarefas");
    if (r.factory.pipelineRuns.length) {
      w.table([
        { head: "Início", frac: 0.16 }, { head: "Fim", frac: 0.16 }, { head: "Gatilho", frac: 0.12 },
        { head: "Duração", frac: 0.12 }, { head: "Motivo de parada", frac: 0.2 }, { head: "Tokens (in/out)", frac: 0.16 }, { head: "US$", frac: 0.08 },
      ], r.factory.pipelineRuns.map((p) => [
        dt(p.startedAt), dt(p.finishedAt), p.trigger ?? "—",
        p.durationSec === null ? "—" : `${Math.round(p.durationSec / 60)} min`,
        p.stopReason ?? "—", `${num(p.inputTokens)}/${num(p.outputTokens)}`,
        p.estimatedCostUsd === null ? "—" : p.estimatedCostUsd.toFixed(2),
      ]));
    }
    w.p(`Tarefas por situação: ${tallyLine(r.factory.tasksByStatus)}.`);
    if (detailed && r.factory.tasks.length) {
      w.table([
        { head: "Tarefa", frac: 0.14 }, { head: "Módulo", frac: 0.18 }, { head: "Papel", frac: 0.16 },
        { head: "Situação", frac: 0.14 }, { head: "Artefatos", frac: 0.24 }, { head: "Atualizada", frac: 0.14 },
      ], r.factory.tasks.map((t) => [
        t.taskId ?? "—", t.module ?? "—", t.ownerRole ?? "—", t.status ?? "—", t.artifactsRef ?? "—", dt(t.updatedAt),
      ]));
    }
  }
  if (r.promotions.length) {
    w.h1("Promoções para a fábrica");
    for (const p of r.promotions) {
      w.h2(`${dt(p.createdAt)} — ${p.status ?? "—"} (ordem decidida por ${p.edgesSource ?? "—"}${p.model ? `, modelo ${p.model}` : ""})`);
      if (p.items.length) {
        w.table([
          { head: "Onda", frac: 0.1 }, { head: "Camada", frac: 0.2 }, { head: "Projeto", frac: 0.45 }, { head: "Despachado em", frac: 0.25 },
        ], p.items.map((i) => [
          num(i.wave), i.layer ?? "—",
          r.projects.find((x) => x.id === i.projectId)?.title ?? i.projectId,
          dt(i.dispatchedAt),
        ]));
      }
    }
  }
  if (r.deployments.length) {
    w.h1("Deploys de backend");
    w.table([
      { head: "Quando", frac: 0.15 }, { head: "Nuvem", frac: 0.1 }, { head: "Classe", frac: 0.12 },
      { head: "Ciclo", frac: 0.12 }, { head: "Situação", frac: 0.13 }, { head: "URL", frac: 0.26 }, { head: "Imagem", frac: 0.12 },
    ], r.deployments.map((d) => [
      dt(d.createdAt), d.provider ?? "—", d.class ?? "—", d.lifecycle ?? "—", d.status ?? "—",
      d.appUrl ?? "—", short(d.imageTag, 14),
    ]));
  }

  // ── o que ficou de fora (obrigatório) ──
  w.h1("O que ficou de fora deste relatório");
  if (!r.truncated.length) {
    w.p("Nada: todas as seções entraram completas, sem teto aplicado.");
  } else {
    w.p("Cada linha é um teto que mordeu. O dado continua no Genesis — só não caberia no papel.", { italic: true, color: COLOR.soft });
    w.table([
      { head: "Seção", frac: 0.4 }, { head: "No relatório", frac: 0.2 }, { head: "Existem", frac: 0.2 }, { head: "Teto", frac: 0.2 },
    ], r.truncated.map((c) => [c.section, num(c.kept), num(c.total), num(c.limit)]));
  }
  w.p("Fonte de todos os números: banco do Zentriz Genesis, lido no instante indicado no cabeçalho. Hashes SHA-256 permitem conferir qualquer arquivo da spec byte a byte.",
    { size: 7.4, color: COLOR.soft });

  w.stampFooters(w.page);
  return doc;
}

/** Nome do arquivo: produto + perfil + data, sem acento nem espaço (viaja bem em qualquer SO). */
export function pdfFilename(productName: string, profile: TraceabilityProfile, when = new Date()): string {
  const slug = productName.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "produto";
  const d = when.toISOString().slice(0, 10);
  return `rastreabilidade-${slug}-${profile}-${d}.pdf`;
}

/**
 * Busca os fatos, desenha e INICIA O DOWNLOAD (o pedido do Jean é o arquivo na mão do usuário).
 * Devolve o que foi gerado para a tela poder dizer "12 páginas, 3 desenhos".
 */
export async function downloadTraceabilityPdf(
  productId: string, profile: TraceabilityProfile,
): Promise<{ filename: string; pages: number; diagrams: number; report: TraceabilityReport }> {
  const report = await apiGet<TraceabilityReport>(`/api/products/${productId}/traceability?profile=${profile}`);
  const doc = await render(report);
  const filename = pdfFilename(report.product.name, profile);
  doc.save(filename);
  const diagrams = report.projects.reduce((acc, p) => acc + (p.spec.diagrams ? parseMermaid(p.spec.diagrams.content).length : 0), 0);
  return { filename, pages: doc.getNumberOfPages(), diagrams, report };
}
