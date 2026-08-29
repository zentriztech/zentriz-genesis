/**
 * specContentGate.test.ts — gate de conteúdo da spec (incidente Cabral 2026-08-29).
 * Garante que templates/placeholders são barrados NA PORTA e que specs reais passam.
 */
import { describe, it, expect } from "vitest";
import { checkSpecContentReady } from "./specContentGate.js";

// Trecho do GUIA-TEMPLATE que o Cabral mandou para a fábrica (placeholders).
const TEMPLATE_SPEC = `# PRODUCT_SPEC — Guia de Especificação

> Este documento é um GUIA-TEMPLATE. Ainda não foi informado qual produto estamos especificando.

## 0. Metadados
- **Produto:** [nome do produto]
- **project_type:** [frontend_web | backend_api | fullstack | landing]

## 3. Requisitos Funcionais (FR)

### FR-01 — [título do requisito]
DADO [pré-condição],
QUANDO [ação do usuário],
ENTÃO [resultado esperado observável].

### FR-02 — [título do requisito]
DADO [pré-condição],
QUANDO [ação do usuário],
ENTÃO [resultado esperado].
`;

// Rascunho vazio (o assistente devolveu ao Cabral).
const EMPTY_DRAFT = `# PRODUCT_SPEC

> **STATUS: RASCUNHO VAZIO — aguardando descrição do produto.**

## 0. Metadados
- **Produto:** UNKNOWN: nome e domínio ainda não informados
- **Versão:** 0.0
`;

// Spec REAL de fleet-management (deve passar).
const REAL_SPEC = `# PRODUCT_SPEC — FleetOps: Gestão de Frota

## 0. Metadados
- **Produto:** FleetOps — gestão de frota para transportadoras
- **project_type:** fullstack

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis de acesso
DADO um usuário cadastrado com e-mail e senha,
QUANDO ele informa credenciais válidas,
ENTÃO recebe um token de sessão e é direcionado ao dashboard.

### FR-02 — Cadastro de veículos
DADO um gestor autenticado,
QUANDO ele cadastra um veículo com placa única,
ENTÃO o veículo é persistido com status "disponível".

## 7. Fluxos
\`\`\`mermaid
flowchart TD
  A[Gestor acessa] --> B{Autenticado?}
  B -->|Sim| D[Dashboard com alertas]
\`\`\`
`;

describe("checkSpecContentReady", () => {
  it("bloqueia o GUIA-TEMPLATE com FRs placeholder", () => {
    const r = checkSpecContentReady(TEMPLATE_SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.block.code).toBe("SPEC_PLACEHOLDER_TEMPLATE");
      expect(r.block.signals).toContain("sentinela_guia_template");
      expect(r.block.signals.some((s) => s.startsWith("fr_titulo_placeholder"))).toBe(true);
    }
  });

  it("bloqueia rascunho vazio (RASCUNHO VAZIO / Produto UNKNOWN)", () => {
    const r = checkSpecContentReady(EMPTY_DRAFT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.signals).toContain("produto_placeholder");
  });

  it("bloqueia spec vazia/whitespace", () => {
    expect(checkSpecContentReady("").ok).toBe(false);
    expect(checkSpecContentReady("   \n  ").ok).toBe(false);
    const r = checkSpecContentReady(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.signals).toContain("spec_vazia");
  });

  it("APROVA uma spec real preenchida (sem falso-positivo por Mermaid [Label])", () => {
    const r = checkSpecContentReady(REAL_SPEC);
    expect(r.ok).toBe(true);
  });

  it("MED-adversarial: NÃO falso-positiva FR/Gherkin reais com prefixo entre colchetes", () => {
    const bracketPrefixSpec = `# PRODUCT_SPEC — Sistema de Pedidos
## 0. Metadados
- **Produto:** Sistema de gestão de pedidos para restaurantes
- **project_type:** fullstack

## 3. Requisitos Funcionais (FR)

### FR-01 — [Fase 1] Cadastro de clientes
DADO [contexto] um cliente autenticado no sistema,
QUANDO ele confirma um pedido com itens válidos,
ENTÃO [P0] o pedido é persistido e uma confirmação é enviada.

### FR-02 — [MVP] Histórico de pedidos
DADO [tag] um cliente com pedidos anteriores,
QUANDO ele abre a tela de histórico,
ENTÃO vê a lista ordenada por data.
`;
    expect(checkSpecContentReady(bracketPrefixSpec).ok).toBe(true);
  });

  it("não confunde nós Mermaid [Label] com placeholders de FR/Gherkin", () => {
    const mermaidOnly = `# PRODUCT_SPEC — App real
## 0. Metadados
- **Produto:** App de verdade
### FR-01 — Fazer login real
DADO usuário válido, QUANDO autentica, ENTÃO entra.
\`\`\`mermaid
flowchart TD
  A[Início] --> B[Fim]
\`\`\``;
    expect(checkSpecContentReady(mermaidOnly).ok).toBe(true);
  });
});
