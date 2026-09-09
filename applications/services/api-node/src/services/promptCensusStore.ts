/**
 * 🔴 GAP-159 — o censo do prompt passa a sobreviver ao deploy (migração 121).
 *
 * ## O que foi medido
 *
 * No deploy do GAP-158 (2026-09-09, 15:10 UTC) o `docker compose up -d api` — o fluxo de deploy
 * CANÔNICO deste produto, rodado várias vezes por dia — apagou todos os `[prompt-census]` do dia. O
 * censo do GAP-146 nasceu declarando "etapa 1 é SÓ LOG; o corte vem depois, decidido pela distribuição
 * MEDIDA", e o censo de cabeça do GAP-153 vive numa tabela em MEMÓRIA do processo. Ou seja: as duas
 * decisões que faltam para economizar token de verdade no cérebro da Bancada — cortar o prompt do CTO
 * e marcar ponto de cache — dependiam de uma série que o próprio deploy destrói.
 *
 * ## Por que não é só "guardar o log"
 *
 * O restart zera `headSeen`. Depois de um deploy, TODA primeira chamada é contada como
 * `head_repeat=estreia` — inclusive quando o mesmo prefixo passou 30 s antes e o cache do PROVEDOR
 * (TTL de 5 min, do lado dele) ainda estaria quente. O instrumento subestima a taxa de acerto de forma
 * sistemática, e "não vale marcar cache" seria decidido com o número errado: é a família do GAP-147
 * (a economia existir e o medidor mentir), só que na direção contrária.
 *
 * Então a persistência faz DUAS coisas, e as duas são medição, nunca comportamento:
 *  1. grava a linha do censo (só tamanhos — nenhum byte de conteúdo de spec);
 *  2. quando o processo disse "estreia", pergunta ao banco se aquele MESMO prefixo já passou. Se
 *     passou, o veredicto é corrigido e a origem do veredicto é DECLARADA (`head_source='banco'`).
 *     Sem declarar, uma medição do banco viraria indistinguível de uma do processo.
 *
 * Nada aqui corta bloco de prompt nem marca cache: instrumento ANTES do comportamento (GAP-148/150).
 */
import type { PromptCensus, PromptCensusSink, PromptHeadCensus } from "./promptCensus.js";
import { PROMPT_CACHE_TTL_MS } from "./promptCensus.js";

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

/** Fonte do veredicto de repetição da cabeça — vai para a coluna `head_source`. */
export type HeadSource = "memoria" | "banco";

/**
 * A linha como ela vai ao banco. Exportada porque é o que o teste precisa afirmar: o valor gravado,
 * não o SQL. O que apodrece num instrumento é o campo que ninguém conferiu.
 */
export interface PromptCensusRow {
  origem: string;
  role: string | null;
  file: string | null;
  total: number;
  fields: Record<string, number>;
  outros: number;
  head_hash: string | null;
  head_chars: number | null;
  head_cacheable: boolean | null;
  head_seen: number | null;
  head_since_last_ms: number | null;
  head_hit_within_ttl: boolean | null;
  head_source: HeadSource | null;
  /**
   * 🔴 GAP-167 — o maior corte de prefixo que repetiu dentro do TTL, e a série inteira de cortes.
   * `0` é MEDIÇÃO (nem o piso do provedor repete ⇒ o defeito é a ordem dos blocos, não o cache);
   * `null` é AUSÊNCIA de medição (o caminho não declarou cabeça).
   */
  head_prefix_hit_chars: number | null;
  head_prefix_cuts: PromptHeadCensus["prefixCuts"] | null;
}

/**
 * Reconciliação da cabeça contra o banco. Só é consultada quando o processo relatou ESTREIA e há
 * cabeça declarada: se o processo já conhecia o prefixo, o veredicto dele é o melhor que existe (é ele
 * quem faz a chamada) e uma query seria gasto por nada.
 *
 * `head_seen` também é corrigido para `2` no caso reconciliado, porque "visto 1 vez" seria falso — mas
 * NÃO se tenta reconstruir a contagem histórica exata: contar linhas antigas daria um número que
 * mistura processos e não é o que o provedor enxerga.
 */
export async function reconcileHeadFromDb(
  db: Db,
  censo: PromptCensus,
): Promise<{ sinceLastMs: number; hitWithinTtl: boolean } | null> {
  const h = censo.head;
  if (!h || h.sinceLastMs !== null) return null;
  const { rows } = await db.query(
    `SELECT created_at FROM prompt_census
      WHERE origem = $1 AND head_hash = $2
      ORDER BY created_at DESC LIMIT 1`,
    [censo.origem, h.hash],
  );
  const row = rows[0] as { created_at?: string | Date } | undefined;
  if (!row?.created_at) return null;
  const antes = new Date(row.created_at).getTime();
  if (!Number.isFinite(antes)) return null;
  // Relógio do banco × relógio do processo: um delta negativo (skew) não é acerto de cache, é ruído.
  const sinceLastMs = Date.now() - antes;
  if (sinceLastMs < 0) return null;
  return { sinceLastMs, hitWithinTtl: sinceLastMs <= PROMPT_CACHE_TTL_MS };
}

/** Monta a linha a partir do censo (e da reconciliação, quando houve). Pura — é o que o teste afirma. */
export function censusRow(
  censo: PromptCensus,
  reconciliado: { sinceLastMs: number; hitWithinTtl: boolean } | null,
): PromptCensusRow {
  const h = censo.head;
  return {
    origem: censo.origem,
    role: censo.role,
    file: censo.file,
    total: censo.total,
    fields: censo.fields,
    // Negativo é DEFEITO com nome (contagem dupla no chamador), nunca economia: vai cru para o banco.
    outros: censo.outros,
    head_hash: h?.hash ?? null,
    head_chars: h?.chars ?? null,
    head_cacheable: h?.cacheable ?? null,
    head_seen: h ? (reconciliado ? Math.max(h.seen, 2) : h.seen) : null,
    head_since_last_ms: reconciliado ? reconciliado.sinceLastMs : (h?.sinceLastMs ?? null),
    head_hit_within_ttl: reconciliado ? reconciliado.hitWithinTtl : (h?.hitWithinTtl ?? null),
    // Sem cabeça declarada não há veredicto e, portanto, não há fonte de veredicto (NULL != 'memoria').
    head_source: h ? (reconciliado ? "banco" : "memoria") : null,
    // 🔴 GAP-167: os cortes NÃO são reconciliados contra o banco. A reconciliação existe para o caso do
    // restart (o processo diz "estreia" e o banco prova que o prefixo passou), e ela é feita por
    // `head_hash` — o banco não guarda o hash de cada corte, então afirmar acerto de corte a partir
    // dele seria inventar. Depois de um deploy os cortes ficam subestimados por uma janela, e isso é
    // dito aqui em vez de ser corrigido por chute.
    head_prefix_hit_chars: h?.prefixHitChars ?? null,
    head_prefix_cuts: h?.prefixCuts ?? null,
  };
}

/**
 * Grava uma linha do censo. Best-effort: nunca lança e nunca faz o chamador esperar por banco — o
 * prompt já foi montado e a chamada de LLM não pode falhar porque o instrumento falhou.
 */
export async function persistPromptCensus(db: Db, censo: PromptCensus): Promise<void> {
  const reconciliado = await reconcileHeadFromDb(db, censo).catch(() => null);
  const r = censusRow(censo, reconciliado);
  if (reconciliado) {
    // A linha de log já saiu dizendo "estreia". Corrigir em silêncio deixaria o log e o banco
    // divergindo sem explicação — e quem lê o log é quem decide o cache.
    console.log(
      `[prompt-census] correção de cabeça origem=${r.origem} head=${r.head_hash}: o processo relatou`
      + ` estreia (reiniciou), mas o mesmo prefixo passou há ${Math.round(reconciliado.sinceLastMs / 1000)}s`
      + ` ⇒ ${reconciliado.hitWithinTtl ? "ACERTO dentro do TTL" : "fora-do-ttl"} (fonte=banco).`,
    );
  }
  await db.query(
    `INSERT INTO prompt_census
       (origem, role, file, total, fields, outros, head_hash, head_chars, head_cacheable,
        head_seen, head_since_last_ms, head_hit_within_ttl, head_source,
        head_prefix_hit_chars, head_prefix_cuts)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    [
      r.origem, r.role, r.file, r.total, JSON.stringify(r.fields), r.outros,
      r.head_hash, r.head_chars, r.head_cacheable,
      r.head_seen, r.head_since_last_ms, r.head_hit_within_ttl, r.head_source,
      r.head_prefix_hit_chars,
      r.head_prefix_cuts === null ? null : JSON.stringify(r.head_prefix_cuts),
    ],
  );
}

/**
 * O sink de produção. Registrado UMA vez no boot (`index.ts`) — não em cada call site — porque com dois
 * caminhos medidos e mais por vir, escolher por chamador é o defeito do GAP-156 (um entrega menos que o
 * outro e os dois logs parecem iguais).
 */
export function makePgPromptCensusSink(db: Db): PromptCensusSink {
  return (censo) => {
    void persistPromptCensus(db, censo).catch((e) => {
      console.warn(`[prompt-census] persistência indisponível (o log segue sendo a medição): ${(e as Error).message}`);
    });
  };
}
