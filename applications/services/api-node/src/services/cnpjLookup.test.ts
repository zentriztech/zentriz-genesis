import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isValidCnpj,
  normalizeCnpjDigits,
  normalizeCnpjAlnum,
  lookupCnpj,
  setCnpjLookupProvider,
  clearCnpjCache,
  type CnpjLookup,
  type CnpjLookupResult,
} from "./cnpjLookup.js";

describe("cnpjLookup — validação e normalização (puro)", () => {
  it("normalizeCnpjDigits remove pontuação", () => {
    expect(normalizeCnpjDigits("11.222.333/0001-81")).toBe("11222333000181");
    expect(normalizeCnpjDigits(" 11 222 333 0001 81 ")).toBe("11222333000181");
    expect(normalizeCnpjDigits("")).toBe("");
  });

  it("isValidCnpj aceita CNPJ com dígitos verificadores corretos", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCnpj("11222333000181")).toBe(true);
  });

  it("isValidCnpj rejeita comprimento errado, dígitos repetidos e DV inválido", () => {
    expect(isValidCnpj("123")).toBe(false);
    expect(isValidCnpj("00000000000000")).toBe(false);
    expect(isValidCnpj("11111111111111")).toBe(false);
    expect(isValidCnpj("11222333000182")).toBe(false); // DV incorreto
  });

  it("normalizeCnpjAlnum mantém letras (maiúsculas) e remove pontuação", () => {
    expect(normalizeCnpjAlnum("12.ABC.345/01DE-35")).toBe("12ABC34501DE35");
    expect(normalizeCnpjAlnum("12abc34501de35")).toBe("12ABC34501DE35");
    expect(normalizeCnpjAlnum("11.222.333/0001-81")).toBe("11222333000181");
  });

  it("isValidCnpj aceita o novo CNPJ alfanumérico da SEFAZ", () => {
    // Exemplo canônico da Receita (12 posições alfanuméricas + 2 DV numéricos).
    expect(isValidCnpj("12.ABC.345/01DE-35")).toBe(true);
    expect(isValidCnpj("12ABC34501DE35")).toBe(true);
  });

  it("isValidCnpj rejeita alfanumérico com DV errado ou letras nos DV", () => {
    expect(isValidCnpj("12ABC34501DE34")).toBe(false); // DV incorreto
    expect(isValidCnpj("12ABC34501DE3A")).toBe(false); // DV não-numérico
  });
});

describe("cnpjLookup — cache por CNPJ (evita martelar a ReceitaWS)", () => {
  let calls = 0;
  const fakeProvider: CnpjLookup = {
    async lookup(cnpjRaw: string): Promise<CnpjLookupResult> {
      calls += 1;
      return { cnpj: normalizeCnpjDigits(cnpjRaw), name: "ACME LTDA", address: {} };
    },
  };

  beforeEach(() => {
    calls = 0;
    clearCnpjCache();
    setCnpjLookupProvider(fakeProvider);
  });
  afterEach(() => {
    clearCnpjCache();
    setCnpjLookupProvider(null); // volta ao provider padrão (ReceitaWS)
  });

  it("consultas repetidas do mesmo CNPJ batem no provider só uma vez", async () => {
    const r1 = await lookupCnpj("11.222.333/0001-81");
    const r2 = await lookupCnpj("11222333000181");
    expect(r1.name).toBe("ACME LTDA");
    expect(r2).toEqual(r1);
    expect(calls).toBe(1); // segunda veio do cache
  });

  it("CNPJs distintos são consultados separadamente", async () => {
    await lookupCnpj("11222333000181");
    await lookupCnpj("11444777000161");
    expect(calls).toBe(2);
  });
});
