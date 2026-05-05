# RUNBOOK MOBILE — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Mobile**:
`mobile_crossplatform`, `mobile_ios`, `mobile_android`

---

## Diferença fundamental

Projetos mobile **não sobem via Docker**. A validação é de artefatos e build — não de containers.

---

## FASE 1 — Artefatos obrigatórios

- [ ] `package.json` com `expo start`, `react-native start` ou equivalente
- [ ] `app/` ou `src/` com screens principais
- [ ] `app.json` ou `app.config.ts` com `sdkVersion` definido (Expo)
- [ ] `src/api/` ou `src/lib/` com clientes de API tipados
- [ ] `tsconfig.json` presente

## FASE 1.1 — TypeScript

```bash
cd $PROJECT_DIR && npx tsc --noEmit 2>&1 | head -40
```

Erros de tipo são BLOCKER — corrija antes de avançar.

## FASE 2 — Build check (sem emulador)

```bash
cd $PROJECT_DIR
npm install --legacy-peer-deps 2>&1 | tail -10
# Para Expo:
npx expo export --platform web 2>&1 | tail -20
# Para React Native puro:
npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output /tmp/rn-check.bundle 2>&1 | tail -20
```

Se o bundle falhar: leia o erro, corrija o import/módulo problemático.

## FASE 3 — Smoke test Mobile (estático)

```bash
# Verificar que telas principais existem
ls $PROJECT_DIR/src/screens/ || ls $PROJECT_DIR/app/
# Verificar que navegação está configurada
grep -r "createStackNavigator\|createNativeStackNavigator\|Stack.Navigator\|Tabs.Navigator" $PROJECT_DIR/src/ | head -5
# Verificar que login aponta para campo email (não username)
grep -r "username\b" $PROJECT_DIR/src/ | grep -v "node_modules\|\.git" | grep -v "// " | head -5
```

Se encontrar `username`: corrigir para `email`.

## Bugs críticos (checklist obrigatório)

- [ ] **B-MOB-01**: `sdkVersion` incompatível com dependências → alinhar com `expo` instalado
- [ ] **B-MOB-02**: `react-navigation` sem `NavigationContainer` no root → verificar `App.tsx`
- [ ] **B-MOB-03**: Login com campo `username` em vez de `email`
- [ ] **B-MOB-04**: Paths de API com `/api/api/` duplicado → paths não devem ter `/api/` se o client já adiciona
- [ ] **B-MOB-05**: `AsyncStorage` não instalado mas importado → `@react-native-async-storage/async-storage`

## Critério PASS Mobile

- [ ] `tsc --noEmit` sem erros
- [ ] `npm install` sem erros críticos
- [ ] Bundle gerado sem erro
- [ ] Telas principais existem no filesystem
- [ ] Navegação configurada corretamente
- [ ] Campo de login é `email`
