/**
 * specTreeHash.test.ts — RFC-0004 T1.2: PARIDADE do hash canônico da árvore de spec.
 *
 * Os hex ESPERADOS abaixo são a fonte de verdade compartilhada com o espelho Python
 * (applications/orchestrator/tests/test_spec_tree_hash.py) — os DOIS testes usam os
 * MESMOS fixtures e os MESMOS digests. Se a fórmula mudar num lado, os dois quebram.
 */
import { describe, it, expect } from "vitest";
import {
  computeSpecTreeHash, hashSpecTreeFromBuffers, legacySpecHash,
  SpecTreeLimitError, SPEC_TREE_MAX_FILES,
} from "./specTreeHash.js";

function buf(s: string): Buffer { return Buffer.from(s, "utf-8"); }

const EXPECTED: Record<string, { files: Array<{ relDir: string; filename: string; buffer: Buffer }>; hash: string }> = {
  f1_raiz_unica: {
    files: [{ relDir: "", filename: "spec.md", buffer: buf("# Hello\n") }],
    hash: "a6ac8c2092ebe76d7e2cb68a891a0877a90ac198c4960a508a820ee785d1e0d2",
  },
  f2_subpasta: {
    files: [
      { relDir: "backend", filename: "01-api.md", buffer: buf("API spec\n") },
      { relDir: "", filename: "README.md", buffer: buf("root\n") },
    ],
    hash: "699041ac8417c61e4428adf37390376effc68be9f6b8f89d3d6e633de0542f6b",
  },
  f3_readme_duplicado: {
    files: [
      { relDir: "backend", filename: "README.md", buffer: buf("b\n") },
      { relDir: "web", filename: "README.md", buffer: buf("w\n") },
      { relDir: "", filename: "README.md", buffer: buf("r\n") },
    ],
    hash: "f4e71a35c16d28b358c08a0b7d19737e8a48d33ae3d7348b4146b7730597f914",
  },
  f4_unicode: {
    files: [
      { relDir: "", filename: "especificação.md", buffer: buf("conteúdo com acentuação ção\n") },
      { relDir: "módulo", filename: "ação.md", buffer: buf("ê\n") },
    ],
    hash: "b52202a8c2d572b4ef5502c2d5b19d921ed02dfaabf1791d7dd0b29f7044d11b",
  },
  f5_vazio: {
    files: [
      { relDir: "", filename: "empty.md", buffer: buf("") },
      { relDir: "", filename: "a.md", buffer: buf("x") },
    ],
    hash: "2bf26cbafc6282dcdbf25ca8dc6bb285b910c9c20a5e87cb64900a2b468373df",
  },
  f8_astral: {
    // F4 (adversarial): emoji (plano astral, surrogates em UTF-16) × BMP alto — o sort
    // por code unit do JS divergia do codepoint do Python; agora ambos ordenam por UTF-8.
    files: [
      { relDir: "", filename: "\u{1F600}-spec.md", buffer: buf("astral") },
      { relDir: "", filename: "�-spec.md", buffer: buf("bmp-alto") },
      { relDir: "", filename: "a.md", buffer: buf("x") },
    ],
    hash: "9ff35509c3f9ec8e1a8bbd6ee50077182669af4ee1c13c2d1e0f43904e499a0d",
  },
  f6_case_sort: {
    // Z.md < a.md em codepoint (o localeCompare legado inverteria) — pega regressão de sort.
    files: [
      { relDir: "", filename: "Z.md", buffer: buf("z\n") },
      { relDir: "", filename: "a.md", buffer: buf("a\n") },
      { relDir: "", filename: "README.md", buffer: buf("r\n") },
    ],
    hash: "e10f5bd01ff8227557994d083cf5a2d55d49743ad446f33a2206646a7f6001a6",
  },
};

describe("specTreeHash — paridade com o espelho Python (mesmos fixtures/digests)", () => {
  for (const [name, fx] of Object.entries(EXPECTED)) {
    it(`${name} → digest esperado`, () => {
      expect(hashSpecTreeFromBuffers(fx.files).specHash).toBe(fx.hash);
    });
  }

  it("ordem de ENTRADA não altera o hash (sort canônico)", () => {
    const fx = EXPECTED.f3_readme_duplicado;
    expect(hashSpecTreeFromBuffers([...fx.files].reverse()).specHash).toBe(fx.hash);
  });

  it("mover arquivo entre pastas MUDA o hash (bug da fórmula legada, cenário 1)", () => {
    const a = hashSpecTreeFromBuffers([{ relDir: "a", filename: "x.md", buffer: buf("same") }]).specHash;
    const b = hashSpecTreeFromBuffers([{ relDir: "b", filename: "x.md", buffer: buf("same") }]).specHash;
    expect(a).toBe("18da37379c86476152bfad760a5256f235269e83219bdfecd5c891d1d69a60a2");
    expect(b).toBe("3b007f24d027c76f779d9e5242cf9a5cf2b1406ad9d63058e43df882aaf074ef");
    expect(a).not.toBe(b);
  });

  it("mover linha entre arquivos MUDA o hash (ambiguidade do join legado, cenário 2)", () => {
    const v1 = hashSpecTreeFromBuffers([
      { relDir: "", filename: "a.md", buffer: buf("l1\nl2") },
      { relDir: "", filename: "b.md", buffer: buf("l3") },
    ]).specHash;
    const v2 = hashSpecTreeFromBuffers([
      { relDir: "", filename: "a.md", buffer: buf("l1") },
      { relDir: "", filename: "b.md", buffer: buf("l2\nl3") },
    ]).specHash;
    expect(v1).not.toBe(v2);
    // …enquanto a fórmula LEGADA colidia exatamente aqui:
    const legacy1 = legacySpecHash([{ filename: "a.md", content: "l1\nl2" }, { filename: "b.md", content: "l3" }]);
    const legacy2 = legacySpecHash([{ filename: "a.md", content: "l1" }, { filename: "b.md", content: "l2\nl3" }]);
    expect(legacy1).toBe(legacy2);
  });

  it("teto de arquivos → SpecTreeLimitError", () => {
    const entries = Array.from({ length: SPEC_TREE_MAX_FILES + 1 }, (_, i) => ({
      relDir: "", filename: `f${i}.md`, contentSha256: "0".repeat(64),
    }));
    expect(() => computeSpecTreeHash(entries)).toThrow(SpecTreeLimitError);
  });
});
