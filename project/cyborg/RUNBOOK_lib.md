# RUNBOOK LIB — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Biblioteca / SDK**:
`lib_sdk`, `lib_cli`, `lib_plugin`

---

Bibliotecas não sobem via Docker. A validação é de build, tipos e testes unitários.

---

## FASE 1 — Artefatos obrigatórios

- [ ] `package.json` com `main`, `types` e `exports` definidos
- [ ] `tsconfig.json` com `declaration: true`
- [ ] `src/index.ts` como entry point
- [ ] `README.md` com exemplo de uso
- [ ] Para CLI: `bin` definido no `package.json`

## FASE 1.1 — TypeScript e build

```bash
cd $PROJECT_DIR
npm install --legacy-peer-deps
npx tsc --noEmit 2>&1 | head -30
npm run build 2>&1 | tail -20
```

Erros de tipo ou build são BLOCKER.

## FASE 2 — Testes

```bash
cd $PROJECT_DIR
npm test 2>&1 | tail -30
```

Se não houver testes: MAJOR (não BLOCKER), registrar no log.

## FASE 3 — Smoke test Lib

**Para SDK:**
```bash
# Verificar que os exports principais existem no build
ls $PROJECT_DIR/dist/ | head -10
node -e "const lib = require('./$PROJECT_DIR/dist/index.js'); console.log(Object.keys(lib))"
```

**Para CLI:**
```bash
node $PROJECT_DIR/dist/cli.js --help 2>&1 | head -10
```

## Bugs críticos

- [ ] **B-LIB-01**: `types` no package.json aponta para arquivo inexistente
- [ ] **B-LIB-02**: `exports` não cobre os subpaths usados nos exemplos do README
- [ ] **B-LIB-03**: CLI sem `#!/usr/bin/env node` no entry point → não executável

## Critério PASS Lib

- [ ] `tsc --noEmit` sem erros
- [ ] `npm run build` sem erros
- [ ] `dist/` gerado com `index.js` e `index.d.ts`
- [ ] CLI executa `--help` sem crash (se lib_cli)
