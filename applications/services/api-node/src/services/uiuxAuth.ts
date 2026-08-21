/**
 * uiuxAuth.ts — Item 3 (Canva OAuth): renovação de token e criação de conexão a partir
 * do fluxo Authorization Code + PKCE. Mantém uiuxExtract.ts sem dependência de DB (funções
 * puras + fetchers HTTP); a persistência das credenciais cifradas vive aqui.
 */

import { pool } from "../db/client.js";
import { encryptCredentials, decryptCredentials } from "./crypto.js";
import {
  refreshCanvaToken,
  isCanvaOAuthConfigured,
  type CanvaTokenSet,
  type UiuxCredentials,
  type UiuxProvider,
} from "./uiuxExtract.js";

const REFRESH_SKEW_MS = 60_000; // renova 1 min antes de expirar
const MAX_SLOTS = 6;

/** Descriptografa as credenciais de uma linha de tenant_uiux_connections. */
export function decodeConnectionCreds(row: Record<string, unknown>): UiuxCredentials {
  return JSON.parse(
    decryptCredentials({
      encrypted: row.encrypted_credentials as string,
      iv: row.encryption_iv as string,
      tag: row.encryption_tag as string,
    }),
  ) as UiuxCredentials;
}

// TTL conservador quando o Canva não devolve expires_in (evita reusar um expiry passado,
// o que dispararia refresh a cada request). Curto o bastante para não segurar token morto.
const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Monta o objeto de credenciais a partir de um token set do Canva. */
export function credsFromCanvaToken(tok: CanvaTokenSet, prev?: UiuxCredentials): UiuxCredentials {
  return {
    ...(prev ?? {}),
    accessToken: tok.access_token,
    // Canva pode ou não rotacionar o refresh token; preserva o anterior se não vier novo.
    refreshToken: tok.refresh_token ?? prev?.refreshToken,
    tokenExpiresAt:
      typeof tok.expires_in === "number"
        ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
        : new Date(Date.now() + DEFAULT_TOKEN_TTL_MS).toISOString(),
  };
}

/** true se o access token do Canva ainda é utilizável (com folga de REFRESH_SKEW_MS). */
function isFresh(creds: UiuxCredentials): boolean {
  const exp = creds.tokenExpiresAt ? Date.parse(creds.tokenExpiresAt) : NaN;
  return Boolean(creds.accessToken) && Number.isFinite(exp) && exp - Date.now() > REFRESH_SKEW_MS;
}

/**
 * Garante credenciais utilizáveis para a conexão: p/ Canva, renova o access token via
 * refresh_token quando expirado (ou perto) e PERSISTE as novas credenciais cifradas.
 * Para figma (ou canva sem refresh/sem app configurado) devolve as credenciais como estão
 * — deixando um eventual 401 do upstream lançar um erro claro para o chamador.
 */
export async function ensureFreshUiuxCreds(row: Record<string, unknown>): Promise<UiuxCredentials> {
  const provider = row.provider as UiuxProvider;
  const creds = decodeConnectionCreds(row);
  if (provider !== "canva") return creds;

  // Caminho rápido: token ainda válido → nem toca no banco/rede.
  if (isFresh(creds)) return creds;
  if (!creds.refreshToken || !isCanvaOAuthConfigured()) return creds;

  const id = row.id as string | undefined;
  if (!id) {
    // Sem id não há como serializar/persistir; renova best-effort sem gravar.
    const tok = await refreshCanvaToken(creds.refreshToken);
    return credsFromCanvaToken(tok, creds);
  }

  // O Canva rotaciona refresh_token (uso único). Dois requests concorrentes que renovem com
  // o MESMO refresh_token quebram a conexão permanentemente (last-writer grava um RT já morto).
  // Serializa por conexão via advisory lock transacional + double-checked locking: quem entra
  // depois re-lê a linha e vê o token já renovado, evitando a segunda chamada de rede.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
    const fresh = await client.query(
      `SELECT provider, encrypted_credentials, encryption_iv, encryption_tag
         FROM tenant_uiux_connections WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const frow = fresh.rows[0] as Record<string, unknown> | undefined;
    if (!frow) { await client.query("ROLLBACK"); return creds; }

    const current = decodeConnectionCreds(frow);
    if (isFresh(current)) { await client.query("COMMIT"); return current; } // outro request já renovou
    if (!current.refreshToken) { await client.query("COMMIT"); return current; }

    const tok = await refreshCanvaToken(current.refreshToken);
    const updated = credsFromCanvaToken(tok, current);
    const enc = encryptCredentials(JSON.stringify(updated));
    await client.query(
      `UPDATE tenant_uiux_connections
         SET encrypted_credentials=$1, encryption_iv=$2, encryption_tag=$3, updated_at=now()
       WHERE id=$4`,
      [enc.encrypted, enc.iv, enc.tag, id],
    );
    await client.query("COMMIT");
    return updated;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* já pode ter abortado */ }
    throw e;
  } finally {
    client.release();
  }
}

export interface CreatedConnection {
  id: string;
  slotIndex: number;
}

/**
 * Cria uma conexão UI/UX (usado pelo callback OAuth do Canva). Respeita MAX_SLOTS.
 * Lança { code: "SLOT_LIMIT" } quando o tenant já atingiu o máximo de conexões ativas.
 */
export async function createUiuxConnection(opts: {
  tenantId: string;
  provider: UiuxProvider;
  creds: UiuxCredentials;
  label?: string | null;
  accountRef?: string | null;
}): Promise<CreatedConnection> {
  const { tenantId, provider, creds, label, accountRef } = opts;
  const client = await pool.connect();
  try {
    const countRes = await client.query(
      "SELECT COUNT(*) FROM tenant_uiux_connections WHERE tenant_id=$1 AND status='active'",
      [tenantId],
    );
    if (Number(countRes.rows[0].count) >= MAX_SLOTS) {
      const e = new Error(`Máximo de ${MAX_SLOTS} conexões atingido`) as Error & { code?: string };
      e.code = "SLOT_LIMIT";
      throw e;
    }
    const maxRes = await client.query(
      "SELECT COALESCE(MAX(slot_index), -1) AS max FROM tenant_uiux_connections WHERE tenant_id=$1 AND status='active'",
      [tenantId],
    );
    const nextSlot = Number(maxRes.rows[0].max) + 1;
    const enc = encryptCredentials(JSON.stringify(creds));
    const ins = await client.query(
      `INSERT INTO tenant_uiux_connections
         (tenant_id, provider, label, account_ref, slot_index,
          encrypted_credentials, encryption_iv, encryption_tag, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
       RETURNING id, slot_index`,
      [tenantId, provider, label ?? null, accountRef ?? null, nextSlot, enc.encrypted, enc.iv, enc.tag],
    );
    return { id: ins.rows[0].id as string, slotIndex: Number(ins.rows[0].slot_index) };
  } finally {
    client.release();
  }
}
