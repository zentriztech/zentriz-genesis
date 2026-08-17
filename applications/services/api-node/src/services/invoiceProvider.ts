/**
 * invoiceProvider.ts — RFC-0002 Parte B (F3, MVP interno).
 *
 * Porta (Ports & Adapters) para emissão de nota fiscal. Nesta fase existe apenas o
 * adaptador INTERNO (`InternalInvoiceProvider`), um stub que devolve uma referência
 * sintética — NÃO fala com prefeitura/NFS-e nem usa certificado A1. Um provedor real
 * (Focus NFe / eNotas / PlugNotas) entra em F4 apenas trocando o adaptador aqui, sem
 * tocar nas rotas: elas dependem só da interface `InvoiceProvider`.
 *
 * O domínio financeiro (routes/finance.ts) nunca conhece detalhes do provedor — pede a
 * emissão pela porta e persiste `provider`/`provider_ref` no que voltar.
 */

/** Dados mínimos que a rota entrega ao provedor para emitir a nota. */
export interface InvoiceIssueInput {
  /** Número sequencial interno já reservado (coluna invoices.number). */
  number: number;
  tenantId: string;
  tenantName?: string;
  amountCents: number;
  competenceMonth?: string | null;
  description?: string | null;
  chargeId?: string | null;
}

/** Resultado da emissão: identificador do provedor + rótulo do provedor. */
export interface InvoiceIssueResult {
  provider: string;
  providerRef: string;
}

/** Porta de emissão de nota fiscal. */
export interface InvoiceProvider {
  readonly name: string;
  issue(input: InvoiceIssueInput): Promise<InvoiceIssueResult>;
}

/**
 * Stub interno: gera uma referência determinística a partir do número sequencial
 * (ex.: `INT-000042`). Não há chamada externa nem efeito colateral — é síncrono na
 * prática, mas mantém a assinatura assíncrona da porta para o provedor real de F4.
 */
export class InternalInvoiceProvider implements InvoiceProvider {
  readonly name = "internal";

  async issue(input: InvoiceIssueInput): Promise<InvoiceIssueResult> {
    const ref = `INT-${String(input.number).padStart(6, "0")}`;
    return { provider: this.name, providerRef: ref };
  }
}

// ── Singleton plugável ────────────────────────────────────────────────────────
let provider: InvoiceProvider = new InternalInvoiceProvider();

/** Retorna o provedor de nota fiscal ativo. */
export function getInvoiceProvider(): InvoiceProvider {
  return provider;
}

/** Apenas para testes / bootstrap: injeta outro provedor (ex.: real em F4). */
export function _setInvoiceProvider(p: InvoiceProvider): void {
  provider = p;
}
