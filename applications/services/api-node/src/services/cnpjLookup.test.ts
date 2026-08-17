import { describe, it, expect } from "vitest";
import { isValidCnpj, normalizeCnpjDigits } from "./cnpjLookup.js";

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
});
