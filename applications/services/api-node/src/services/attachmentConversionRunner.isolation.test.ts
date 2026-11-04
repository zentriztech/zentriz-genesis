/**
 * S-04 — a conversão roda em PROCESSO FILHO com limite real do SO. Provas (sem Postgres, sem rede):
 *   • filho que aloca Buffer sem parar é morto (monitor de RSS e, separadamente, ulimit -v) e o processo principal segue;
 *   • timeout duro (SIGKILL), teto de stdout, ambiente vazio, semáforo global;
 *   • PDF "bomba" Flate (poucos KB que inflam para centenas de MB) ⇒ erro claro e a api viva para o próximo anexo.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { runLimitedNode, runConversionIsolated, conversionConcurrency, conversionLimitsFromEnv } from "./attachmentConversionRunner.js";
import { CONVERSION_LIMIT_DEFAULTS, ConversionError, type ConversionLimits } from "./attachmentConverters.js";
import { makeDocx, makePdfFlateBomb } from "../testing/attachmentFixtures.js";

const L = (o: Partial<ConversionLimits> = {}): ConversionLimits => ({ ...CONVERSION_LIMIT_DEFAULTS, ...o });
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ConversionError; } throw new Error("deveria ter falhado"); };
const meta = (name: string, b: Buffer) => ({ attachmentId: "11111111-2222-3333-4444-555555555555", filename: name, sha256: createHash("sha256").update(b).digest("hex"), now: new Date("2026-11-04T12:00:00Z") });
const HOG = "const a=[];for(;;){a.push(Buffer.alloc(64*1024*1024,1));}"; // Buffer fora do heap V8, páginas tocadas

describe("S-04 — processo filho com limite real de memória", () => {
  it("monitor de RSS: filho que aloca >N MiB de Buffer é morto (SIGKILL) sem afetar o principal", async () => {
    const before = process.memoryUsage().rss;
    const t0 = Date.now();
    const e = await fails(runLimitedNode(["-e", HOG], Buffer.alloc(0), L({ procMaxAddressSpaceMb: 0, procMaxRssMb: 300, timeoutMs: 20_000 })));
    expect(e.code).toBe("RESOURCE_LIMIT");
    expect(e.message).toMatch(/300 MiB \(RSS\)/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024); // o principal não herdou a alocação
  });

  it("limite do SO (ulimit -v): sem monitor de RSS, o próprio kernel/alocador derruba o filho ⇒ RESOURCE_LIMIT", async () => {
    const e = await fails(runLimitedNode(["-e", HOG], Buffer.alloc(0), L({ procMaxAddressSpaceMb: 1536, procMaxRssMb: 1_000_000, timeoutMs: 20_000 })));
    expect(e.code).toBe("RESOURCE_LIMIT");
    expect(e.message).toMatch(/limite de memória/);
  });

  it("timeout duro: laço infinito leva SIGKILL no prazo", async () => {
    const t0 = Date.now();
    const e = await fails(runLimitedNode(["-e", "for(;;){}"], Buffer.alloc(0), L({ timeoutMs: 400 })));
    expect(e.code).toBe("TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("saída limitada por bytes: filho que despeja stdout além do teto é morto", async () => {
    const e = await fails(runLimitedNode(["-e", "const c=Buffer.alloc(65536,65);setInterval(()=>process.stdout.write(c),1)"], Buffer.alloc(0), L({ maxStdoutBytes: 500_000, timeoutMs: 20_000 })));
    expect(e.code).toBe("RESOURCE_LIMIT");
    expect(e.message).toMatch(/saída/);
  });

  it("ambiente vazio: nenhum segredo da api chega ao filho", async () => {
    process.env.J1_SEGREDO_DE_TESTE = "nao-vazar";
    try {
      const out = await runLimitedNode(["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], Buffer.alloc(0), L());
      expect(JSON.parse(out.toString()).filter((k: string) => k !== "PWD")).toEqual([]); // PWD é do próprio sh
    } finally { delete process.env.J1_SEGREDO_DE_TESTE; }
  });

  it("semáforo global: com maxConcurrent=1, três conversões nunca rodam juntas", async () => {
    const lim = L({ maxConcurrent: 1 });
    const b = makeDocx();
    let peak = 0;
    const iv = setInterval(() => { peak = Math.max(peak, conversionConcurrency().active); }, 5);
    const rs = await Promise.all([1, 2, 3].map(() => runConversionIsolated(".docx", b, meta("a.docx", b), lim)));
    clearInterval(iv);
    expect(rs.every((r) => r.markdown.includes("Convertido automaticamente"))).toBe(true);
    expect(peak).toBe(1);
    expect(conversionConcurrency()).toEqual({ active: 0, queued: 0 });
  });

  it("limites por variável: maxConcurrent é limitado a 1–4 e o ulimit aceita 0 (desligado)", () => {
    expect(conversionLimitsFromEnv({ ATTACHMENT_CONVERSION_MAX_CONCURRENT: "99" } as NodeJS.ProcessEnv).maxConcurrent).toBe(4);
    expect(conversionLimitsFromEnv({} as NodeJS.ProcessEnv).maxConcurrent).toBe(CONVERSION_LIMIT_DEFAULTS.maxConcurrent);
    expect(conversionLimitsFromEnv({ ATTACHMENT_CONVERSION_PROC_MAX_ADDRESS_SPACE_MB: "0" } as NodeJS.ProcessEnv).procMaxAddressSpaceMb).toBe(0);
    expect(conversionLimitsFromEnv({ ATTACHMENT_CONVERSION_PROC_MAX_RSS_MB: "256" } as NodeJS.ProcessEnv).procMaxRssMb).toBe(256);
  });
});

describe("S-04 — PDF bomba Flate", () => {
  it("poucos KB inflam para ~700 MiB ⇒ falha com erro claro (RESOURCE_LIMIT/TIMEOUT) e a api segue viva", async () => {
    const bomb = makePdfFlateBomb(700);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024); // razão >= 350:1 no arquivo
    const before = process.memoryUsage().rss;
    const e = await fails(runConversionIsolated(".pdf", bomb, meta("bomba.pdf", bomb), L({ procMaxRssMb: 400, timeoutMs: 40_000 })));
    expect(["RESOURCE_LIMIT", "TIMEOUT"]).toContain(e.code);
    expect(e.message.length).toBeGreaterThan(10);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
    // processo da api intacto: a próxima conversão funciona
    const b = makeDocx();
    expect((await runConversionIsolated(".docx", b, meta("ok.docx", b), L())).markdown).toContain("Convertido automaticamente");
  }, 60_000);
});
