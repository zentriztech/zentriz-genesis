/**
 * A4.2 — o parser da cadeia é a única defesa contra o pior erro possível deste script:
 * arquivar o projeto errado em produção. Por isso a cadeia é EXPLÍCITA e validada.
 */
import { describe, it, expect } from "vitest";
import { parseChain } from "./link-project-lineage.js";

const A = "49b39bf2-4cf7-409a-a95d-5b4a2dad2f24";
const B = "19e82cb6-bbe9-45cc-8697-c721a341f20d";

describe("parseChain (A4.2)", () => {
  it("lê a cadeia na ordem dada (mais antiga → corrente)", () => {
    expect(parseChain(["node", "s.js", "--chain", `${A},${B}`])).toEqual([A, B]);
    expect(parseChain(["node", "s.js", "--chain", ` ${A} , ${B} `, "--commit"])).toEqual([A, B]);
  });

  it("sem `--chain` (ou sem valor) não devolve nada — o script sai antes de tocar no banco", () => {
    expect(parseChain(["node", "s.js"])).toEqual([]);
    expect(parseChain(["node", "s.js", "--chain"])).toEqual([]);
  });

  it("id fora do formato uuid é recusado (um typo arquivaria o projeto errado)", () => {
    expect(() => parseChain(["node", "s.js", "--chain", `${A},nao-e-uuid`])).toThrow(/uuid/);
    expect(() => parseChain(["node", "s.js", "--chain", "*"])).toThrow(/uuid/);
  });

  it("id repetido é recusado (um projeto apontando para si mesmo trava a linhagem)", () => {
    expect(() => parseChain(["node", "s.js", "--chain", `${A},${A}`])).toThrow(/repetido/);
  });
});
