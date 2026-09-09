/**
 * 🔴 GAP-128 — evidência que DECIDE não pode ser cortada em silêncio.
 *
 * Medido em prod (NVX LastMile, 2026-09-09): de 2.417 findings gravados nos últimos 3 dias,
 * **2.066 (85%)** têm `rationale` com mais de 500 chars, e **7** estão exatamente em 1.200 chars
 * (4 deles terminando no meio de uma palavra) — ou seja, o teto de ingestão de `parseStageBFindings`
 * já morde. Todos os consumidores desse texto cortavam mais um pouco, sempre em silêncio:
 * dossiê do CTO/roteador em 400, oráculos em 500, aprendizado em 320, triagem em 600.
 *
 * O dano não é perder bytes: é **decidir com um fato que parece completo e não é**. Uma justificativa
 * cujo "…exceto quando o tenant é X" vive na cauda vira, depois do corte, uma regra absoluta; o
 * roteador que só lê 400 chars pode não ver o nome do arquivo citado no fim e mandar o GAP para o
 * lugar errado (GAP que chega no arquivo errado nunca é corrigido).
 *
 * A lei do ecossistema já estava escrita (GAP-63, GAP-70, GAP-123, GAP-127): **cortar é legítimo,
 * mentir sobre o corte não é.** Este módulo é o transporte dessa lei para texto de evidência: o teto
 * continua existindo (orçamento de prompt é decisão de custo, não de conteúdo), mas quem lê passa a
 * saber que o fato continua — e quanto ficou de fora.
 */

/** Marca visível em prompt e em banco. Curta de propósito: entra em CADA linha de finding. */
function marker(kept: number, total: number): string {
  return ` …⟨CORTADO: ${kept} de ${total} chars — o fato CONTINUA⟩`;
}

/**
 * Corta `text` em `max` chars DECLARANDO o corte. Nunca devolve mais que `max` chars.
 *
 * O texto útil é reduzido para caber a marca, e o corte procura a última fronteira de palavra para
 * não terminar no meio de um identificador (`tenant_i`, `§7.2`), o que confundiria o leitor.
 */
export function cutEvidence(text: string | null | undefined, max: number): string {
  const flat = String(text ?? "");
  if (flat.length <= max) return flat;
  const total = flat.length;
  // Espaço para a marca; se o teto for tão pequeno que não cabe, a marca vence o conteúdo —
  // é melhor devolver só o aviso do que devolver um trecho que se apresenta como o fato inteiro.
  const room = max - marker(max, total).length;
  if (room <= 0) return marker(0, total).trim().slice(0, Math.max(0, max));
  const head = flat.slice(0, room);
  const lastSpace = head.lastIndexOf(" ");
  const kept = lastSpace > room * 0.6 ? head.slice(0, lastSpace) : head;
  return `${kept.trimEnd()}${marker(kept.trimEnd().length, total)}`;
}

/** `true` quando `cutEvidence` mordeu — para logar/contar corte sem reparsear a marca. */
export function wouldCut(text: string | null | undefined, max: number): boolean {
  return String(text ?? "").length > max;
}
