# 📚 Pasta de Contexto — Zentriz Genesis

## Propósito

Esta pasta armazena **documentos de contexto** que permitem que **novos chats** (assistentes de IA) e **desenvolvedores** entendam rapidamente o cenário completo do projeto Zentriz Genesis.

Como o projeto é extenso, com dezenas de documentos e múltiplas camadas (agentes, orquestração, contratos, etc.), os arquivos aqui servem como **âncora de conhecimento** para:

- **Novos chats**: Ler [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) para obter o contexto completo sem precisar percorrer todos os .md do repositório
- **Continuidade**: Preservar decisões, estado atual e próximos passos entre sessões de trabalho
- **Onboarding**: Facilitar que qualquer pessoa (humana ou IA) compreenda a visão, arquitetura e estado do projeto

## Arquivos

| Arquivo | Uso |
|---------|-----|
| [NEXT_CHAT_CONTEXT.md](NEXT_CHAT_CONTEXT.md) | **Contexto para o próximo chat** — estado recente, pipeline, título, erros, Docker, testes; leia primeiro ao iniciar um novo chat |
| [CONTEXT.md](CONTEXT.md) | **Estado atual do projeto** — atividades realizadas, stack, credenciais, como rodar (leia para contexto operacional) |
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | Visão completa do projeto — visão geral e atores |
| [QUICK_REFERENCE.md](QUICK_REFERENCE.md) | Referência rápida de caminhos e conceitos-chave |
| [DEVELOPMENT_CONTEXT.md](DEVELOPMENT_CONTEXT.md) | Por que "Voucher" é citado; análise do que falta; checklist e por onde começar |
| [GENESIS_WEB_CONTEXT.md](GENESIS_WEB_CONTEXT.md) | Contexto do portal genesis-web (stack, roles, telas de login, como rodar, referências) |
| [PRACTICES_FROM_OTHER_PROJECTS.md](PRACTICES_FROM_OTHER_PROJECTS.md) | Análise de práticas de outros projetos (ADRs, RFCs, etc.) |

**Documento de atores (na raiz docs/)**: [docs/ACTORS_AND_RESPONSIBILITIES.md](../docs/ACTORS_AND_RESPONSIBILITIES.md) (em project/docs/) — responsabilidades, hierarquia de comunicação e comportamentos de SPEC, CTO, PM, Dev, QA, DevOps e Monitor.

## Como Usar (para Assistentes de IA)

1. **Novo chat iniciando trabalho no Zentriz Genesis?**  
   Leia primeiro [context/NEXT_CHAT_CONTEXT.md](NEXT_CHAT_CONTEXT.md) para o estado recente e orientação; em seguida [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) para a visão completa e [CONTEXT.md](CONTEXT.md) para credenciais e como rodar.

2. **Precisa de referência rápida?**  
   Consulte [context/QUICK_REFERENCE.md](QUICK_REFERENCE.md).

3. **Contexto desatualizado?**  
   Atualize os arquivos desta pasta quando houver mudanças significativas (em especial NEXT_CHAT_CONTEXT.md, CONTEXT.md e GENESIS_WEB_CONTEXT.md).

## Manutenção

- Atualize `PROJECT_OVERVIEW.md` quando houver mudanças arquiteturais ou de decisão
- Atualize `QUICK_REFERENCE.md` quando novos caminhos ou documentos forem adicionados
- Esta pasta deve refletir o **estado atual** do projeto

---

*Criado em 2026-01-29 — Zentriz Genesis*
