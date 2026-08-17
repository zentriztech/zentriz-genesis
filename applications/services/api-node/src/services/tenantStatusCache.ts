/**
 * tenantStatusCache.ts — RFC-0002 Parte B (F2 / H3).
 *
 * Cache em memória (por processo) do `status` de cada tenant, para o recheck de
 * suspensão no authMiddleware sem pagar um SELECT por requisição. TTL curto
 * (30s por padrão) para que uma ativação/suspensão propague rápido mesmo sem
 * invalidação explícita; os pontos que mudam o status chamam `bustTenantStatus`
 * para efeito imediato.
 *
 * Invalidação CROSS-INSTÂNCIA (multi-réplica): `bustTenantStatus` além de limpar o
 * cache LOCAL também emite um `NOTIFY tenant_status_bust <tenantId>`. Cada processo
 * mantém um cliente dedicado em `LISTEN tenant_status_bust`, então uma suspensão/
 * ativação/alteração de status feita em QUALQUER réplica invalida o cache em TODAS
 * imediatamente — sem depender do TTL. Se o listener cair (ou o NOTIFY falhar), o
 * TTL de 30s continua sendo o pior caso de propagação (degradação graciosa).
 *
 * Semântica de erro: FAIL-OPEN. Se o SELECT falhar (ex.: DB momentaneamente
 * indisponível), retornamos `null` e o chamador NÃO bloqueia — o gate de
 * inadimplência jamais deve derrubar o acesso por causa de uma falha de infra.
 * O login já barra tenants não-ativos na entrada; este cache só fecha a janela
 * de uma suspensão que ocorre no meio da sessão (token ainda válido).
 */
import pg from "pg";
import { pool, connectionString } from "../db/client.js";

type Entry = { status: string; expiresAt: number };

const TTL_MS = Number(process.env.TENANT_STATUS_CACHE_TTL_MS ?? 30_000);
const BUST_CHANNEL = "tenant_status_bust";
const RECONNECT_DELAY_MS = 5_000;
const cache = new Map<string, Entry>();

/**
 * Retorna o status do tenant (com cache). `null` = desconhecido/erro (o chamador
 * deve tratar como "não bloquear"). Um tenant inexistente retorna a string
 * sentinela "__missing__" (para o chamador poder distinguir de erro, se quiser).
 */
export async function getTenantStatus(tenantId: string): Promise<string | null> {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > now) return hit.status;

  try {
    const res = await pool.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [tenantId],
    );
    const status = res.rows[0]?.status ?? "__missing__";
    cache.set(tenantId, { status, expiresAt: now + TTL_MS });
    return status;
  } catch {
    // Fail-open: erro de infra não deve bloquear acesso.
    return null;
  }
}

/**
 * Invalida a entrada de um tenant (chamado após ativar/suspender/alterar status).
 * Limpa o cache LOCAL e propaga a invalidação às demais réplicas via NOTIFY
 * (best-effort — uma falha de NOTIFY não é fatal, o TTL cobre o pior caso).
 */
export function bustTenantStatus(tenantId: string): void {
  cache.delete(tenantId);
  // NOTIFY best-effort; não aguardamos nem propagamos erro (o TTL é a rede de segurança).
  pool
    .query("SELECT pg_notify($1, $2)", [BUST_CHANNEL, tenantId])
    .catch(() => { /* degradação graciosa: cai para o TTL */ });
}

// ─────────────────── Listener cross-instância (LISTEN/NOTIFY) ───────────────────

let listener: pg.Client | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectListener();
  }, RECONNECT_DELAY_MS);
}

async function connectListener(): Promise<void> {
  if (stopped || listener) return;
  if (!connectionString) {
    // Sem DSN (ex.: alguns ambientes de teste) — sem listener; o TTL cobre.
    return;
  }
  const client = new pg.Client({ connectionString });
  // Ao cair a conexão, descarta e reagenda; ao reconectar limpamos tudo (podemos ter perdido busts).
  client.on("error", () => {
    if (listener === client) listener = null;
    client.removeAllListeners();
    client.end().catch(() => {});
    scheduleReconnect();
  });
  client.on("end", () => {
    if (listener === client) listener = null;
    scheduleReconnect();
  });
  client.on("notification", (msg) => {
    if (msg.channel === BUST_CHANNEL && msg.payload) cache.delete(msg.payload);
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${BUST_CHANNEL}`);
    // Pode ter havido stop() enquanto o connect/LISTEN estava em voo — não vaze a conexão.
    if (stopped) {
      client.removeAllListeners();
      await client.end().catch(() => {});
      return;
    }
    listener = client;
    // Ao (re)conectar, pode haver janela em que perdemos notificações → limpa o cache inteiro.
    cache.clear();
    console.info("[tenant-status] listener LISTEN tenant_status_bust ativo");
  } catch {
    client.removeAllListeners();
    await client.end().catch(() => {});
    scheduleReconnect();
  }
}

/** Inicia o listener de invalidação cross-instância. Idempotente. */
export function startTenantStatusListener(): void {
  stopped = false;
  void connectListener();
}

/** Encerra o listener (graceful shutdown). */
export function stopTenantStatusListener(): void {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const c = listener;
  listener = null;
  if (c) { c.removeAllListeners(); c.end().catch(() => {}); }
}

/** Apenas para testes: limpa todo o cache. */
export function _clearTenantStatusCache(): void {
  cache.clear();
}
