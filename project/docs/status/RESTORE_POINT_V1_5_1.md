> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Ponto de restauração `v1.5.1` — Zentriz Autonomy Suite (2026-09-09)

Marco tomado **antes** da revisão adversarial do cérebro da Bancada (revisores, geradores,
prompts, oráculos), para que qualquer passo dessa revisão possa ser desfeito por completo —
em **código-fonte** e em **imagens**. Este documento é o inventário; a fonte de verdade é a
tag anotada `v1.5.1` (que carrega os mesmos digests no corpo).

## 1. Código-fonte

| Repositório | Referência | Commit |
|---|---|---|
| `zentriz-genesis` | tag **`v1.5.1`** (branch `main`) | `e8ef92a` |
| `zentriz-connect` | tag **`suite-marco-v1.5.1`** (`main`) | `698b489` |
| `zentriz-deadpool-auto-care` | tag **`suite-marco-v1.5.1`** (`dev`) | `c8cf4cf` |
| `zentriz-autonomy-suite` (workspace) | **não tagueado** — ver §5 | `0383f86` |

A tag `v1.5.0` (`7ea986a`) foi **preservada como estava**: este marco não reescreve
histórico nem re-aponta tag existente.

Estado do código no marco: suíte da api em **157 arquivos / 2.863 testes passando / 1
skipped**, `tsc` limpo. Último GAP fechado: **GAP-168** (a árvore da spec declarava "corpo
presente neste prompt" para um irmão do qual só vieram 12k de 90k chars), provado ao vivo em
produção.

## 2. Imagens — tag imutável `v1.5.1` no ECR

Registry `820198199720.dkr.ecr.us-east-1.amazonaws.com`, região `us-east-1`.

| Repositório ECR | Digest (índice OCI) |
|---|---|
| `zentriz-genesis/api` | `sha256:2bcc37195054f4f7556055bec800d6dc4d81cbf7aa13d68172f9a6381517619c` |
| `zentriz-genesis/genesis-web` | `sha256:74ae201d10ae9e3af2bf6bd617e370e317f0c6889e636b3325565c9e56c9cae9` |
| `zentriz-genesis/agents` | `sha256:06a84f76257e73e71ca077b7680af70345fc162784a4207c4fedae45e6329bed` |
| `zentriz-genesis/runner` | `sha256:66523cd4edf31bbfb44f642e7100984fa68ffc40c11814e475d9cd4d0d3ab19b` |
| `zentriz-genesis/cyborg` | `sha256:7fc8acee6e9a6923871e0997176fdf7f26fbd56c0bbad95f7654479a8a4e6628` |
| `zentriz-genesis/deadpool` | `sha256:4e8c8bc6d47d78551bfdb1ab5950178c931a8268d82f5965a5dd83dfa48518e6` |

**Por que uma tag nova e não `latest`:** `latest` é sobrescrita no próximo deploy — um ponto
de restauração ancorado nela deixaria de existir sozinho. `v1.5.1` é imutável por convenção
e foi criada com `aws ecr put-image` sobre o **mesmo manifesto** que `latest` apontava.

**Prova de que são as imagens em execução:** os seis digests acima foram conferidos, um a um,
contra o `RepoDigests` das imagens dos containers em execução em `3.220.66.113`
(`docker image inspect …/<svc>:latest`). Bateram byte a byte. Além disso, cada host de prod
tem uma tag local de restauração `restore-v1.5.1-<svc>:latest`, que permite voltar **sem
rede** caso o ECR esteja indisponível.

## 3. Banco de dados

Migrations aplicadas até a **122** (`zentriz_genesis`, container
`zentriz-genesis-postgres-1`). Restaurar código/imagem deste marco é compatível com este
schema. **Voltar para ABAIXO da 122 exige rollback de migration à mão** — nenhuma das
migrations do marco tem `down` automático.

## 4. Como restaurar

```bash
# código
git checkout v1.5.1

# imagens, por serviço, no host de prod (api PRIMEIRO — migration roda no boot da api):
aws ecr get-login-password --region us-east-1 \
  | sudo docker login --username AWS --password-stdin 820198199720.dkr.ecr.us-east-1.amazonaws.com
sudo docker pull 820198199720.dkr.ecr.us-east-1.amazonaws.com/zentriz-genesis/<svc>:v1.5.1
sudo docker tag  820198199720.dkr.ecr.us-east-1.amazonaws.com/zentriz-genesis/<svc>:v1.5.1 \
                 zentriz-genesis-<svc>:latest
cd /opt/zentriz-genesis && sudo docker compose up -d --no-build --no-deps --force-recreate <svc>

# sem rede (fallback local do próprio host):
sudo docker tag restore-v1.5.1-<svc>:latest zentriz-genesis-<svc>:latest
```

Depois de recriar, **verificar sempre** (healthy não prova código): digest do container
(`docker inspect --format '{{.Image}}'`) contra a tabela da §2, e `curl
https://genesis.zentriz.com.br/health`.

⚠️ Nunca recrie `api`/`agents` com uma run da Bancada em voo — `up -d api` recria `agents` e
corta a chamada LLM. Pare a run (`POST /api/spec-autonomy/:id/stop`, **sem body**) ou espere
uma janela quieta, e use `--no-deps`.

## 5. O que este marco NÃO cobre (dito explicitamente)

- **`zentriz-autonomy-suite` (workspace) não foi tagueado**: tem três documentos
  modificados e não commitados (`ADR-018`, `adr/README.md`,
  `07-evolution-genesis-deadpool/01-CENARIO-A-…`) de outra frente de trabalho. Tagueá-lo
  agora produziria um marco que não corresponde ao disco. O commit de referência é
  `0383f86`; os três arquivos modificados **não** estão em nenhuma tag.
- **Dados** (specs, projetos, runs, findings) não são restaurados por este marco — ele é de
  código e imagem. O banco de prod não tem snapshot associado a esta tag.
- Segredos e `.env` de produção não estão em nenhum repositório e não são restauráveis daqui.
