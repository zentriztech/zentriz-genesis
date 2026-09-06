/**
 * Recorte de Markdown por SEÇÃO — usado por dois caminhos que precisam do MESMO comportamento.
 *
 * Nasceu privado em `services/specSiblingContext.ts` (A5.6, para mostrar o irmão citado sem gastar o
 * orçamento na abertura do arquivo) e foi extraído aqui quando o arquivo ALVO passou a precisar do
 * mesmo recorte (A5.7 / GAP-7). Se as duas cópias divergirem, o modelo vê o irmão com uma régua e o
 * alvo com outra — e um `SEARCH` montado com a régua errada não casa no arquivo, queimando a rodada.
 *
 * Regra que vale para os dois usos: o texto devolvido é sempre trecho VERBATIM do arquivo. É o que
 * permite ao CTO-editor montar blocos `SEARCH/REPLACE` a partir de um recorte — o que ele leu existe
 * no arquivo, byte a byte.
 */

export interface MdSection {
  /** Linha de cabeçalho ATX (`## 3. Erros`) ou `(topo do arquivo)` para o preâmbulo. */
  heading: string;
  /** Corpo VERBATIM, incluindo a própria linha de cabeçalho. */
  body: string;
}

/** Quebra o Markdown em seções por cabeçalho ATX, preservando o cabeçalho em cada pedaço. */
export function splitSections(content: string): MdSection[] {
  const out: MdSection[] = [];
  let heading = "(topo do arquivo)";
  let buf: string[] = [];
  const flush = (): void => { if (buf.join("\n").trim()) out.push({ heading, body: buf.join("\n") }); };
  for (const line of content.split("\n")) {
    if (/^#{1,6}\s+\S/.test(line)) { flush(); heading = line.trim(); buf = [line]; }
    else buf.push(line);
  }
  flush();
  return out;
}

/** Sumário só com os cabeçalhos reais (o preâmbulo não tem cabeçalho para listar). */
export function headingOutline(secs: MdSection[]): string {
  return secs.map((s) => s.heading).filter((h) => h.startsWith("#")).join("\n");
}

/**
 * Corta preservando o começo. O marcador é explícito porque o modelo precisa saber que o trecho
 * acabou ali por ORÇAMENTO, não porque o arquivo acabou.
 */
export function clipSection(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[… seção truncada …]`;
}

/**
 * Seções que mencionam pelo menos um dos termos, ordenadas por número de acertos (mais relevante
 * primeiro) e, em empate, pela ordem do arquivo. O índice original vai junto para quem quiser
 * reemitir em ordem de LEITURA depois de escolher por relevância.
 */
export function scoreSections(secs: MdSection[], terms: string[]): Array<{ i: number; section: MdSection; hits: number }> {
  return secs
    .map((section, i) => {
      const hay = section.body.toLowerCase();
      let hits = 0;
      for (const t of terms) if (t && hay.includes(t)) hits += 1;
      return { i, section, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i);
}
