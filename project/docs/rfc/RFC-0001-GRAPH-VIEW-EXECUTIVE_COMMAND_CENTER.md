# RFC-0001: Graph View Executivo para Orquestracao Multiagente

## Status

Rascunho

## Data

2026-04-22

## Resumo

Introduzir um `Graph View` progressivo e interativo no Genesis, reutilizavel no futuro Deadpool, para representar squads, agentes, atividades e fluxos de conversa como um sistema vivo, com forte apelo executivo e leitura operacional controlada.

## Contexto

O Genesis ja possui base para exibicao dinamica de agentes, dialogo em linguagem humana e timeline de projeto, mas a experiencia atual ainda comunica melhor a execucao operacional do que a percepcao de "inteligencia coordenada" que costuma gerar impacto imediato em demos executivas.

Para C-level, o problema nao e falta de detalhe tecnico. O problema e falta de uma leitura instantanea de tres perguntas:

1. O sistema esta vivo e coordenado?
2. O trabalho esta avancando ou travou?
3. Onde esta o valor ou o risco agora?

Visualizacoes em grafo, no estilo do `Graph View` do Obsidian, produzem forte sensacao de sistema organico. Isso pode elevar a percepcao de sofisticacao do Genesis e, no futuro, do Deadpool como "command center" autonomo. Porem, um grafo global sem curadoria vira rapidamente uma bola de fios sem valor pratico.

As referencias pesquisadas reforcam alguns pontos:

- Dashboards executivos funcionam melhor quando comunicam o estado principal em menos de 30 segundos e com poucas sinalizacoes centrais.
- Visualizacoes progressivas reduzem carga cognitiva quando comparadas a exibicao total de estruturas complexas de uma vez.
- Grafos com animacao funcionam melhor quando a animacao preserva contexto, ajuda narrativa e nao concorre com a informacao.

Portanto, a feature precisa equilibrar dois objetivos simultaneos:

- **encantamento visual** para demos, comites e acompanhamento executivo;
- **legibilidade e confianca** para nao virar apenas um efeito cenografico.

## Objetivos

- Criar uma camada visual de alto impacto que comunique coordenacao entre squads, agentes e atividades.
- Permitir leitura executiva rapida do estado do projeto ou operacao.
- Preservar drill-down operacional para quem precisa investigar.
- Reaproveitar a semantica do grafo entre Genesis e Deadpool, mudando apenas o foco de negocio.
- Garantir idempotencia, resiliencia e degradacao elegante quando eventos chegarem duplicados, fora de ordem ou quando o stream falhar.

## Nao objetivos

- Substituir timeline, listas, tabelas ou detalhes textuais.
- Mostrar todo o grafo global do workspace por padrao.
- Tornar o grafo a fonte primaria de verdade de status.
- Alterar contratos do Connect neste ciclo inicial.

## Proposta

### 1. Posicionamento da feature

O `Graph View` deve ser tratado como uma **camada de narrativa operacional** e nao apenas como um widget visual.

No Genesis, ele comunica:

- como a spec foi decomposta em squads;
- quais agentes estao atuando;
- quais atividades estao ativas, bloqueadas ou concluidas;
- por onde as conversas e decisoes estao fluindo.

No Deadpool, a mesma linguagem visual pode evoluir para:

- servicos monitorados;
- agentes de diagnostico e remediacao;
- incidentes, hipoteses, acoes e resultados.

### 2. Modos de exibicao

O produto nao deve ter um unico grafo. Deve ter **modos** com densidade e objetivo diferentes.

| Modo | Publico principal | Objetivo |
|------|-------------------|----------|
| **Executive** | C-level, investidor, cliente sponsor | Mostrar saude, progresso, risco e coordenacao em uma leitura rapida |
| **Live Ops** | Operacao, PM, CTO, monitoria | Mostrar fluxo vivo de eventos, bloqueios e transicoes |
| **Local Graph** | Operador, QA, engenharia | Mostrar a vizinhanca de um projeto, squad, agente ou atividade |
| **Replay** | Demo, pos-mortem, vendas | Recontar a historia de um projeto ou incidente no tempo |

O modo padrao para execucao real deve ser o **Local Graph** ou uma versao controlada do **Executive**. O grafo global completo deve existir apenas para showcase, administracao ou analise pontual.

### 3. Modelo semantico do grafo

Para manter clareza, a modelagem deve separar **estrutura** de **evento**.

#### Estrutura persistente

- **Projeto**: ancora principal.
- **Squad**: cluster ou subgrafo.
- **Agente**: ator operacional.
- **Atividade**: unidade de trabalho, etapa ou bloqueio.

#### Overlay temporal

- **Mensagem**: nao precisa virar no primario um no permanente. Pode ser uma aresta temporal ou um pulso visual.
- **Evento**: mudanca de estado, delegacao, bloqueio, aprovacao, deploy, aceite.

#### Mapeamento visual sugerido

| Entidade | Representacao |
|----------|---------------|
| Projeto | no raiz ou foco atual |
| Squad | contorno, cluster, hull ou regiao colorida |
| Agente | no com avatar, cor e papel |
| Atividade | no menor, badge ou subno ligado a squad/agente |
| Mensagem | pulso animado sobre aresta existente |
| Bloqueio | aresta ou badge vermelho com icone e owner visivel |

Decisao importante: **mensagens nao devem inflar o grafo estrutural**. O historico de mensagens deve continuar disponivel em timeline textual; no grafo elas aparecem como fluxo ou evidencia resumida.

### 4. Principios de UX e narrativa

#### 4.1 Progressive disclosure

O grafo deve abrir simples e expandir sob demanda:

1. Primeiro: estado geral do projeto e 5-7 sinais principais.
2. Depois: squads ativas e suas relacoes.
3. Depois: agentes e atividades da area selecionada.
4. Por fim: mensagem, artefato, log e detalhe.

Isso evita sobrecarga cognitiva e preserva o efeito de descoberta.

#### 4.2 Motion com funcao

- A fisica do grafo deve estabilizar rapido.
- Animacao deve destacar chegada de evento, mudanca de status e fluxo entre agentes.
- Em repouso, a tela deve parecer viva, mas calma.
- Deve existir modo de reduzir movimento.

#### 4.3 Leitura executiva em 30 segundos

A tela precisa responder sem clique:

- estado geral;
- gargalo atual;
- squads em destaque;
- recomendacao de atencao.

Por isso o grafo executivo deve ser acompanhado por uma faixa superior com **5-7 indicadores**, por exemplo:

- projetos ativos;
- squads em execucao;
- bloqueios criticos;
- tarefas concluidas no ciclo;
- tempo medio ate aceite;
- deploys ou entregas concluidas;
- confianca operacional do momento.

#### 4.4 Narrativa orientada a resultado

O grafo nao deve dizer apenas "quem falou com quem". Ele deve contar:

- o que esta andando;
- o que foi resolvido;
- o que esta sob risco;
- qual resultado foi produzido.

### 5. Comportamento visual recomendado

- **Layout base**: force-directed com ancoragem leve por projeto/squad para evitar colapso caotico.
- **Cor**: semaforo com simbolo complementar; nunca depender so de cor.
- **Tamanho**: refletir relevancia, nunca volume bruto de mensagens.
- **Filtros**: por projeto, squad, status, janela de tempo e tipo de evento.
- **Foco**: clique em um no gera local graph e painel lateral.
- **Replay temporal**: slider para reproduzir a sequencia de eventos.
- **Snapshot executivo**: congelar o grafo e salvar uma visao estavel para reunioes.

### 6. Integracao com o que ja existe no Genesis

Esta RFC nao parte do zero. Ela deve evoluir as capacidades ja documentadas no Genesis:

- dialogo em linguagem humana;
- perfis de agentes;
- timeline de projeto;
- stepper de status;
- eventos do orquestrador.

O `Graph View` deve consumir essa base como uma nova projecao visual. Em outras palavras:

- a **timeline textual** continua como trilha auditavel;
- o **stepper** continua como resumo deterministico;
- o **grafo** vira a camada de percepcao e navegacao.

## Idempotencia e Resiliencia

Esta feature so sera confiavel se a visualizacao for derivada de um modelo robusto a repeticao, atraso e falha parcial.

### 1. IDs canonicos e upsert deterministico

Cada entidade precisa de identificador estavel:

- `project:{project_id}`
- `squad:{project_id}:{module}`
- `agent:{project_id}:{agent_role}:{agent_scope}`
- `activity:{task_id}`
- `event:{request_id}:{event_type}:{sequence}`

O front nao deve criar identidade visual baseada em ordem de chegada. Ele deve reconciliar por ID canonico.

### 2. Reducer de estado a partir de eventos

O grafo atual deve ser produzido por uma projecao deterministica:

- entrada: eventos tecnicos + dialogo resumido;
- processo: reducer ou projector que consolida estado;
- saida: snapshot do grafo atual.

Isso permite replay, reconstrucao e reprocessamento sem duplicar nos ou arestas.

### 3. Tolerancia a duplicidade e fora de ordem

- Eventos repetidos com mesmo ID devem ser ignorados ou sobrescritos idempotentemente.
- Eventos atrasados devem atualizar o snapshot sem quebrar layout.
- Mensagens sem correspondencia estrutural imediata devem ficar em buffer curto ou ir para fallback textual.

### 4. Snapshot + stream

O cliente deve sempre abrir com:

1. `snapshot` consistente mais recente;
2. depois aplicar `delta stream`.

Se o stream cair:

- manter ultimo estado valido;
- exibir badge de desatualizacao;
- permitir re-sync sem reconstruir toda a experiencia do usuario.

### 5. Degradacao elegante

Se o grafo falhar por volume, conectividade ou erro de rendering:

- manter stepper;
- manter timeline textual;
- manter KPIs;
- substituir o grafo por uma mensagem curta com opcao de tentar novamente.

Uma falha do grafo nao pode impedir a leitura operacional do projeto.

### 6. Controle de densidade

Para evitar "hairball":

- colapsar mensagens em agregados temporais;
- limitar profundidade padrao;
- ocultar nos inativos por janela de tempo;
- agrupar eventos repetitivos por tipo;
- destacar so o caminho critico quando houver bloqueio.

## Alternativas Consideradas

1. **Manter apenas stepper e timeline**
   Resolve operacao basica, mas nao entrega o salto de percepcao visual e nao comunica inteligencia distribuida de forma memoravel.

2. **Mostrar um grafo global sempre expandido**
   Tem alto impacto inicial, mas degrada rapido em legibilidade e tende a virar cenografia sem acao.

3. **Usar apenas swimlanes, gantt ou kanban**
   Sao excelentes para execucao, mas nao comunicam organicidade, dependencia viva e conversa entre agentes com o mesmo poder narrativo.

4. **Transformar cada mensagem em no**
   Facilita auditoria no proprio grafo, mas explode cardinalidade e destroi legibilidade. Melhor manter mensagens como overlay temporal e timeline lateral.

## Impacto

- **Agentes afetados**: nenhum agente muda de papel; a principal mudanca esta na projecao visual dos seus eventos e estados.
- **Orquestrador**: precisa normalizar melhor eventos, relacoes e owners para projecao de grafo.
- **Genesis-Web**: nova camada de visualizacao, filtros, replay e fallback.
- **API**: endpoints de snapshot e stream do grafo por projeto e, futuramente, por portfolio ou operacao.
- **Documentacao**: atualizar navegacao do projeto e, quando aprovado, refletir em guias de UX e blueprint do orquestrador.
- **Contratos afetados**: nenhum contrato do Connect neste primeiro ciclo; eventual convergencia futura pode extrair um schema comum de entidades e eventos.
- **Riscos**:
  - excesso de animacao virar ruido;
  - grafo bonito mas pouco util;
  - inconsistencias entre snapshot, timeline e status textual;
  - performance ruim em projetos com alto volume de eventos;
  - perda de confianca executiva se houver numeros ou estados incorretos.

## Plano de Implementacao

1. **Definir taxonomia visual**
   Fechar o que e no, aresta, cluster, pulso, badge e KPI.

2. **Criar projecao read-only a partir do estado atual**
   Montar um primeiro `graph snapshot` usando dados ja existentes de projeto, dialogue e tasks.

3. **Entregar Modo Executive minimo**
   Exibir projeto, squads, agentes principais, fluxo recente e 5-7 KPIs.

4. **Entregar Local Graph**
   Clique em squad, agente ou atividade abre vizinhanca filtrada com painel lateral.

5. **Adicionar replay temporal**
   Permitir reproduzir historia do projeto a partir dos eventos existentes.

6. **Adicionar resiliencia operacional**
   Snapshot + stream, deduplicacao, badge de stale data, fallback para timeline.

7. **Preparar extensao para Deadpool**
   Reusar a mesma linguagem visual trocando semanticamente "atividade de entrega" por "incidente, diagnostico, remediacao e aprendizado".

## Criterios de aceite propostos

- Um executivo entende o estado do projeto em menos de 30 segundos.
- O grafo abre com layout estavel e sem poluicao visual excessiva.
- O modo local permite investigar um bloqueio sem depender do grafo global.
- Eventos duplicados nao geram nos ou arestas duplicadas.
- Queda de stream nao derruba a leitura do projeto.
- Timeline textual, stepper e grafo permanecem coerentes entre si.

## Referencias

- [ACTORS_AND_RESPONSIBILITIES.md](../ACTORS_AND_RESPONSIBILITIES.md)
- [ORCHESTRATOR_BLUEPRINT.md](../ORCHESTRATOR_BLUEPRINT.md)
- [ENGINEER_AND_TEAM_DYNAMICS_PLAN.md](../plans/ENGINEER_AND_TEAM_DYNAMICS_PLAN.md)
- [IMPLEMENTATION_SUMMARY.md](../status/IMPLEMENTATION_SUMMARY.md)
- GraphTide: Augmenting Knowledge-Intensive Text with Progressive Nested Graph - [https://arxiv.org/html/2604.12624v1](https://arxiv.org/html/2604.12624v1)
- How to Build Executive Dashboards That Actually Get Used - [https://claribi.com/blog/post/build-executive-dashboards-that-get-used/](https://claribi.com/blog/post/build-executive-dashboards-that-get-used/)
- Top Data Visualization Best Practices for 2025 - [https://www.resolution.de/post/data-visualization-best-practices/](https://www.resolution.de/post/data-visualization-best-practices/)
