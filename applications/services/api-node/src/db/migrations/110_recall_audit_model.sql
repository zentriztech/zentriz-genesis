-- 110 -- GAP-98/99/100: o que a PRIMEIRA medicao de recall (migracao 109) descobriu sobre si mesma.
--
-- A prova ao vivo em prod (2026-09-08, projeto NVX LastMile, gold set b2e5435900cd1984630cefff9f7e7fed)
-- produziu o numero que a frente queria -- recall do juiz entre 14% e 29%, abaixo da mediana publicada
-- de 47% -- e, ao ser lida, expos TRES defeitos na propria medicao:
--
--   * GAP-98 (grave, corrigido em `specPolicyGate.callPolicyAgent`): o `model_id` explicito era montado
--     ANTES do spread de `llm`, entao o `model_id` do tenant o sobrescrevia em silencio. O casador
--     pedido em OUTRA familia (amazon.nova-pro-v1:0) rodou em us.anthropic.claude-opus-5 -- o modelo do
--     PROPRIO juiz. A medicao virou auto-revisao, que arXiv:2609.04270 mede como ZERO ganho, e mesmo
--     assim `same_family` foi gravado como false, porque era calculado sobre o modelo PEDIDO. E a mesma
--     familia de defeito do GAP-88: declarar a intencao no lugar do fato. Agora a familia sai do modelo
--     que RESPONDEU (`model_used`), e o pedido explicito vence o do tenant.
--     ⚠️  A PRIMEIRA LINHA gravada em `spec_judge_recall_runs` tem `same_family = false` INCORRETO
--     (casador e juiz eram ambos opus-5). Corrigir seria UPDATE de dados de medicao e depende de
--     confirmacao do Jean -- esta migracao NAO altera dado nenhum. A proxima medicao grava linha nova,
--     com gold set novo, e as duas ficam visiveis lado a lado.
--   * GAP-99 (medio, corrigido em `recallLimitations`): a checagem de faixa era de UM LADO SO. Os 7
--     defeitos cairam todos em `corpo_sem_titulo` e NADA foi declarado, porque so existia a frase para o
--     caso inverso. O relatorio publicou 14% como se descrevesse o juiz inteiro, quando descrevia apenas
--     o lado dificil. Faixa com um lado so e limitacao nas DUAS direcoes -- muda para que lado o numero
--     engana, nao se engana.
--   * GAP-100 (medio, corrigido em `auditMatches`): 7 elegiveis x fracao 0,3 = amostra de 2, que
--     devolveu "50% de discordancia". Isso e uma moeda, nao uma estimativa. Agora ha piso de amostra
--     (`SPEC_RECALL_AUDIT_MIN`, default 3) e, quando nem o piso cabe, a limitacao diz que o numero e
--     INDICACAO. Alem disso, terceiro casador da mesma familia do casador passa a ser declarado: mediria
--     consistencia de uma familia consigo mesma e chamaria isso de discordancia entre casadores.
--
-- POR QUE UMA COLUNA NOVA: sem registrar QUEM auditou, "discordancia = 0,5" nao e interpretavel -- foi
-- outra familia discordando ou o mesmo modelo discordando de si? A migracao 109 gravava o casador e nao
-- o auditor, e foi exatamente essa ausencia que deixou o GAP-98 passar em silencio na terceira chamada.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' -- nenhum ';' em literal ou comentario.

ALTER TABLE spec_judge_recall_runs
  ADD COLUMN IF NOT EXISTS audit_model text NOT NULL DEFAULT '';

COMMENT ON COLUMN spec_judge_recall_runs.audit_model IS
  'Modelo que RESPONDEU a auditoria do casador (nao o pedido -- GAP-98). Vazio = auditoria nao rodou, e ai `matcher_disagreement` e NULL. Se for da mesma familia de `match_model`, a discordancia mede consistencia de uma familia consigo mesma e isso fica declarado em `limitations`.';
