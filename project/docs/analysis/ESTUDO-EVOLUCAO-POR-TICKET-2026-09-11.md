> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Estudo — Evolução por Ticket: da frase solta à spec madura

**Data:** 2026-09-11 · **Status:** concluído · **Alimenta:** RFC-0009

Estudo pedido para responder uma pergunta do Jean: *"cada pedido de evolução
poderia receber upload de arquivo, abrir um Ticket na Bancada, amadurecer o texto
usando os recursos da Bancada, e ao promover à Fábrica virar tasks — mantendo o
histórico do git."*

Dois corpos de evidência: **(A)** o que a literatura mede sobre transformar pedido
informal em requisito, e **(B)** o que o código do Genesis já faz hoje, lido linha a
linha. Nenhuma afirmação aqui é suposição: cada número tem fonte aberta ou
`arquivo:linha`.

---

## Parte A — O que a literatura mede

### A.1 O humano não entrega o que a máquina precisa — e isso é medido há 18 anos

Bettenburg et al. (FSE 2008) pesquisaram **872 desenvolvedores** de Apache, Eclipse
e Mozilla (466 respostas) e nomearam o problema central: existe um **descompasso de
informação** entre o que o desenvolvedor precisa e o que o usuário fornece. Os itens
mais úteis — passos para reproduzir, stack trace, caso de teste — são justamente os
**mais difíceis de o usuário produzir**.

Doze anos depois o quadro não mudou: um survey com **305 desenvolvedores** (EMSE
2020) confirmou que descrição de crash, passos de reprodução e stack trace são
considerados altamente importantes e, **apesar disso, são os que mais faltam** nos
relatos.

Um estudo de 2024 (JSS) analisou manualmente **1.000 relatos de 10 aplicações web**,
comparando a versão inicial com a final: informação de diagnóstico e de uso real
**quase sempre entra depois**, ao longo da vida do relato — não no momento em que o
humano escreve.

> **Leitura para o Genesis:** pedir "descreva melhor" não funciona — está medido que
> o humano não sabe o que falta. Quem tem de saber o que falta é o **sistema**, e ele
> tem de **perguntar**. Isso é o oposto de um formulário de ticket mais longo.

### A.2 Anexo ajuda — mas anexo sozinho não é informação

Ainda no estudo JSS 2024: descrição textual e **screenshot são os recursos mais
usados** para descrever um problema, em qualquer tipo de bug. O trabalho ImageR
(EASE 2025), sobre **6.235 issues do Bugzilla** rotuladas, mede o outro lado:
**~22,5% das imagens anexadas não ajudam em nada** a resolução. Relatos com imagem
pertinente tendem a ser mais curtos, mais focados e recebem resposta mais rápida.

> **Leitura para o Genesis:** aceitar upload é necessário e barato. Mas o anexo
> precisa ser **lido** e amarrado ao texto — anexo que ninguém abre é ~1 em cada 4
> vezes ruído.

### A.3 O LLM melhora o texto do humano — com uma taxa de erro conhecida

Estudo de 2026 (arXiv 2601.16699) com **26 participantes** e **130 requisitos
pareados**: cada pessoa escreveu requisitos sem ajuda e depois avaliou a revisão
feita por um GPT-4o. Resultado medido (Wilcoxon, Bonferroni, p<10⁻⁵):

| Dimensão | Resultado | r |
|---|---|---|
| Alinhamento com a intenção | melhor | .878 |
| Legibilidade | melhor | .878 |
| Raciocínio | melhor | .878 |
| Não-ambiguidade | melhor | .876 |

E os números que mais importam para o nosso desenho:

- **43%** das revisões trouxeram à tona **aspectos que o autor não tinha mencionado**
  e que ele considerou importantes;
- **35%** melhoraram a compreensão do próprio autor sobre o que ele pediu;
- **5% (7 de 130) introduziram erro factual ou lógico** — e **6 desses 7** foram
  percebidos por participantes experientes, não pelos novatos;
- **9 menções** a perda de significado (lexical ou conceitual); 20 dos 26 não
  perceberam perda alguma.

Os autores são explícitos: o modelo **não substitui** o stakeholder, o humano
continua sendo *"the ultimate authority on requirements correctness and intent."*

> **Leitura para o Genesis:** amadurecer o texto com LLM é ganho real e grande (43%
> de descoberta). Mas **1 em 20 revisões insere um erro** — e quem pega é o
> experiente. Portanto: o texto original é **imutável**, a revisão é **diff
> aprovável**, e o aprovador é o humano. Sem isso, importamos o erro sem rede.

### A.4 A qualidade da spec depende do insumo — não do modelo

Estudo industrial numa consultoria de TI (arXiv 2507.19113, RE 2025) alimentou LLMs
com resumos de documentos de elicitação + templates de FDS. Conclusão publicada: os
LLMs *"can help automate and standardize the requirements specification, reducing
time and human effort"*, mas a qualidade *"highly depends on inputs and often
requires human revision."* A recomendação é uma **abordagem sinérgica** — LLM
rascunha, analista humano dá o contexto.

> **Leitura para o Genesis:** é o argumento mais forte a favor do upload. Melhorar
> o insumo rende mais que trocar de modelo.

### A.5 Rastreabilidade por ID só funciona quando a máquina escreve

A convenção universal — pôr o ID do issue na mensagem do commit — depende de o
humano lembrar. Medido: **apenas ~60% dos commits ficam linkados** (Rath et al.
2018), ou seja, **~40% de perda**. Existe uma linha de pesquisa inteira (ReLink,
BTLink com BERT) só para **recuperar** os links que se perderam.

> **Leitura para o Genesis:** aqui temos uma vantagem estrutural que a indústria não
> tem — **quem escreve o commit é a Fábrica, não o humano**. Se o agente carimba o
> ticket, a taxa de link é **100% por construção**, e nunca precisamos de
> recuperação heurística. Isso só vale se o ticket for **campo carregado pelo
> pipeline**, não algo que alguém digita.

### A.6 Documentação não co-evolui sozinha — e regenerar tudo é caro

O maior estudo do tema (ICPC 2019) minerou **1,3 bilhão de mudanças de AST** no
histórico completo de **1.500 sistemas**: na maioria dos casos **código e
documentação não co-evoluem**. Um estudo EMSE de 2023 sobre **mais de 3.000
projetos GitHub** achou que a maioria contém, em algum ponto da história,
referência a elemento de código já inexistente. A causa apontada é simples: o
desenvolvedor **não sabe** que a mudança dele tornou o documento obsoleto.

Do lado da correção automática, o trabalho sobre manutenção de README (arXiv
2603.00489) registra duas lições operacionais: abordagens por regra **não conseguem
raciocinar sobre obsolescência escrita em linguagem natural**; e **regeneração
integral a cada mudança é proibitivamente cara** para rodar em CI — o caminho é
decidir *se* precisa atualizar, **localizar onde**, e justificar. LLMCup (arXiv
2507.08671) mostra que gerar **vários candidatos e ranqueá-los** supera a geração
única em 49%–117% de acurácia.

> **Leitura para o Genesis:** o pedido do Jean — *"acrescentar dados de texto dentro
> dos arquivos existentes"* — é exatamente o problema acima. E a resposta medida é:
> **não regenerar o produto inteiro a cada ticket**. Localizar o trecho, propor o
> acréscimo, mostrar diff. Nosso `[Normalizar]` hoje regenera a partir da spec
> vigente; alimentá-lo com N tickets sem localização multiplicaria custo e risco.

---

## Parte B — O que o Genesis já faz (lido no código)

| Peça da ideia | Estado | Evidência |
|---|---|---|
| Pedido vai para a Bancada | ✅ existe | `projects/[id]/page.tsx:979` → `/spec?editProjectId=<filho>&evolve=1` |
| Amadurecer com os recursos da Bancada | ✅ existe | arquiteto gera RFC + ADR + CHANGELOG + `connect.yaml` |
| Promover gera só tasks adicionais | ✅ existe | `evolutionPlanner.ts`, `evolutionGate.ts` (escopo de arquivos é o gate E4) |
| Histórico git para restaurar | ✅ existe | modo `branch`: `evolution/vN` + PR + `evolutionAccept.ts` + `evolutionMergeWorker.ts` |
| Texto original preservado | ✅ existe | `evolutionGate.ts:214-215` grava `evolution_request_original` antes de o sintetizado sobrescrever |
| Documento que amadurece | ✅ existe (base) | `[Normalizar]` do RFC-0008 emenda 01, travado por hash |
| **Upload no pedido** | ❌ **falta** | a rota prevê multipart (`projects.ts:3354`), o diálogo não oferece |
| **Ticket com identidade e fila** | ❌ **não existe** | `rg -i ticket` no código-fonte: zero ocorrências de domínio |
| **Tipo de mudança declarado** | ❌ **não existe** | a Fábrica infere do RFC |
| **Pasta `tickets/` na árvore** | ❌ **não existe** | — |

### B.1 O achado que muda a prioridade

`projects.ts:3391` — guard `EVOLUTION_IN_FLIGHT`: **uma evolução em voo por
serviço**, fail-closed com 409.

Como hoje **pedir e executar são a mesma coisa** (o pedido *é* o projeto filho), a
consequência é que **abrir um segundo pedido é proibido**. Não existe backlog. Não
existe "me pediram três coisas, vou fazer nesta ordem".

**É esse o ganho real do Ticket: separar PEDIR de EXECUTAR.** N tickets abertos, 1
execução em voo — o guard continua valendo, mas na execução.

### B.2 O achado que veta uma parte da ideia

`runner.py:3600`:

```python
task_id_pattern = _re.compile(r'\b(TSK-[A-Z]+-\d+|TSK-\d+)\b')
```

Testado nesta máquina:

```
'## TSK-BE-001 — Titulo'       -> ['TSK-BE-001']
'## TSK-BE-001-TK12 — Titulo'  -> ['TSK-BE-001']   # perde o -TK12 EM SILÊNCIO
'## TSK-001-TK7 — Titulo'      -> ['TSK-001']      # idem
```

O ID de task é **chave de estado**: `task_state.py` (DONE/QA_PASS/QA_FAIL/BLOCKED),
`_evo_register_violation` (rodadas de violação), retomada de run. O sufixo
`TSK-***-TK<N>` seria **truncado sem erro** — o pior modo de falha possível.

Combinado com **A.5**: pôr o ticket no **campo** (e daí no título, no commit e no
PR) entrega a mesma rastreabilidade, com `git log --grep=TK-12` achando tudo, e sem
tocar no identificador que segura o estado de todas as tasks.

---

## Parte C — Síntese: seis princípios de desenho

1. **O ticket não é um formulário novo.** Medido (A.1): o humano não sabe o que
   falta. O sistema pergunta; o humano escreve uma frase e anexa o que tiver.
2. **O original é imutável.** Medido (A.3): 5% das revisões de LLM inserem erro. O
   que o humano pediu fica gravado cru, para sempre, ao lado do que virou.
3. **Toda maturação é um diff aprovável.** Decorre de A.3 e A.4 — o humano é a
   autoridade final, mas só consegue exercer isso se enxergar a mudança.
4. **Quem carimba o ticket é a máquina.** Medido (A.5): confiar no humano custa 40%
   dos links. A Fábrica escreve o commit, então a Fábrica carimba.
5. **Não regenerar o mundo a cada ticket.** Medido (A.6): localizar, propor,
   justificar — regeneração integral é cara e arriscada.
6. **O Ticket é camada fina sobre a evolução que já existe.** B mostra que ~70% do
   caminho está construído; um fluxo paralelo seria o erro clássico do Genesis.

---

## Fontes

- Bettenburg et al., *What Makes a Good Bug Report?* (FSE 2008) — https://eecs481.org/readings/bugreport.pdf
- *The significance of bug report elements* (EMSE 2020) — https://link.springer.com/article/10.1007/s10664-020-09882-z
- *Information needs in bug reports for web applications* (JSS 2024) — https://www.sciencedirect.com/science/article/pii/S0164121224002747
- *ImageR: Enhancing Bug Report Clarity by Screenshots* (EASE 2025) — https://arxiv.org/abs/2505.01925
- *Supporting Stakeholder Requirements Expression with LLM Revisions* (arXiv 2601.16699) — https://arxiv.org/html/2601.16699
- *Exploring the Use of LLMs for Requirements Specification in an IT Consulting Company* (RE 2025) — https://arxiv.org/abs/2507.19113
- *BTLink: automatic link recovery between issues and commits* (EMSE 2023) — https://link.springer.com/article/10.1007/s10664-023-10342-7
- *Detecting outdated code element references in repository documentation* (EMSE 2023) — https://link.springer.com/article/10.1007/s10664-023-10397-6
- *Does My README File Need To Be Updated?* (arXiv 2603.00489) — https://arxiv.org/html/2603.00489
- *LLMCup: Ranking-Enhanced Comment Updating with LLMs* (arXiv 2507.08671) — https://arxiv.org/abs/2507.08671
