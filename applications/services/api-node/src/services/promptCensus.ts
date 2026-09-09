/**
 * 🔴 GAP-146 — CENSO DO PROMPT no lado da api (o prompt do `spec_cto` é montado AQUI, não no `agents`).
 *
 * Medição de prod (3 dias): `spec_cto` = 764 chamadas × 69.548 tokens de ENTRADA = 52,9 M tokens, a
 * maior conta unitária do cérebro da Bancada. O que ninguém sabia era de QUEM: o prompt por-arquivo é
 * uma pilha de ~15 blocos (mapa do produto, irmãos, oráculos, fatos do manifesto, recorte do arquivo,
 * lista de GAPs, histórico de tentativas…) e nenhum deles jamais foi medido no prompt que SAI.
 *
 * O censo do `agents` (`runtime._prompt_census_record`) mede só `build_user_message`, e o caminho
 * dominante do CTO — edição por arquivo com `SPEC_CTO_EDIT_FORMAT=edits` — NÃO passa por lá: a api
 * monta `prompt_override` + `user_message` e chama `/invoke/raw`. Medido ao vivo em prod: zero linhas
 * `[prompt-census]` com o laço rodando CTO. Este módulo fecha esse furo do mesmo lado onde o prompt
 * nasce, e de propósito ANTES de qualquer recorte: recortar "por relevância" sem medir é adivinhação,
 * e adivinhar antes de medir foi exatamente o GAP-147 (o cache economizou de verdade e o medidor
 * passou a mentir).
 *
 * Regras do instrumento:
 *
 *  1. **etapa 1 é SÓ LOG** — nada é persistido e nenhum prompt muda de um byte. O corte vem depois,
 *     decidido pela distribuição medida.
 *  2. **o censo FECHA**: `soma(campos) + outros == total`. `outros` são delimitadores, rótulos e a
 *     instrução final; se ficar NEGATIVO houve contagem dupla e o log grita, porque um instrumento
 *     que se engana sozinho é pior que nenhum.
 *  3. **conta o ENTREGUE**, nunca o pedido: cada campo é medido pelo tamanho do texto que entrou no
 *     prompt (já cortado pelo orçamento do bloco), senão o campo cortado apareceria como despesa que
 *     não existe.
 *  4. **não carrega conteúdo** — só tamanhos. O censo vai para log; spec de cliente não vai.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 GAP-153 — o caminho MAIS CARO da Bancada nunca marcou ponto de cache, e ninguém mediu se dava
 *
 * O GAP-142 trouxe cache de prompt e mediu −52% de custo… no `spec_validator` (os refutadores). Uma
 * varredura do repositório mostra que `cache_prefix=True` tem exatamente UM chamador
 * (`spec_validator.py`): `/invoke/raw` — por onde passa TODA a escrita da Bancada, o `spec_cto` de
 * 764 chamadas × 69.548 tokens de entrada — **não aceita nem repassa o parâmetro**. O escritor, que é
 * a maior conta do cérebro, paga preço cheio em 100% das chamadas.
 *
 * O que NÃO se pode fazer é sair marcando: a lei do próprio GAP-142 é que prefixo que não repete
 * dentro do TTL de 5 min paga **1,25×** na escrita e não lê nada de volta — marcar às cegas é
 * REGRESSÃO de custo com cara de otimização. E o GAP-147 já mostrou o pior desfecho possível dessa
 * pressa: a economia existir e o MEDIDOR passar a mentir.
 *
 * Então esta etapa faz o que o GAP-148/GAP-150 fixaram como ordem — **instrumento antes do
 * comportamento**: mede se a CABEÇA ESTÁVEL do prompt (tudo que vem antes da primeira parte volátil)
 * repete byte a byte dentro da janela do TTL, e quantas vezes. Só com essa taxa na mão a marcação
 * deixa de ser aposta. Nenhum byte do prompt muda aqui, e nada é persistido.
 *
 * Duas hipóteses medíveis, com desfechos opostos — é por isso que a medição é por `origem`:
 *
 *  * `api-gapfile` (laço autônomo): a cabeça é mapa+irmãos+oráculos+manifesto+índice; o conteúdo do
 *    arquivo e a lista de GAPs mudam a cada rodada. Aposta: repete só entre RETENTATIVAS do mesmo
 *    arquivo (rework), não entre rodadas.
 *  * `api-rawfile` (chat por-arquivo): a cabeça inclui o CONTEÚDO do arquivo, e o que muda é só o
 *    transcript no fim. Aposta: repete em quase todo turno seguinte da mesma conversa — o caso de
 *    cache mais óbvio do produto, e o que hoje paga cheio.
 */

import { createHash } from "node:crypto";

/**
 * Mínimo de chars para a marcação valer a pena. O piso do provedor é de **1.024 tokens** de prefixo
 * para os modelos Claude grandes (abaixo disso o ponto de cache é ignorado e a escrita de 1,25× é
 * paga por nada). 1.024 tokens ≈ 4.096 chars na razão ~4 chars/token medida nas specs em PT-BR deste
 * produto. Cabeça abaixo do piso é declarada como NÃO-CACHEÁVEL no log, em vez de contar como
 * candidata: o número que decide não pode incluir chamadas onde marcar é proibido.
 */
export const PROMPT_CACHE_MIN_HEAD_CHARS = 4096;

/**
 * Janela do cache de prompt do provedor (5 min). Repetição FORA dela não é acerto: o prefixo já
 * expirou e a 2ª chamada pagaria escrita de novo. Medir "repetiu algum dia" seria inflar a taxa.
 */
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Quantas cabeças distintas manter em memória. Teto para o instrumento não virar vazamento. */
const HEAD_TABLE_MAX = 512;

/** hash da cabeça → (instante da última vez, quantas vezes já foi vista). Só no processo, nunca no banco. */
const headSeen = new Map<string, { at: number; n: number }>();

/** Zera a tabela de cabeças (teste). Em produção nunca é chamado: a tabela expira sozinha pelo TTL. */
export function resetPromptCensusHeads(): void {
  headSeen.clear();
}

/**
 * 🔴 GAP-159 — para onde o censo vai DEPOIS do log.
 *
 * Medido no deploy do GAP-158: recriar o container da api (o fluxo de deploy canônico, várias vezes
 * por dia) apaga todos os `[prompt-census]`. As duas "etapas 2" prometidas — cortar o prompt do CTO
 * pela distribuição medida (GAP-146) e marcar ponto de cache pela taxa medida (GAP-153) — dependem de
 * uma série que não sobrevivia ao próprio deploy.
 *
 * O destino é um SINK registrado UMA vez no boot, e não um parâmetro de quem chama, de propósito: com
 * dois caminhos medidos (`api-gapfile` e `api-rawfile`) e mais por vir, passar o `db` em cada call
 * site é o convite exato para o defeito do GAP-156 — um chamador persistindo e o outro não, com o log
 * dos dois parecendo igual. Assim, quem mede não escolhe se persiste.
 */
export type PromptCensusSink = (censo: PromptCensus) => void;

let sink: PromptCensusSink | null = null;

/** Registra (ou remove, com `null`) o destino do censo. Sem sink registrado nada é persistido. */
export function setPromptCensusSink(fn: PromptCensusSink | null): void {
  sink = fn;
}

/** O que se sabe sobre a CABEÇA ESTÁVEL desta chamada. `null` quando o chamador não declarou uma. */
export type PromptHeadCensus = {
  /** Identidade da cabeça (sha256 truncado). Identidade, nunca conteúdo — o texto não sai daqui. */
  hash: string;
  /** Chars da cabeça (o que seria lido do cache a 0,1× em vez de 1×). */
  chars: number;
  /** `true` se a cabeça atinge o piso do provedor. `false` ⇒ marcar seria pagar 1,25× por nada. */
  cacheable: boolean;
  /** Quantas vezes esta MESMA cabeça já foi vista (inclusive esta). 1 = estreia. */
  seen: number;
  /** Ms desde a última vez que ela apareceu. `null` = estreia (não houve anterior). */
  sinceLastMs: number | null;
  /** `true` só quando repetiu DENTRO do TTL — é a única forma de repetição que o provedor pagaria. */
  hitWithinTtl: boolean;
};

/** Censo de um prompt: quem ocupou quantos chars do que efetivamente foi enviado. */
export type PromptCensus = {
  /** Caminho que montou o prompt (ex.: `api-gapfile`). É o que separa uma família de chamadas da outra. */
  origem: string;
  /** Papel do agente, quando o caminho tem um (`CTO`, `JUIZ`…). `null` = não se aplica. */
  role: string | null;
  /** Arquivo da spec em edição, quando o caminho é por-arquivo. `null` = não se aplica. */
  file: string | null;
  /** Chars TOTAIS enviados (system + user), como o provedor vai cobrar. */
  total: number;
  /** Campos com tamanho > 0, do maior para o menor. Campo vazio é omitido (ruído, não fato). */
  fields: Record<string, number>;
  /**
   * `total − soma(campos)`: delimitadores, rótulos e instrução final. **Pode ser negativo** — e nesse
   * caso é BUG de contagem dupla no chamador, não uma economia. Nunca é zerado à força.
   */
  outros: number;
  /**
   * 🔴 GAP-153: a cabeça estável desta chamada, quando o chamador declarou uma. `null` = este caminho
   * ainda não declarou onde ficaria o ponto de cache — e "não declarado" é diferente de "não repete".
   */
  head: PromptHeadCensus | null;
};

/**
 * 🔴 GAP-153: reduz a cabeça a IDENTIDADE (hash) + TAMANHO e responde a única pergunta que decide a
 * marcação: este mesmo prefixo já passou por aqui dentro do TTL do provedor?
 *
 * Nunca lança e nunca guarda texto. A tabela é do PROCESSO: é o processo que faz a chamada, então é
 * ele quem pode dizer se o prefixo repetiu — e o cache do provedor também é por chamada, não por
 * histórico em banco. Cabeça vazia devolve `null` (nada a medir), não uma repetição de string vazia.
 */
function medirCabeca(origem: string, head?: string): PromptHeadCensus | null {
  try {
    if (typeof head !== "string" || head.length === 0) return null;
    const hash = createHash("sha256").update(`${origem} ${head}`).digest("hex").slice(0, 12);
    const agora = Date.now();
    const anterior = headSeen.get(hash);
    const sinceLastMs = anterior ? agora - anterior.at : null;
    // Expiração é REGRA, não faxina: a entrada velha é reaproveitada para contar `seen`, mas
    // `hitWithinTtl` continua falso — repetir depois de 6 min é pagar escrita duas vezes.
    const seen = (anterior?.n ?? 0) + 1;
    headSeen.set(hash, { at: agora, n: seen });
    if (headSeen.size > HEAD_TABLE_MAX) {
      // Poda pelas MAIS ANTIGAS: quem já passou do TTL não pode mais dar acerto, então é a perda
      // mais barata possível. A cabeça DESTA chamada nunca é podada — ela é a próxima candidata a
      // acerto. Sem isto um processo longo acumularia uma cabeça por chamada.
      for (const [k] of [...headSeen.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (headSeen.size <= HEAD_TABLE_MAX) break;
        if (k !== hash) headSeen.delete(k);
      }
    }
    return {
      hash,
      chars: head.length,
      cacheable: head.length >= PROMPT_CACHE_MIN_HEAD_CHARS,
      seen,
      sinceLastMs,
      hitWithinTtl: sinceLastMs !== null && sinceLastMs <= PROMPT_CACHE_TTL_MS,
    };
  } catch {
    // Instrumento não derruba a chamada que ele mede (mesma regra do resto do censo).
    return null;
  }
}

/**
 * Monta o censo, escreve UMA linha `[prompt-census]` e devolve o censo (para teste e para quem
 * quiser anexá-lo a uma decisão). Nunca lança: instrumento não derruba a chamada que ele mede.
 *
 * @param total Tamanho REAL do que vai ser enviado (system + user). Quem chama já tem os dois.
 * @param fields Tamanho ENTREGUE de cada bloco nomeado. Zeros são descartados.
 */
export function recordPromptCensus(args: {
  origem: string;
  role?: string | null;
  file?: string | null;
  total: number;
  fields: Record<string, number>;
  /**
   * 🔴 GAP-153: o TEXTO que ficaria ANTES do ponto de cache (system + blocos estáveis). Entra só para
   * ser reduzido a hash e tamanho — não é guardado nem logado. Omitir é legítimo (caminho que ainda
   * não decidiu onde cortaria); mandar o prompt inteiro NÃO é: a cabeça tem de terminar antes do
   * primeiro byte que muda de chamada para chamada, senão a taxa medida seria sempre zero.
   */
  head?: string;
}): PromptCensus {
  const fields: Record<string, number> = {};
  for (const [k, v] of Object.entries(args.fields).sort((a, b) => b[1] - a[1])) {
    if (Number.isFinite(v) && v > 0) fields[k] = v;
  }
  const contados = Object.values(fields).reduce((a, b) => a + b, 0);
  const censo: PromptCensus = {
    origem: args.origem,
    role: args.role ?? null,
    file: args.file ?? null,
    total: args.total,
    fields,
    outros: args.total - contados,
    // A identidade da cabeça é por ORIGEM: duas famílias de chamada podem coincidir no texto e ainda
    // assim não se aproveitarem (não é o mesmo prompt), e misturá-las inflaria a taxa de acerto.
    head: medirCabeca(args.origem, args.head),
  };
  try {
    const detalhe = Object.entries(fields).map(([k, v]) => `${k}=${v}c`).join(" ");
    const h = censo.head;
    console.log(
      `[prompt-census] origem=${censo.origem} role=${censo.role ?? "?"}`
      + `${censo.file ? ` file=${censo.file}` : ""} total=${censo.total}c ${detalhe}`
      // Negativo = o chamador contou o mesmo texto duas vezes. Aparece no log como defeito, com nome.
      + ` outros=${censo.outros}c${censo.outros < 0 ? " CONTAGEM-DUPLA" : ""}`
      // 🔴 GAP-153: `head=` só aparece quando o chamador declarou a cabeça. `repeat=estreia` é FATO
      // (primeira vez que se vê este prefixo), `repeat=fora-do-ttl` é repetição que o provedor NÃO
      // pagaria, e `NAO-CACHEAVEL` marca a cabeça abaixo do piso do provedor: marcar ali é regressão.
      + (h
        ? ` head=${h.hash} head_chars=${h.chars}c head_seen=${h.seen}`
          + ` head_repeat=${h.sinceLastMs === null
            ? "estreia"
            : (h.hitWithinTtl ? `ACERTO(${Math.round(h.sinceLastMs / 1000)}s)` : "fora-do-ttl")}`
          + (h.cacheable ? "" : " NAO-CACHEAVEL")
        : ""),
    );
  } catch {
    // Log indisponível é irrelevante para a edição do arquivo; o censo devolvido segue válido.
  }
  // 🔴 GAP-159: persistir é a MESMA classe de coisa que logar — best-effort e depois do log, para que
  // uma falha de banco não faça o censo desaparecer também do log (o fato medido tem de sair por
  // algum lugar). O sink é `void` de propósito: quem mede não espera pelo destino.
  try {
    sink?.(censo);
  } catch {
    // Instrumento não derruba a chamada que ele mede.
  }
  return censo;
}
