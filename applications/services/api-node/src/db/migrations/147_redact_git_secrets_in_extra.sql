-- 147 — M-01 (revisao adversarial da Fase 1'): saneamento unico de segredos gravados por erros de git.
-- Antes da correcao, o err.message do git fetch continha o argv completo, com o header Authorization Basic
-- (base64 de x-access-token e o token da instalacao do GitHub App) gravado em projects.extra e em project_dialogue.
-- Aditiva e idempotente: so toca linhas que ainda contem o padrao, e o resultado nao o contem mais.
-- NOTA runner de migrations: sem ponto e virgula em literais ou comentarios, sem blocos DO.

UPDATE projects
   SET extra = regexp_replace(
                 regexp_replace(extra::text, 'Basic [A-Za-z0-9+/=]{16,}', 'Basic [REDACTED]', 'g'),
                 'x-access-token:[A-Za-z0-9_]+', 'x-access-token:[REDACTED]', 'g')::jsonb
 WHERE extra::text ~ '(Basic [A-Za-z0-9+/=]{16,}|x-access-token:[A-Za-z0-9_])';

UPDATE project_dialogue
   SET summary_human = regexp_replace(
                 regexp_replace(summary_human, 'Basic [A-Za-z0-9+/=]{16,}', 'Basic [REDACTED]', 'g'),
                 'x-access-token:[A-Za-z0-9_]+', 'x-access-token:[REDACTED]', 'g')
 WHERE summary_human ~ '(Basic [A-Za-z0-9+/=]{16,}|x-access-token:[A-Za-z0-9_])';
