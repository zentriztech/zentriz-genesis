> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Guia do usuário — Cards da Bancada

Para quem pede mudanças em um produto que o Genesis já fabricou. Aqui você aprende a criar um card, maturar a especificação com a ajuda da IA, validar, promover e acompanhar até a entrega. Se algo travar, a seção 8 diz o que fazer; o operador usa o [runbook](../runbooks/CARDS-BANCADA-RUNBOOK.md).

> **Disponibilidade.** Os cards só aparecem para tenants em que a funcionalidade foi habilitada. Se a sua página do projeto ainda mostra o diálogo antigo "Evoluir projeto", o seu tenant segue o fluxo anterior e este guia não se aplica. Se o quadro mostrar "Os cards de evolução não estão habilitados para este tenant", fale com o administrador.

## 1. O que é um card

Um **card** é um pedido de mudança (identificado como `TK-0001`, `TK-0002`…) feito sobre um produto que já foi fabricado **e aceito** pelo menos uma vez. Cada card tem:

- um **tipo** (Evolução, Correção ou Recurso novo);
- um **texto** com o que deve mudar e por quê;
- **anexos** opcionais;
- uma **especificação própria** (um RFC e, se couber, ADRs) que você refina até ficar pronta;
- um **estado** que mostra em que ponto do caminho ele está.

O card é só o pedido. A execução é feita por um **projeto filho** (a nova versão do serviço), que só nasce quando você **promove** o card. Enquanto você refina, nada é copiado, versionado nem executado, e nenhum custo de fábrica é gerado. O trabalho feito no card nunca se perde se o filho falhar: o pedido continua válido.

## 2. Criar um card

No produto, abra **Cards do produto** e clique em **Novo card**. Você precisa de acesso ao produto, e a conta de gestão (`zentriz_admin`) só consulta: peça a alguém do cliente para criar.

1. **Tipo do card** (escolha com atenção; ele define o que a validação vai exigir):

   | Tipo | Quando usar | O que a validação exige a mais |
   |---|---|---|
   | **Evolução** | Muda ou amplia algo que o produto já faz | RFC válido e passar no gate de compatibilidade |
   | **Correção** | Corrige um defeito | Um cenário de reprodução (`FAIL_TO_PASS`) e compatibilidade no máximo **patch** |
   | **Recurso novo** | Acrescenta uma capacidade nova | A seção **Non-goals** (o que fica de fora) |

   Os três tipos passam pelo mesmo gate de RFC; o tipo só **acrescenta** exigências. Dá para trocar o tipo enquanto o card estiver em Rascunho ou Refinando.
2. **Título** (opcional; se ficar vazio, vale a primeira linha do texto, até 120 caracteres) e **texto do pedido** (obrigatório, até 20.000 caracteres). Descreva o que deve mudar e por quê. Se for uma correção, diga como reproduzir o defeito.
3. **Anexos** (opcional). Tipos aceitos: **PDF, TXT, MD, DOC e DOCX**. Limites padrão: até 10 arquivos, 10 MB cada e 20 MB no total (o servidor confere tipo, quantidade e tamanho).
   - `.txt` e `.md` entram direto no texto de apoio do card.
   - `.pdf`, `.doc` e `.docx` ficam guardados no card e são **convertidos automaticamente para `.md`** (o arquivo gerado registra de qual anexo veio). A conversão leva alguns instantes; a validação espera ela terminar.
   - Se um anexo texto não estiver em UTF-8, o card recusa: reenvie em UTF-8.
4. O modo de trabalho é sempre **branch git**: não há escolha de "cópia".
5. Ao criar, o sistema confere se o serviço tem versão aceita, se há repositório e GitHub App, e se há **orçamento de IA** na versão corrente. Se faltar algo, a mensagem diz o quê (por exemplo, "A versão corrente não tem orçamento de IA definido"). O card usa **o mesmo orçamento do dono da versão**.

Se o produto tiver mais de um serviço, escolha em qual deles o card vale.

## 3. Maturar a especificação do card

Abra o card. As abas são **Pedido**, **Especificação do card**, **Versões** e **Estado e linha do tempo**.

- **Pedido**: o texto original. Edite-o enquanto o card estiver em Rascunho ou Refinando. Depois que o card é promovido, o pedido original fica **imutável** (guardado em `tickets/TK-NNNN/request.md` na árvore da spec).
- **Especificação do card**: é o rascunho de trabalho. Você enxerga a spec da versão atual **somente para leitura** e escreve apenas na pasta do próprio card e no **RFC/ADR do card** (por exemplo `docs/rfc/RFC-0005-<assunto>.md`). Arquivo que já existe na versão atual não pode ser reescrito, e o **número** de um RFC/ADR existente também não pode ser reaproveitado; use outro nome e outro número.
  - **Gerar o RFC com a IA**: o arquiteto escreve o RFC do card a partir do seu pedido (gasta orçamento de IA, só por clique seu). O resumo, as perguntas e os avisos aparecem na tela.
  - **Novo RFC a partir do modelo**: cria o arquivo com a estrutura esperada para você preencher.
  - **Chat IA sobre o arquivo do card**: converse com a IA para melhorar o RFC/ADR aberto.
  - **GAPs e validação da spec do card**: a IA aponta lacunas (GAPs) e ajuda a fechá-las.
  - Edite e clique em **Salvar**. A aba **Versões** guarda o histórico e permite restaurar uma versão anterior.
- O primeiro salvamento na spec leva o card de Rascunho para **Refinando**.

O RFC precisa conter **critérios de aceite em Gherkin** e a lista dos **arquivos que podem mudar**. Para Correção, inclua o cenário de reprodução; para Recurso novo, a seção **Non-goals**.

## 4. Validar ("Pronto")

Clique em **Validar**. O sistema confere o gate de RFC, as exigências do tipo, os anexos (inclusive conversões em andamento) e registra em qual versão do produto o card se baseia. Se estiver tudo certo, o card vira **Pronto** e a spec fica **travada**, para que ninguém a altere entre a validação e a promoção.

- Se a validação disser que falta algo, a mensagem aponta o quê (por exemplo, "Falta o RFC do card, com critérios de aceite em Gherkin e os arquivos que podem mudar").
- Se um anexo ainda está sendo convertido: aguarde e valide de novo.
- Se a spec mudar durante a validação, nada é carimbado: valide de novo.
- Para editar um card **Pronto**, clique em **Reabrir para edição**; o card volta a Refinando e a validação cai (você valida de novo depois).

## 5. Promover

Com o card **Pronto**, o botão **Promover** cria a nova versão do serviço (o projeto filho), copia a árvore atual, prepara o branch `evolution/vN` e leva a spec do card para o filho. Só o **autor do card** ou o **administrador do tenant** pode promover (a conta de gestão não promove).

- A promoção é **segura de repetir**: clicar duas vezes, ou de novo depois de uma queda, não duplica nada; ela continua de onde parou.
- Se a versão do produto mudou desde a validação, a promoção é recusada com **base vencida** e o card volta a Refinando. Clique em **Revalidar** (o sistema confere o card contra a versão atual), ajuste se pedido e valide de novo.
- Depois de promovido, a especificação do card é histórica: não edita mais.
- **Antes de promover o projeto filho à fábrica, ele precisa de um `connect.yaml` válido.** O filho herda a árvore da versão corrente; se essa versão nunca teve o arquivo (serviço gerado antes dessa exigência), o filho não tem o que herdar e a promoção do filho responde **`CONNECT_MISSING`** (409) com a ação indicada. Gere a declaração no filho (botão **Gerar connect.yaml** ou `POST /api/projects/<id-do-filho>/connect-declaration`), revise e promova de novo. É um passo único: as evoluções seguintes herdam o arquivo.

## 6. Acompanhar

O quadro mostra os cards por estado, com tipo, origem, especificações, anexos e link para o PR quando existir. Dentro do card, a aba **Estado e linha do tempo** mostra cada mudança de estado com data e motivo, e a próxima ação sugerida.

O estado muda sozinho conforme o projeto filho anda:

1. A fábrica entra em execução: **Na fábrica**.
2. O projeto filho é **aceito** e o código é publicado em um *pull request* (PR) com `TK-NNNN` no título e no commit.
3. Quando o PR é **mergeado**, o card vira **Entregue**, e as tasks e os arquivos de spec do card são marcados como executados.

A entrega nunca é marcada à mão: depende do aceite **e** do merge.

## 7. O que cada estado significa

| Estado | Significado | O que você faz |
|---|---|---|
| **Rascunho** | Recém-criado; só o pedido existe | Escrever o pedido e iniciar o refinamento |
| **Refinando** | Você está maturando a spec | Refinar e validar |
| **Pronto** | Validado e travado | Promover (ou Reabrir para ajustar) |
| **Promovido** | A promoção criou o filho; a fábrica ainda não começou | Aguardar |
| **Na fábrica** | O projeto filho está sendo executado ou aguardando aceite/merge | Acompanhar; aceitar o filho e mergear o PR quando chegar a hora |
| **Entregue** | Filho aceito e PR mergeado; tasks e specs do card marcadas | Nada (concluído) |
| **Bloqueado** | Algo impede o andamento (orçamento, falha da fábrica, filho descartado) | Ver a seção 8 |
| **Rejeitado** | Alguém recusou o card (definitivo) | Nada; abra outro card se ainda precisar |

Você pode **rejeitar** um card em Rascunho, Refinando, Pronto ou Bloqueado (autor ou administrador; a ação é definitiva e pede confirmação). Só um card em **Rascunho** pode ser **excluído**; nos demais casos, rejeite para manter o histórico.

## 8. O que fazer quando bloqueia

Abra o card e leia a **situação** e o motivo na aba Estado. As situações mais comuns:

| Mensagem ou motivo | O que significa | O que fazer |
|---|---|---|
| **Orçamento** (`budget:…`, por exemplo "O orçamento de IA está pausado" ou "O saldo de IA não comporta a próxima atividade") | O controle de custo parou o filho. O card **não falhou**: só aguarda saldo | Peça ao dono do orçamento para **aumentar o orçamento** da versão (ou, se o bloqueio for `CARD_BUDGET_CAP`, ao administrador para **subir o percentual por card**) e clique em **Retomar**. Se o card voltar a Na fábrica mas a execução continuar parada, **reinicie o projeto filho** (liberar o saldo não religa a execução sozinho) |
| **Falha da fábrica** (`child_failed`, `materialization_failed:…`) | O projeto filho falhou | Veja o porquê no histórico do projeto filho. Corrigida a causa, clique em **Retomar**: o card volta a **Pronto** (se o filho morreu) e você **promove de novo** |
| **Filho arquivado** (`child_archived`) | O projeto filho foi arquivado fora do fluxo | **Retomar** e promover de novo, ou **Rejeitar** se o pedido foi abandonado |
| **`CONNECT_MISSING`** ao promover o projeto filho ("herda a árvore da versão corrente, que não traz um connect.yaml válido") | A versão corrente nunca teve `connect.yaml`; o filho herdou a árvore sem ele | Clique em **Gerar connect.yaml** no filho (ou `POST /api/projects/<id-do-filho>/connect-declaration`, resposta traz a `action`), revise e promova de novo. Passo feito uma vez por serviço |
| "A versão-base mudou desde a validação" | O produto avançou de versão | **Revalidar** e depois **Validar** |
| "A spec está travada" | O card está Pronto | **Reabrir para edição** |
| "O arquivo já existe na versão corrente" | O rascunho tenta reescrever (ou reusar o número de) um arquivo da versão atual | Use outro nome/número de RFC ou ADR |
| "Ainda há anexo sendo convertido" | A conversão para `.md` não terminou | Aguarde e valide de novo |
| "Já existe outra evolução em andamento neste serviço" | Outro filho está vivo na mesma linhagem | Aguarde ele terminar ou peça ao administrador para resolver o filho preso |
| Card **Na fábrica** muito tempo depois do aceite | Falta o PR ser publicado ou mergeado (ou o botão **Republicar** apareceu) | Se aparecer **Republicar**, clique (dono do projeto ou administrador). Depois, **mergeie o PR** no GitHub ou use **Mergear agora** |
| Mensagem de que você "não tem permissão" | Papel insuficiente | Peça ao autor do card ou ao administrador do tenant |

Se **Retomar** responder "Sem saldo para retomar", o orçamento ainda não foi liberado: o card continua Bloqueado até o saldo voltar. Se nada disso resolver, **não tente consertar por conta própria**: avise o administrador do tenant com o código do card (`TK-NNNN`) e a mensagem que apareceu.

## 9. Boas práticas

- Escreva um card por assunto: um card gera uma versão.
- Para correção, descreva os passos para reproduzir o defeito e o resultado esperado.
- Antes de promover, releia o RFC: ele é a base do que a fábrica vai executar.
- Não deixe cards Prontos parados por muito tempo: a base pode ficar vencida.
- Mantenha o orçamento da versão com saldo antes de promover.
- O Auto Care (correções automáticas por incidente) é outra coisa e **não** cria cards: segue como sempre.

## 10. Limites desta versão

- Um card gera **um** projeto filho (lotes de cards ficam para depois).
- Produto fabricado fora do Genesis (repositório externo) ainda não é suportado.
- Mudanças que cruzam serviços ainda dependem de decisão (o card vale para um serviço por vez).
- O orçamento é o do dono da versão. O administrador pode, opcionalmente, definir um **teto percentual por card** (`card_budget_pct`): quando o gasto do card (rascunho de refino + projeto filho) chega a esse percentual do orçamento da versão, o card fica **Bloqueado** (`budget:CARD_BUDGET_CAP`) sem pausar a versão nem os outros cards. Sem essa política, o card compartilha o orçamento do dono.
