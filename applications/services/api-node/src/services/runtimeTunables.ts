/**
 * runtimeTunables.ts — leitura, DENTRO da api, de um knob numérico de `genesis_runtime_config`.
 *
 * Até aqui só o runner (Python) lia essa tabela; a api só a editava. O chat da Bancada precisa do
 * teto de saída do modelo configurável sem deploy, então a api ganha um leitor mínimo.
 *
 * Resolução: override do TENANT vence o default GLOBAL (`tenant_id IS NULL`) — a mesma regra de
 * `GET /api/admin/runtime-config/resolved`.
 *
 * Contrato: devolve `null` quando a chave não existe, o valor não é um número dentro de
 * [min, max] ou o banco falhou. `null` significa "use o comportamento histórico do chamador",
 * nunca "zero". Um valor fora da faixa é logado (alguém editou a tabela na mão) e IGNORADO — um
 * teto de tokens absurdo não pode virar chamada paga.
 */

export interface RuntimeConfigDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function readRuntimeNumber(
  db: RuntimeConfigDb,
  key: string,
  tenantId: string | null,
  bounds: { min: number; max: number },
): Promise<number | null> {
  try {
    // `tenant_id = NULL` nunca casa: sem tenant, só o global entra. NULLS LAST põe o override do
    // tenant antes do global.
    const r = await db.query(
      `SELECT value FROM genesis_runtime_config
        WHERE key = $1 AND (tenant_id IS NULL OR tenant_id = $2)
        ORDER BY tenant_id NULLS LAST
        LIMIT 1`,
      [key, tenantId],
    );
    const raw = r.rows[0]?.value;
    if (raw === undefined || raw === null) return null;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < bounds.min || n > bounds.max) {
      console.warn(
        `[RuntimeConfig] ${key}=${JSON.stringify(raw)} IGNORADO: esperado inteiro em [${bounds.min}, ${bounds.max}]`,
      );
      return null;
    }
    return n;
  } catch (e) {
    console.warn(`[RuntimeConfig] ${key} não lido (${e instanceof Error ? e.message : String(e)}) — segue o padrão do código`);
    return null;
  }
}
