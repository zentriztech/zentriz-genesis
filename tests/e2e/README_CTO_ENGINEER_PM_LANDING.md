# Teste E2E: CTO → Engineer → PM (Landing)

Teste que executa o fluxo **CTO → Engineer → PM** usando a spec da landing estática (`project/spec/spec_landing_zentriz.txt`).

## Fluxo

1. **CTO** — Converte spec TXT em PRODUCT_SPEC.md (spec intake).
2. **Engineer** — Gera proposta técnica (squads, stack; para landing → squad Web).
3. **CTO** — Gera Project Charter (necessário para o PM).
4. **PM** — Gera backlog para a squad **Web** (landing = frontend, sem backend).

## Pré-requisitos

- **Spec:** `project/spec/spec_landing_zentriz.txt` (existente no repositório).
- **Agents** rodando na porta 8000 com Claude configurado.
- **CLAUDE_API_KEY** no `.env` (ou export).

## Subir agentes e configurar Docker

Para executar os agentes e configurar o ambiente Docker (resiliente, sem retentativas de repair no servidor):

```bash
MAX_REPAIRS=0 ./deploy-docker.sh --host-agents --force-recreate && ./start-agents-host.sh
```

- `MAX_REPAIRS=0`: o servidor não retenta em falhas de validação do envelope (útil para testes determinísticos).
- `--host-agents`: sobe o serviço de agentes no host.
- `--force-recreate`: recria os containers conforme necessário.

## Executar o teste

Na raiz do repositório:

```bash
pytest tests/e2e/test_cto_engineer_pm_landing.py -v -s
```

Com timeout global maior (recomendado para evitar timeout do runner):

```bash
pytest tests/e2e/test_cto_engineer_pm_landing.py -v -s --timeout=1800
```

Variáveis de ambiente opcionais:

| Variável | Descrição | Default |
|----------|------------|---------|
| `API_AGENTS_URL` | URL do serviço de agentes | `http://127.0.0.1:8000` |
| `E2E_CTO_TIMEOUT` | Timeout CTO (s) | `900` |
| `E2E_ENGINEER_TIMEOUT` | Timeout Engineer (s) | `600` |
| `E2E_PM_TIMEOUT` | Timeout PM (s) | `600` |
| `E2E_MAX_RETRIES` | Tentativas por chamada em caso de timeout | `2` |

## Resiliente

- **Health check** no início: se o agents não estiver rodando ou Claude não estiver configurado, todos os testes são **pulados** (skip) com mensagem clara e o comando para subir os agentes.
- **Retry em timeout:** cada chamada a um agente é refeita até `E2E_MAX_RETRIES` vezes em caso de `ReadTimeout`/`ConnectTimeout`.
- Timeouts por agente configuráveis para evitar falhas por ambiente lento.

## Idempotente

- **Project ID fixo:** `cto-engineer-pm-landing` — re-executar não cria múltiplos projetos.
- **Mesma spec:** sempre `project/spec/spec_landing_zentriz.txt`.
- **Saída sobrescrita:** os artefatos são gravados em `tests/e2e/output/cto-engineer-pm-landing/`; nova execução sobrescreve (mesmo resultado lógico).

Artefatos gerados no final (opcional, pelo último teste):

- `PRODUCT_SPEC.md`
- `TECHNICAL_PROPOSAL.md`
- `PROJECT_CHARTER.md`
- `BACKLOG.md`

## Monitoramento

- Logs em tempo real com `-s` (sem captura de stdout).
- Cada etapa loga: agente chamado, status da resposta, paths dos artifacts e tamanho.
- Em falha, a mensagem de skip ou assert indica o passo e a causa.

## Resumo

| Item | Descrição |
|------|-----------|
| Spec | `project/spec/spec_landing_zentriz.txt` |
| Deploy/agents | `MAX_REPAIRS=0 ./deploy-docker.sh --host-agents --force-recreate && ./start-agents-host.sh` |
| Teste | `pytest tests/e2e/test_cto_engineer_pm_landing.py -v -s` |
| Squad PM | Web (frontend; landing sem backend) |
