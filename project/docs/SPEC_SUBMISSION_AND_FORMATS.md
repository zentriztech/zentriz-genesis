# Envio de spec ao CTO — formatos e fluxo

> Referência única para a tela "Enviar spec ao CTO" no portal (genesis-web) e para o fluxo até o agente CTO do orquestrador. Consulte também [PORTAL_TENANTS_AND_PLANS.md](PORTAL_TENANTS_AND_PLANS.md) e [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md).

---

## 1. Escopo

- **Onde**: tela "Enviar spec ao CTO" no portal **genesis.zentriz.com.br** (genesis-web).
- **O quê**: o usuário (do tenant) envia um ou mais arquivos de especificação para iniciar o fluxo CTO → PM → Dev/QA/DevOps.
- **Até onde**: a spec chega ao **agente CTO** do orquestrador, que gera o Charter e dispara o restante do pipeline.

---

## 2. Formato preferencial: Markdown (.md)

Especificações em **Markdown (.md)** são o **formato preferido e nativo** do orquestrador. O agente CTO consome entrada em Markdown (conteúdo ou referência a arquivo .md). Recomenda-se enviar specs já em .md quando possível.

---

## 3. Formatos aceitos pelo app

O portal **deve aceitar** envio de arquivos nos seguintes formatos:

| Extensão | Formato        | Observação                          |
|----------|----------------|-------------------------------------|
| **.md**  | Markdown       | Preferencial; usado diretamente pelo CTO. |
| **.txt** | Texto plano    | Convertido para .md pelo conversor. |
| **.doc** / **.docx** | Word  | Convertido para .md pelo conversor.  |
| **.pdf** | PDF            | Convertido para .md pelo conversor. |

- É possível enviar **mais de um arquivo**: um arquivo principal (spec) e **pelo menos mais um** arquivo (anexo ou complementar).
- A API e o portal validam extensão/tipo e rejeitam formatos não listados.

---

## 4. Comportamento quando não for .md

Quando o usuário envia arquivo(s) em .txt, .doc/.docx ou .pdf:

1. A **API** armazena o(s) arquivo(s) e registra o projeto/spec (ex.: status `pending_conversion`).
2. O **orquestrador** dispõe de um **auxiliar (conversor)** que transforma esses formatos em **Markdown bem formatado**, seguindo boas práticas (estrutura de títulos, listas, parágrafos, blocos de código quando aplicável).
3. O agente **CTO** recebe **sempre** entrada em Markdown: conteúdo ou referência ao arquivo .md gerado. O CTO nunca consome diretamente .pdf, .doc ou .txt.

Detalhes do conversor: [Fase 2 do plano de integração] e implementação em `orchestrator/spec_converter/` (ou equivalente).

---

## 5. Fluxo resumido

1. **Usuário** envia um ou mais arquivos (md, txt, doc, docx, pdf) pela tela "Enviar spec ao CTO" no portal.
2. **API** recebe o upload (multipart), armazena os arquivos e cria/atualiza o registro do projeto.
3. Se houver arquivos não-.md, a **conversão** é disparada (pela API ou por job no orquestrador); o resultado é um .md único ou consolidado.
4. **Orquestrador** (runner ou pipeline) usa o .md final e **invoca o CTO** com esse conteúdo (ou referência ao arquivo .md).
5. O **CTO** gera o Charter e segue o fluxo descrito em [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md).

---

## 6. Boas práticas do .md gerado pelo conversor

O Markdown produzido pelo conversor deve ser adequado para consumo pelo CTO:

- **Títulos hierárquicos**: uso consistente de `#`, `##`, `###` (h1, h2, h3) para estrutura do documento.
- **Listas**: listas ordenadas e não ordenadas onde fizer sentido (requisitos, passos, itens).
- **Blocos de código**: trechos de código identificados com syntax fence (`` ``` ``) e, se possível, linguagem.
- **Parágrafos**: separação clara entre parágrafos; quebras de linha coerentes.
- **Documento coerente**: o texto final deve ser legível e semanticamente organizado (FR/NFR, contexto, restrições), sem perda relevante de informação em relação ao original.

---

## 7. Referências

| Documento | Uso |
|-----------|-----|
| [PORTAL_TENANTS_AND_PLANS.md](PORTAL_TENANTS_AND_PLANS.md) | Fluxo do projeto e telas do portal. |
| [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) | Entrada (spec) e papel do CTO. |
| [API_CONTRACT.md](API_CONTRACT.md) | Endpoint de upload de spec e autenticação. |
| [context/GENESIS_WEB_CONTEXT.md](../context/GENESIS_WEB_CONTEXT.md) | Contexto do app genesis-web. |

---

*Documento criado em 2026-02-17 — Zentriz Genesis. Atualize quando houver mudanças no fluxo de spec ou nos formatos aceitos.*
