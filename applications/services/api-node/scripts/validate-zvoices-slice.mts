/**
 * validate-zvoices-slice.mts — VALIDAÇÃO ADVERSARIAL do insumo (sem Bedrock, sem banco).
 *
 * Roda os MESMOS gates determinísticos que o Genesis aplicaria na ingestão, contra o ZIP
 * da fatia, ANTES de gastar Bedrock. Falha ruidosamente se algo não bater.
 *
 * Checks:
 *  1. extractProductZip detecta o PRODUCT.json e todas as specs.
 *  2. buildProductSketch valida (tipos, specs presentes, DAG) e computa ondas.
 *  3. Toda spec tem FR-NN + Gherkin (senão o CTO/Engineer improvisa — proibido pelo zvoices §2).
 *  4. Toda spec referenciada existe no ZIP e é não-trivial (>50 linhas).
 *  5. Tipos backend NestJS resolvem para backend_api_nestjs (Prisma/Mongoose permitidos).
 *  6. Ondas topológicas coerentes (contracts/tokens na onda 0; mobile na última).
 */
import { readFileSync } from "node:fs";
import { extractProductZip } from "../src/routes/specs.js";
import { buildProductSketch, parseManifest } from "../src/services/productManifest.js";
import { normalizeProjectType } from "../src/services/typePolicyNormalizer.js";

const ZIP = process.argv[2] || "/tmp/zvoices-slice.zip";
const problems: string[] = [];
const ok = (c: boolean, m: string) => { if (c) console.log(`  ✓ ${m}`); else { problems.push(m); console.log(`  ✗ ${m}`); } };

console.log(`\n== Validação adversarial do insumo: ${ZIP} ==\n`);

// 1. extração
const contents = extractProductZip(readFileSync(ZIP));
if (!contents) { console.error("FATAL: extractProductZip retornou null (sem PRODUCT.json)"); process.exit(1); }
ok(true, "PRODUCT.json detectado");
const specFiles = [...contents.files.keys()];
ok(specFiles.length === 7, `7 specs no ZIP (achou ${specFiles.length})`);

// 2. parse + sketch (gates determinísticos)
const manifest = parseManifest(contents.manifestText);
const sketch = buildProductSketch(manifest, specFiles);
ok(sketch.projects.length === 7, `sketch com 7 projetos (achou ${sketch.projects.length})`);
// 5 ondas: [contracts,tokens] → [identity,content] → [progress] → [bff] → [mobile]
// (progress depende de content ⇒ cai na onda 2; bff depende de progress ⇒ onda 3).
ok(sketch.waves.length === 5, `5 ondas topológicas (achou ${sketch.waves.length})`);
ok(sketch.waves[0].includes("SPEC-00-contracts") && sketch.waves[0].includes("SPEC-20-tokens"),
   "onda 0 = contracts + tokens (libs base)");
ok(sketch.waves[sketch.waves.length - 1].includes("SPEC-19-mobile"),
   "última onda = SPEC-19-mobile (consumidor final)");

// 3+4. cada spec: FR-NN + Gherkin + não-trivial
for (const p of manifest.projects) {
  const path = p.spec.replace(/^\.\//, "");
  const body = contents.files.get(path);
  if (body === undefined) { ok(false, `spec presente: ${p.spec}`); continue; }
  const lines = body.split("\n").length;
  const hasFR = /FR-\d/.test(body);
  const hasGherkin = /(DADO|QUANDO|ENTÃO|GIVEN|WHEN|THEN)\b/.test(body);
  ok(lines > 50, `${p.id}: spec não-trivial (${lines} linhas)`);
  ok(hasFR, `${p.id}: tem FR-NN`);
  ok(hasGherkin, `${p.id}: tem aceite Gherkin`);
}

// 5. tipos backend NestJS resolvem corretamente
for (const p of manifest.projects.filter((x) => x.type === "backend_api_nestjs")) {
  const norm = normalizeProjectType(p.type);
  ok(norm === "backend_api_nestjs", `${p.id}: tipo resolve p/ backend_api_nestjs (achou ${norm})`);
}
ok(normalizeProjectType("mobile_expo") === "mobile_crossplatform", "mobile_expo resolve p/ mobile_crossplatform");

// 6. limite de predecessores (convenção zvoices ≤5)
for (const p of manifest.projects) {
  ok((p.dependsOn ?? []).length <= 5, `${p.id}: ≤5 predecessores (tem ${(p.dependsOn ?? []).length})`);
}

console.log(`\n${problems.length === 0 ? "✅ INSUMO VÁLIDO — pronto para a fábrica." : `❌ ${problems.length} problema(s):\n - ${problems.join("\n - ")}`}\n`);
process.exit(problems.length === 0 ? 0 : 1);
