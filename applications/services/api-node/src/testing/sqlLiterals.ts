/**
 * sqlLiterals.ts — helper de TESTE (guardas estáticas). Extrai os literais de string/template de um arquivo TypeScript
 * (o "texto de cada consulta"), com o número da linha inicial. Tokenizador mínimo: aspas simples/duplas, crases com `${ ... }`
 * aninhado (o conteúdo das interpolações fica no texto, para a guarda enxergar `notHiddenProjectSql(...)`), comentários ignorados.
 * Não é parser de TS: regex literais com aspas são raros neste código e, se confundirem, a guarda erra para o lado de MAIS literais.
 */
export interface SqlLiteral { line: number; text: string }

export function extractLiterals(src: string): SqlLiteral[] {
  const out: SqlLiteral[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  function readTemplate(): string {
    // posição logo após a crase de abertura; devolve o texto bruto (inclui o conteúdo das ${ })
    let text = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") { text += src.slice(i, i + 2); if (src[i + 1] === "\n") line++; i += 2; continue; }
      if (c === "`") { i++; return text; }
      if (c === "$" && src[i + 1] === "{") {
        text += "${"; i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === "{") depth++;
          else if (d === "}") { depth--; if (depth === 0) { text += "}"; i++; break; } }
          else if (d === "`") { i++; text += "`" + readTemplate() + "`"; continue; }
          else if (d === "'" || d === '"') {
            const q = d; text += d; i++;
            while (i < n && src[i] !== q) { if (src[i] === "\\") { text += src[i]; i++; } text += src[i]; i++; }
            text += q; i++; continue;
          }
          if (d === "\n") line++;
          text += d; i++;
        }
        continue;
      }
      if (c === "\n") line++;
      text += c; i++;
    }
    return text;
  }

  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; } i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c; const start = line; i++;
      let t = "";
      while (i < n && src[i] !== q && src[i] !== "\n") { if (src[i] === "\\") { t += src[i]; i++; } t += src[i]; i++; }
      i++;
      out.push({ line: start, text: t });
      continue;
    }
    if (c === "`") { const start = line; i++; out.push({ line: start, text: readTemplate() }); continue; }
    i++;
  }
  return out;
}
