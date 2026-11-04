/**
 * attachmentConversion.ts — ponto de extensão da conversão automática de anexos (pdf/doc/docx) para `.md`.
 *
 * Decisão do Jean (Fase 1', tarefa 1.5): pdf/doc/docx ficam GUARDADOS NO CARD, fora da pasta de texto da spec.
 * A conversão para markdown é uma tarefa POSTERIOR — aqui existe só o contrato e o registro, com o conversor
 * NULO (não converte nada). Quando houver um conversor real, basta `registerAttachmentConverter(...)`:
 * o resultado entra em `ticket_attachments` como linha DERIVADA (`origin = 'converted:<id>'`,
 * `derived_from_attachment_id = <id do original>`, `kind = 'spec_text'`) e segue o caminho normal dos txt/md.
 */

export interface ConversionInput {
  attachmentId: string;
  filename: string;
  /** extensão minúscula com ponto: ".pdf" | ".doc" | ".docx" */
  ext: string;
  buffer: Buffer;
}

export interface ConversionResult {
  /** Nome do `.md` derivado (sem caminho). */
  filename: string;
  markdown: string;
}

export interface AttachmentConverter {
  /** Identificador estável, gravado em `origin` como `converted:<id>`. */
  readonly id: string;
  accepts(ext: string): boolean;
  /** `null` = este conversor não produziu nada (o anexo segue só guardado no card). Erro ⇒ lança. */
  convert(input: ConversionInput): Promise<ConversionResult | null>;
}

/** Conversor nulo: aceita tudo e não converte nada. É o único registrado por padrão. */
export const nullConverter: AttachmentConverter = {
  id: "null",
  accepts: () => true,
  async convert() { return null; },
};

const registry: AttachmentConverter[] = [];

export function registerAttachmentConverter(c: AttachmentConverter): void {
  registry.unshift(c); // o mais recente tem precedência
}

/** Só para testes: volta ao estado padrão (apenas o conversor nulo). */
export function resetAttachmentConverters(): void {
  registry.length = 0;
}

export function getAttachmentConverter(ext: string): AttachmentConverter {
  return registry.find((c) => c.accepts(ext)) ?? nullConverter;
}

/** Marcação de origem gravada em `ticket_attachments.origin`. */
export function conversionOrigin(converterId: string): string {
  return `converted:${converterId}`;
}
