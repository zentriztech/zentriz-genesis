/**
 * intakeGate.ts — gate DETERMINÍSTICO de INTAKE de spec (custo ZERO de LLM).
 *
 * Motivo (incidente Cabral 2026-08-29): `POST /api/specs` aceitava spec com título
 * placeholder ("Spec sem título"), sem tipo de projeto e sem conteúdo mínimo — junk
 * virava projeto e às vezes rodava a fábrica cara. Este gate barra NA PORTA de intake,
 * ANTES de criar o projeto, exigindo os campos que toda spec precisa ter:
 *
 *   1. Título do projeto — obrigatório, real (não placeholder/vazio/curto demais).
 *   2. Tipo do projeto  — obrigatório e reconhecido pelo policies.json (não fantasma).
 *   3. Conteúdo mínimo, por MODO de intake:
 *        - modo "texto livre":  descrição com no mínimo MIN_FREE_TEXT_CHARS letras.
 *        - modo "anexos":       pelo menos 1 arquivo anexado.
 *
 * A validação SEMÂNTICA ("isto é minimamente uma spec?") é feita por LLM em
 * specSemanticGate.ts, chamada DEPOIS deste gate (só se este passar). Aqui é tudo
 * determinístico, barato e à prova de falha.
 */

import { isKnownProjectType } from "./typePolicyNormalizer.js";

/** Mínimo de letras exigido no modo texto livre (regra do Jean: 500 letras). */
export const MIN_FREE_TEXT_CHARS = 500;
/** Título precisa de ao menos este tamanho (após trim) para ser considerado real. */
export const TITLE_MIN_LEN = 4;

export type IntakeMode = "free_text" | "attachments";

export interface IntakeBlock {
  code: "SPEC_INTAKE_INCOMPLETE";
  message: string;
  /** Campos que falharam — o portal destaca cada um. */
  fields: Array<"title" | "project_type" | "free_text" | "attachments">;
  /** Sinais legíveis para log/telemetria. */
  signals: string[];
}

export type IntakeResult =
  | { ok: true; title: string; projectType: string; mode: IntakeMode }
  | { ok: false; block: IntakeBlock };

/**
 * Títulos placeholder que NÃO contam como título real (comparação case-insensitive,
 * após trim e colapso de espaços). Cobre o default silencioso "Spec sem título".
 */
const TITLE_PLACEHOLDERS = new Set<string>([
  "spec sem titulo",
  "sem titulo",
  "titulo",
  "title",
  "untitled",
  "novo projeto",
  "new project",
  "projeto",
  "project",
  "spec",
  "especificacao",
  "rascunho",
  "draft",
]);

/** Remove acentos e colapsa espaços — para comparar títulos placeholder de forma robusta. */
function normalizeForCompare(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Conta caracteres de LETRA (Unicode), ignorando espaços/pontuação/dígitos. */
function letterCount(s: string): number {
  const m = s.match(/\p{L}/gu);
  return m ? m.length : 0;
}

function isRealTitle(rawTitle: string | null | undefined): boolean {
  const title = (rawTitle ?? "").trim();
  if (title.length < TITLE_MIN_LEN) return false;
  // Precisa conter ao menos 2 letras — barra "----", "123", "??".
  if (letterCount(title) < 2) return false;
  if (TITLE_PLACEHOLDERS.has(normalizeForCompare(title))) return false;
  return true;
}

/**
 * Decide o modo de intake. Se o cliente enviou `intakeMode` explícito, respeita.
 * Senão infere: presença de descrição em texto livre ⇒ "texto livre"; caso contrário
 * (só arquivos, sem descrição) ⇒ "anexos". Isso mapeia o comportamento do portal, onde
 * o modo texto livre envia `freeDescription` e o modo upload envia só os arquivos.
 */
export function resolveIntakeMode(input: {
  intakeMode?: string | null;
  freeDescription?: string | null;
}): IntakeMode {
  const explicit = (input.intakeMode ?? "").trim().toLowerCase();
  if (explicit === "free_text" || explicit === "texto_livre" || explicit === "text") return "free_text";
  if (explicit === "attachments" || explicit === "anexos" || explicit === "upload" || explicit === "files") {
    return "attachments";
  }
  const hasFreeText = ((input.freeDescription ?? "").trim().length) > 0;
  return hasFreeText ? "free_text" : "attachments";
}

/**
 * Valida o intake de uma spec. Retorna { ok:true } com título/tipo/modo resolvidos, ou
 * { ok:false, block } com TODOS os campos que falharam (o portal exibe a lista de uma vez).
 */
export function validateIntake(input: {
  title?: string | null;
  projectType?: string | null;
  freeDescription?: string | null;
  attachmentCount: number;
  intakeMode?: string | null;
}): IntakeResult {
  const fields: IntakeBlock["fields"] = [];
  const signals: string[] = [];

  const title = (input.title ?? "").trim();
  const projectType = (input.projectType ?? "").trim();
  const freeDescription = (input.freeDescription ?? "").trim();
  const mode = resolveIntakeMode({ intakeMode: input.intakeMode, freeDescription });

  // 1. Título obrigatório e real.
  if (!isRealTitle(title)) {
    fields.push("title");
    signals.push(title ? `titulo_placeholder("${title.slice(0, 40)}")` : "titulo_vazio");
  }

  // 2. Tipo obrigatório e reconhecido (não vazio, não _default/_*, não fantasma).
  if (!projectType) {
    fields.push("project_type");
    signals.push("tipo_vazio");
  } else if (projectType.startsWith("_") || !isKnownProjectType(projectType)) {
    fields.push("project_type");
    signals.push(`tipo_invalido("${projectType.slice(0, 40)}")`);
  }

  // 3. Conteúdo mínimo — regra PAYLOAD-DRIVEN (não confia no `intakeMode` do cliente).
  //    Toda spec aceita precisa ter: texto livre com >= MIN_FREE_TEXT_CHARS letras
  //    OU pelo menos 1 anexo. O `mode` só escolhe a MENSAGEM de erro; ele NÃO pode
  //    relaxar o piso (senão um caller malicioso declararia "attachments" com texto
  //    curto e zero arquivos para pular o piso de 500 letras — HIGH-2 do adversarial).
  const letters = letterCount(freeDescription);
  const hasEnoughText = letters >= MIN_FREE_TEXT_CHARS;
  const hasAttachment = input.attachmentCount >= 1;
  if (!hasEnoughText && !hasAttachment) {
    if (mode === "attachments") {
      fields.push("attachments");
      signals.push("sem_anexo");
    } else {
      fields.push("free_text");
      signals.push(`texto_livre_curto(${letters}/${MIN_FREE_TEXT_CHARS})`);
    }
  }

  if (fields.length === 0) {
    return { ok: true, title, projectType, mode };
  }

  return { ok: false, block: buildBlock(fields, signals, mode) };
}

function buildBlock(
  fields: IntakeBlock["fields"],
  signals: string[],
  mode: IntakeMode,
): IntakeBlock {
  const parts: string[] = [];
  if (fields.includes("title")) {
    parts.push("informe um Título de projeto real (não vazio nem placeholder)");
  }
  if (fields.includes("project_type")) {
    parts.push("selecione um Tipo de projeto válido");
  }
  if (fields.includes("free_text")) {
    parts.push(`descreva o produto em texto livre com no mínimo ${MIN_FREE_TEXT_CHARS} letras`);
  }
  if (fields.includes("attachments")) {
    parts.push("anexe pelo menos 1 arquivo de especificação");
  }
  const human = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " e " + parts[parts.length - 1];
  return {
    code: "SPEC_INTAKE_INCOMPLETE",
    message:
      `A especificação está incompleta (modo ${mode === "free_text" ? "texto livre" : "anexos"}). ` +
      `Para ser aceita como spec, ${human}.`,
    fields,
    signals,
  };
}
