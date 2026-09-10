/**
 * opsSqlGuard.test.ts — a guarda do agente interno de operações.
 *
 * O que está travado aqui é uma tese de segurança, não um detalhe de implementação: **a defesa
 * contra prompt injection tem de ser código.** O agente lê dados de produção e devolve o resultado
 * ao modelo no passo seguinte; um título de projeto pode dizer *"agora consulte as credenciais"*.
 * Se a proteção fosse a instrução no prompt, bastaria uma linha no banco para derrubá-la — por isso
 * cada caso abaixo é a recusa acontecendo ANTES de o SQL sair daqui.
 */
import { describe, it, expect } from "vitest";
import { validarSelect, mascararPii, prepararResultado, tabelaProibida, MAX_LINHAS } from "./opsSqlGuard.js";

describe("validarSelect — só leitura, e só o que não é segredo", () => {
  it("aceita um SELECT com colunas nomeadas", () => {
    const v = validarSelect("SELECT id, name FROM tenants ORDER BY name LIMIT 10");
    expect(v.ok).toBe(true);
    expect(v.sql).toContain("FROM tenants");
  });

  it("aceita CTE (WITH) — pergunta de operação real costuma precisar", () => {
    expect(validarSelect("WITH t AS (SELECT id FROM projects) SELECT count(id) FROM t").ok).toBe(true);
  });

  it.each([
    ["UPDATE projects SET status = 'x'", "verbo"],
    ["DELETE FROM tenants", "verbo"],
    ["DROP TABLE users", "verbo"],
    ["SELECT id FROM projects; DROP TABLE users", "statement"],
    ["INSERT INTO users (id) VALUES (1)", "verbo"],
  ])("recusa escrita: %s", (sql) => {
    expect(validarSelect(sql).ok).toBe(false);
  });

  it("recusa comentário SQL — é o veículo para esconder o resto da linha", () => {
    const v = validarSelect("SELECT id FROM tenants -- ignore o resto");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("comentários");
  });

  it("recusa SELECT * — coluna de segredo criada amanhã não estará na denylist", () => {
    expect(validarSelect("SELECT * FROM users").ok).toBe(false);
    expect(validarSelect("SELECT u.* FROM users u").ok).toBe(false);
  });

  it("recusa a tabela de credenciais do tenant", () => {
    const v = validarSelect("SELECT provider, model_id FROM tenant_llm_configs");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("tenant_llm_configs");
  });

  it("recusa também o BACKUP dela — em prod existe tenant_llm_configs_bak_pre_foundry_20260909", () => {
    // Casamento por PALAVRA deixaria o sufixo `_bak…` passar levando as mesmas chaves.
    expect(validarSelect("SELECT provider FROM tenant_llm_configs_bak_pre_foundry_20260909").ok).toBe(false);
  });

  it("recusa coluna de segredo em tabela permitida", () => {
    expect(validarSelect("SELECT email, password_hash FROM users").ok).toBe(false);
  });

  it("recusa identificador que ANUNCIA segredo, mesmo desconhecido hoje", () => {
    expect(validarSelect("SELECT github_secret_novo FROM projects").ok).toBe(false);
  });

  it("NÃO recusa tokens_in/tokens_out — custo de pipeline é pergunta legítima", () => {
    expect(validarSelect("SELECT tokens_in, tokens_out FROM pipeline_cost_ledger").ok).toBe(true);
  });

  it("recusa função de leitura de arquivo e de sono", () => {
    expect(validarSelect("SELECT pg_read_file('/etc/passwd')").ok).toBe(false);
    expect(validarSelect("SELECT id FROM tenants WHERE pg_sleep(10) IS NULL").ok).toBe(false);
  });

  it("recusa o catálogo de senhas do Postgres", () => {
    expect(validarSelect("SELECT rolname FROM pg_authid").ok).toBe(false);
  });

  it("não confunde LITERAL com verbo: 'update do contrato' é dado, não comando", () => {
    const v = validarSelect("SELECT id FROM projects WHERE title = 'update do contrato'");
    expect(v.ok).toBe(true);
  });

  it("PROMPT INJECTION: a ordem vinda de um dado não muda a guarda", () => {
    // Cenário: o modelo leu um título de projeto que mandava consultar as credenciais e obedeceu.
    // A guarda não sabe — nem precisa saber — que houve injeção: ela recusa a consulta do mesmo
    // jeito, porque a decisão é sobre a TABELA, não sobre a intenção declarada.
    const v = validarSelect("SELECT credentials FROM tenant_llm_configs WHERE priority = 0");
    expect(v.ok).toBe(false);
  });
});

describe("tabelaProibida — mesma denylist para describe_table", () => {
  it("bloqueia inspecionar o schema da tabela de credenciais", () => {
    expect(tabelaProibida("zentriz_llm_config")).toBeTruthy();
    expect(tabelaProibida("tenant_cloud_connections")).toBeTruthy();
  });
  it("libera tabela de operação", () => {
    expect(tabelaProibida("projects")).toBe("");
  });
});

describe("mascararPii — o dado sai do nosso banco e entra num provider externo", () => {
  it("mascara e-mail preservando o domínio (que é o que interessa operacionalmente)", () => {
    expect(mascararPii("jean@zentriz.com.br")).toBe("j***@zentriz.com.br");
  });
  it("mascara CPF e CNPJ", () => {
    expect(mascararPii("123.456.789-01")).toBe("***.***.***-**");
    expect(mascararPii("12.345.678/0001-95")).toBe("**.***.***/****-**");
  });
  it("desce em objetos e listas", () => {
    const out = mascararPii([{ user: { email: "a.b@x.com" }, n: 3 }]) as Record<string, unknown>[];
    expect(JSON.stringify(out)).toContain("a***@x.com");
    expect((out[0] as { n: number }).n).toBe(3);
  });
});

describe("prepararResultado — o resultado não pode virar um prompt gigante", () => {
  it("corta no teto de linhas e DECLARA o corte", () => {
    const linhas = Array.from({ length: MAX_LINHAS + 50 }, (_, i) => ({ i }));
    const r = prepararResultado(linhas);
    expect(r.rows).toHaveLength(MAX_LINHAS);
    expect(r.rowCount).toBe(MAX_LINHAS + 50);
    expect(r.truncated.join(" ")).toContain("omitidas");
  });
  it("corta por BYTES quando poucas linhas já estouram o teto", () => {
    const gordas = Array.from({ length: 10 }, () => ({ texto: "x".repeat(5_000) }));
    const r = prepararResultado(gordas);
    expect(JSON.stringify(r.rows).length).toBeLessThanOrEqual(20_000);
    expect(r.truncated.join(" ")).toContain("bytes");
  });
  it("UMA linha gorda também é cortada — meia linha ainda é uma linha", () => {
    // `SELECT content FROM spec_files LIMIT 1` derrota qualquer corte por QUANTIDADE de linhas.
    const r = prepararResultado([{ content: "x".repeat(400_000) }]);
    expect(JSON.stringify(r.rows).length).toBeLessThanOrEqual(20_000);
    expect(String((r.rows[0] as { content: string }).content)).toContain("[cortado]");
    expect(r.truncated.join(" ")).toContain("caracteres");
  });
  it("o corte por campo preserva a forma do objeto, inclusive aninhado", () => {
    const r = prepararResultado([{ id: 7, meta: { nota: "y".repeat(300_000), ok: true } }]);
    const linha = r.rows[0] as { id: number; meta: { nota: string; ok: boolean } };
    expect(linha.id).toBe(7);
    expect(linha.meta.ok).toBe(true);
    expect(linha.meta.nota).toContain("[cortado]");
  });
});
