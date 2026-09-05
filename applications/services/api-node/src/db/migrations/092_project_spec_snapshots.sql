-- 092 — SNAPSHOT da spec ANTES de qualquer sobrescrita (rede de seguranca / GAP sistemico G2).
--
-- Medido em prod 2026-09-05: `project_spec_files` guarda UMA versao viva por projeto (58 linhas para
-- 58 projetos) e NAO existia nenhuma tabela de versao/snapshot. O modo autonomo reescreve o arquivo
-- no disco a cada rodada (writeFile in-place): 5 rodadas depois, 7 das 14 secoes da spec do NVX
-- LastMile tinham desaparecido e a recuperacao so foi possivel porque havia um backup MANUAL feito
-- a mao antes do laco rodar. Sem esse backup, o conteudo estaria perdido para sempre.
--
-- Guarda o conteudo ANTERIOR (o que esta sendo substituido), nao o novo: assim a ultima linha e
-- sempre "o estado ao qual eu posso voltar". Retencao (ultimos N por projeto+arquivo) e aplicada em
-- codigo, no mesmo caminho da escrita.
-- NOTA runner de migrations: split ingenuo por ';' — nenhum ';' em literal, comentarios em linha propria.
CREATE TABLE IF NOT EXISTS project_spec_snapshots (
  id              UUID PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_sha256  TEXT NOT NULL,
  chars           INTEGER NOT NULL DEFAULT 0,
  reason          TEXT NOT NULL,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pss_by_file ON project_spec_snapshots(project_id, file_path, created_at DESC);
CREATE INDEX IF NOT EXISTS pss_by_project ON project_spec_snapshots(project_id, created_at DESC);
