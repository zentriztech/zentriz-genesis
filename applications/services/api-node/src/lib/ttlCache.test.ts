/**
 * ttlCache.test.ts — cache genérico em memória (Onda 5): TTL, MISS pós-expiração e evicção LRU.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { TtlCache } from "./ttlCache.js";

afterEach(() => vi.useRealTimers());

describe("TtlCache", () => {
  it("get devolve o valor gravado e undefined p/ chave ausente", () => {
    const c = new TtlCache<number>({ ttlMs: 1000 });
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
    expect(c.get("x")).toBeUndefined();
  });

  it("entrada expira após o TTL (vira MISS)", () => {
    vi.useFakeTimers();
    const c = new TtlCache<string>({ ttlMs: 15_000 });
    c.set("k", "v");
    vi.advanceTimersByTime(14_999);
    expect(c.get("k")).toBe("v");
    vi.advanceTimersByTime(2);
    expect(c.get("k")).toBeUndefined();
  });

  it("evicta a chave menos usada recentemente ao estourar maxKeys (LRU)", () => {
    const c = new TtlCache<number>({ ttlMs: 60_000, maxKeys: 2 });
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // 'a' vira a mais recente → 'b' é a candidata a evicção
    c.set("c", 3); // estoura o teto de 2 → evicta 'b'
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
    expect(c.size).toBe(2);
  });
});
