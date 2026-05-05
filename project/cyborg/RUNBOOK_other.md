# RUNBOOK OTHER — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Outro**:
`other`

---

Projetos com tipo `other` não se encaixam em nenhuma categoria padrão.
Use o RUNBOOK.md gerado pelo DevOps como guia principal.

---

## FASE 1 — Leitura obrigatória

Leia o `PROJECT_DIR/project/RUNBOOK.md` completo. Ele define:
- Como subir o projeto
- Como testar
- Quais credenciais usar

## FASE 2 — Infraestrutura

Se `docker-compose.yml` presente:
```bash
cd $PROJECT_DIR && docker compose up -d
sleep 15
docker compose logs --tail=50
```

Se não houver compose: siga as instruções do RUNBOOK.md do projeto.

## FASE 3 — Smoke test

Siga os passos de smoke test descritos no `RUNBOOK.md` do projeto.
Se o RUNBOOK.md não descrever smoke test: verifique pelo menos que o processo principal inicia sem erro.

## Critério PASS Other

- [ ] Processo principal sobe sem crash
- [ ] Smoke test do RUNBOOK.md passa (ou RUNBOOK.md não define smoke test — registrar como MAJOR)
- [ ] Sem erros críticos nos logs
