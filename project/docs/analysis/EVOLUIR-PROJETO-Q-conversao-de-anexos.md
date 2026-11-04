> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · Q — Conversão automática de anexos pdf/doc/docx para `.md`

Branch `evo/h2` (a partir da `dev`, worktree `g-h2`). Sem push, sem deploy, sem produção, sem LLM. Flag nova **`ATTACHMENT_CONVERSION`** (`off|on`, padrão `off`; por tenant; exige `ATTACHMENTS_STRICT=on`). Com `off`, nada muda.

Decisão do Jean (04/11) implementada: `txt/md` ficam na spec; `pdf/doc/docx` ficam guardados no card (fora da pasta de texto) e são convertidos automaticamente em `.md` com marcação da origem.

## 1. Bibliotecas escolhidas (licença e manutenção verificadas)

Verificação feita com `npm view`, `gh api` (repositórios) e leitura do `node_modules` instalado (campo `license` de cada pacote novo (cerca de 40, todos MIT/BSD/ISC/Apache)).

| Uso | Biblioteca | Versão | Licença | Manutenção observada | Observação |
|---|---|---|---|---|---|
| docx | `mammoth` | 1.13.0 | BSD-2-Clause | publicada no npm em 2026-09-26; repositório com push em 2026-10-16, não arquivado | só lê o XML do pacote; não executa macros. Dependências: jszip (MIT OR GPL-3.0 ⇒ usamos MIT), xmldom (MIT), underscore, xmlbuilder, lop (BSD-2) |
| pdf | `pdfjs-dist` | **~5.5.207** | Apache-2.0 | Mozilla; repositório com push em 2026-11-03 | **fixada em 5.5.x de propósito** (ver abaixo) |
| doc legado | `word-extractor` | 1.0.4 | MIT | **fraca**: última publicação no npm em 2022-06, último commit em 2024-06, 150 estrelas | única opção leve de `.doc` em JS puro; mitigada com pré-checagens e worker isolada (ver riscos) |

Descartadas: `unpdf` (exige Node >=24; é wrapper do pdf.js); `pdfjs-dist` 6.x (exige Node >=22.13, e o `Dockerfile` usa `node:20-alpine`).

**Por que `pdfjs-dist` ~5.5.207 e não a 5.6.x/6.x:** o `npm audit` marcou a faixa `>=5.6.83 <6.2.108` (GHSA-hq66-cqwq-w95j, "execução de JavaScript ao abrir PDF malicioso" com `enableScripting` ligado no viewer). A 5.5.207 está fora da faixa, suporta Node `>=20.19`, e usamos só a API de texto (`getDocument` + `getTextContent`), com `isEvalSupported:false`, `enableXfa:false`, `disableFontFace`, `useSystemFonts:false`, sem viewer e sem scripting. Depois da instalação, o `npm audit --omit=dev` não lista mais nenhum pacote novo; restam os avisos já existentes (`fastify`, `adm-zip`, `@fastify/busboy`, `fast-uri`, `find-my-way`, `proxy-addr`), fora do escopo.

**Binário nativo:** o `pdfjs-dist` declara `@napi-rs/canvas` como dependência **opcional** (MIT, binário pré-compilado, sem compilação). Entrou no lockfile e no `node_modules`. Não é usado na rota de texto (só serve ao polyfill de `DOMMatrix`), mas é código nativo carregável. Para removê-lo é preciso um `overrides` no `package.json` ou instalar com `--omit=optional` (isso afetaria outros opcionais, como os binários de plataforma do vitest) — **não feito, fica como decisão do Jean**.

## 2. O que foi implementado

Tudo em `applications/services/api-node/src` (caminhos abaixo relativos a ele).

- `services/attachmentConverters.ts` — extração determinística: `convertBuffer(ext, buf, meta, limits)`. Cabeçalho de origem exato: `> Convertido automaticamente de <nome> (anexo <id>, sha256 <8>) em <data>; pode conter perdas de formatação`.
- `services/attachmentConversionWorker.ts` + `services/attachmentConversionRunner.ts` — cada conversão roda em **worker thread** descartável, com `resourceLimits` (heap), timeout rígido (`terminate()`), `env: {}` (nenhum segredo da api visível), `fetch` desabilitado.
- `services/attachmentConversionQueue.ts` — fila durável e idempotente, `kickTicketConversions` (hook do upload), `drainTicketConversions` (hook da materialização), worker periódico (`startAttachmentConversionWorker`, 30 s; só olha a tabela se houver linha aberta).
- `db/migrations/160_attachment_conversions.sql` — **única migration** (última existente era a 147; usei 160+ como combinado): tabela `attachment_conversions` (UNIQUE `(attachment_id, content_sha256)`) e índice único parcial `ticket_attachments(derived_from_attachment_id, filename)`.
- Ponto mínimo nos arquivos compartilhados: `featureFlags.ts` (1 linha em `FLAG_DEFS` ⇒ entra sozinha em `CONFIG_KEYS` com `adminOnly`, pois `runtimeConfig.ts` deriva as flags de `FLAG_NAMES`), `routes/tickets.ts` (1 linha após o `COMMIT` do upload), `services/tickets.ts` (1 linha na materialização), `index.ts` (start/stop do worker). **Não toquei** `evolveClaim.ts`, `cardState.ts`, runner Python.
- Testes e apoio: `testing/attachmentFixtures.ts` (docx, pdf, pdf sem texto, pdf com JS, **.doc OLE2 real gerado à mão**, zip bomb, zip que mente no tamanho), `types/word-extractor.d.ts` (a lib não publica tipos).

### Limites de segurança (padrões CONSERVADORES e NÃO CALIBRADOS; sobrepostos por `ATTACHMENT_CONVERSION_<CAMPO>` no ambiente)

| Limite | Padrão |
|---|---|
| Entrada | 10 MiB (= teto do upload) |
| Páginas do PDF | 300 (excedeu ⇒ `TRUNCATED_PAGES` + aviso no `.md`) |
| Saída | 400.000 caracteres (excedeu ⇒ `TRUNCATED_CHARS` + aviso) |
| Zip (docx): entradas | 1.000 |
| Zip: bytes por entrada / total | 20 MiB / 50 MiB |
| Zip: razão descomprimido/comprimido | 100:1 (entradas >1 MiB e total) |
| Timeout por conversão | 30 s |
| Heap da worker | 512 MiB |

O zip é verificado em duas etapas: limites **declarados** no diretório central e **descompressão real com `maxOutputLength`** de tudo que a conversão pode ler (o tamanho declarado pode mentir). Zip64 e entradas criptografadas são recusados. Macro/conteúdo ativo (M-16): `activeContentProblem` do upload é reaplicado na conversão (defesa em profundidade) e `.doc` com `_VBA_PROJECT` é recusado na conversão.

### Fluxo

1. Upload validado (`ATTACHMENTS_STRICT=on`) → `COMMIT` → `kickTicketConversions` (com a flag ligada: enfileira e dispara em segundo plano; a resposta 201 **não espera**).
2. Claim atômico (`UPDATE ... WHERE status/lock`), leitura do arquivo, conferência do sha256 contra a chave, conversão isolada.
3. Sucesso: grava `<original>.md` ao lado do original (escrita atômica: tmp + rename), insere a linha `kind=spec_text`, `origin=converted:builtin-text-v1`, `derived_from_attachment_id`; o derivado passa pela allowlist (`.md`), teto por arquivo (`ATTACHMENT_MAX_FILE_BYTES`) e UTF-8 estrito. Se o nome colidir com outro anexo do pedido, usa `<original>.<id8>.md` (nunca sobrescreve).
4. Na materialização da spec (`/evolve`), `drainTicketConversions` converte o que ainda estiver pendente; o derivado entra em `project_spec_files` como qualquer txt/md. O original (pdf/doc/docx) continua fora da árvore.
5. Estados: `done` (derivado criado), `empty` (`NO_TEXT_LAYER`, **nenhum derivado**), `failed` (código e mensagem claros; anexo segue guardado sem derivado), `pending`/`running` (retomáveis). Erro determinístico (corrompido, bomba, macro, timeout, memória) é terminal e não repete; erro inesperado reagenda com recuo (60 s, 5 min) até 3 tentativas.

Códigos de erro: `INPUT_TOO_LARGE`, `UNSUPPORTED_TYPE`, `CORRUPT`, `ENCRYPTED`, `ACTIVE_CONTENT`, `ZIP_BOMB`, `TIMEOUT`, `RESOURCE_LIMIT`, `CONVERSION_FAILED`, `FILE_MISSING`, `FILE_CHANGED`, `MAX_ATTEMPTS`, `ATTACHMENT_GONE`. Avisos: `NO_TEXT_LAYER`, `TRUNCATED_PAGES`, `TRUNCATED_CHARS`, `IMAGES_OMITTED`, `CONVERTER_MESSAGES`, `LINKS_SANITIZED`.

## 3. Decisões

- **PDF escaneado ⇒ sem derivado.** O pedido dizia "resultado vazio com aviso `NO_TEXT_LAYER`": registrei `status=empty` + aviso na fila e **não** criei `.md` (um arquivo só com cabeçalho poluiria a spec e daria falsa sensação de conteúdo).
- **Custo: sem LLM.** Interpretação semântica de imagens, gráficos, tabelas escaneadas ou OCR por visão/LLM está **explicitamente fora**: o que não é camada de texto não é convertido. Custo de modelo adicional: zero.
- **Imagens do docx nunca são lidas nem embutidas** (viram `[imagem omitida]` + aviso). Links só `http(s)`, `mailto` e âncoras; `javascript:`, `data:`, `file:` viram só o texto.
- **Cabeçalho/rodapé e notas do `.doc` não entram** (só o corpo, `getBody()`); tabelas do docx saem como texto corrido (o `mammoth` não gera tabela em Markdown).
- **`mammoth.convertToMarkdown`** é marcada como obsoleta pelo autor, mas é suportada; a saída escapa pontuação (`\.`). Aceito; a alternativa (HTML + conversor próprio) fica para quando houver evidência de que atrapalha a leitura pelo agente.
- **A flag exige `ATTACHMENTS_STRICT`** porque é ele que classifica o anexo como `card_only` e mantém o binário fora da spec.
- Limites por **ambiente** (`ATTACHMENT_CONVERSION_*`), não por `genesis_runtime_config`, para não criar chaves/linhas novas além da própria flag. Migrar para config é trivial se for preciso calibrar sem deploy.
- Fila em tabela própria (em vez de reaproveitar `ticket_attachments`) porque a retomada, o recuo e o registro de falha/vazio precisam de estado que a tabela de anexos não tem.

## 4. Testes (saídas reais)

Postgres efêmero `pgvector/pgvector:pg16` na **55441** (migrations 1→160 aplicadas; container `g-h2-pg`, derrubado ao final). A porta 55432 estava ocupada pela frente g-h1, então **não a usei**; as 4 suítes de porta fixa (`llm.reorder`, `llm.role-verify`, `costSource`, `skillFeedback`) rodei contra a 55441 trocando o literal da porta **só na execução** (revertido com `git checkout`, nada commitado).

- Base (informada na tarefa, `dev`, PG na 55432): **215 arquivos, 3781 passaram, 1 pulado**.
- Antes de eu corrigir `featureFlags.test.ts` (lista das flags), a suíte completa dava 1 falha previsível (a flag nova); corrigido.
- **Depois: 217 arquivos, 3818 passaram, 1 pulado, 0 falhas** (`npx vitest run`, PG 55441, as 4 suítes de porta fixa com a porta trocada em tempo de execução).
- `tsc --noEmit`: limpo. `eslint` nos arquivos novos: limpo (o único erro do lint em `routes/tickets.ts:53`, `no-control-regex`, já existia na `dev`).
- Testes novos: `attachmentConverters.test.ts` (23, com worker real) e `attachmentConversionQueue.pg.integration.test.ts` (12, rotas reais + Postgres real). Cobrem: conversão correta dos 3 tipos, cabeçalho exato, PDF sem texto, docx sem texto, zip bomb (razão e soma), zip que mente no tamanho, excesso de entradas, docx corrompido, `.doc` forjado/truncado, macro (docx e doc), PDF com `/JavaScript`, truncamento por caracteres e por páginas, entrada grande, **timeout** (`TIMEOUT`), **memória** (`RESOURCE_LIMIT`), event loop livre durante a conversão, `off` sem enfileirar nada, `on` ponta a ponta (upload → derivado → spec), idempotência (2 execuções ⇒ 1 derivado), **concorrência (2 workers, 3 anexos ⇒ 3 conversões, 3 derivados)**, retomada após reinício (lock vencido retoma; lock vivo não), falha que não bloqueia o card, `FILE_CHANGED`, colisão de nome, drenagem na materialização, precedência da flag por tenant.
- Contrato Python `applications/orchestrator/tests/test_attachment_conversion_contract.py` (3 testes, passam): o `.md` derivado é lido por `load_spec_all` (com a marca de origem no prompt), o binário original não, e derivado não-UTF-8 é erro explícito. O runner **não foi alterado**, então não reexecutei o pytest completo do orquestrador (rodei `test_attachments_inherit_f2.py` + o novo: 28 passaram).
- Build de produção: `tsc --outDir` temporário gerou `attachmentConversionWorker.js` e a conversão de pdf, docx e doc funcionou a partir do `dist` (caminho do container); pasta apagada.

### Saídas reais (fixtures geradas nos testes)

```
.docx  # Título do contrato / Primeiro parágrafo com acentuação: ação, coração\. / Segundo parágrafo\.
.pdf   <!-- página 1 --> / Relatório de requisitos / Linha dois do documento.
.doc   Documento legado / Segundo parágrafo do doc.
.pdf escaneado -> {"markdown":"","warnings":["NO_TEXT_LAYER"]}
cabeçalho: > Convertido automaticamente de contrato.docx (anexo 11111111-2222-3333-4444-555555555555, sha256 <8>) em 2026-11-04; pode conter perdas de formatação
zip bomb 30 MiB (~30 KiB no disco) -> ZIP_BOMB "razão de compressão ..."
memória 4 MiB -> RESOURCE_LIMIT "memória da conversão excedeu 4 MiB"
```

## 5. Estado

- **Validado** (testes automáticos, Postgres real, worker real): tudo da seção 4.
- **Preparado, não ativo**: `ATTACHMENT_CONVERSION` nasce `off`; nenhum deploy, nada em produção. Com `off`: nenhuma linha em `attachment_conversions`, nenhum derivado, spec e listagens iguais às de antes (teste dedicado). A migration 160 é aditiva e só cria tabela/índice.
- **Não validado**: PDFs, docx e `.doc` **reais de clientes** (só fixtures sintéticas pequenas); desempenho e limites com arquivos grandes reais; comportamento no container `node:20-alpine` com o `@napi-rs/canvas` musl; leitura pelos agentes da Fábrica do Markdown convertido.

## 6. Riscos

- `word-extractor` pouco mantida (sem release desde 2022). Parser OLE próprio, sem execução; mitigado por validação do cabeçalho, worker com limite de heap, timeout e `env` vazio. Um `.doc` forjado pode custar até 30 s de CPU de uma worker, no máximo.
- **Isolamento de rede real não existe em worker thread.** `fetch` é desabilitado e as bibliotecas não usam rede na rota de texto, mas o isolamento verdadeiro (sem egress) é do container. Idem para sistema de arquivos: a worker poderia, em tese, ler arquivos do processo; mitigado por `env: {}` e por só receber bytes. Sandbox de processo/seccomp ficaria para um passo futuro.
- Verificação do PDF ativo é best-effort: ações dentro de object streams comprimidos não são vistas pelo detector do upload; a conversão não as executa (API de texto, sem scripting), mas o arquivo original continua guardado e baixável.
- `.doc` com macro só é recusado **na conversão**, não no upload (o upload de `.doc` não foi alterado para não mudar o comportamento do `ATTACHMENTS_STRICT`).
- Se o worker periódico e a materialização cruzarem, a materialização pode seguir sem o derivado de um arquivo que outro processo está convertendo naquele instante (próxima materialização inclui). Janela pequena, sem perda.
- Limites são palpites conservadores (`calibrado=falso`). Texto longo convertido de um PDF grande pode estourar o contexto de agentes; o teto de 400 mil caracteres limita, mas não calibra.
- Binário nativo opcional `@napi-rs/canvas` no lockfile (seção 1).

## 7. Fora de escopo / pendente

OCR e interpretação semântica por visão/LLM (explicitamente fora; custo zero de modelo). Tabelas em Markdown. UI do portal para mostrar o estado da conversão (a fila guarda `status`, `error_code`, `warnings`, mas nenhuma rota nova os expõe). Calibração dos limites com dados reais. Sandbox de processo/rede. Rotação/limpeza de linhas antigas de `attachment_conversions`. Ligar a flag em homologação. Decisão sobre remover o binário nativo opcional.
