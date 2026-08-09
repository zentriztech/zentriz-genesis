/**
 * build-zvoices-slice-zip.mjs — prepara o INSUMO da fatia vertical e2e (sem Bedrock).
 *
 * Monta um ZIP de produto (PRODUCT.json + 7 specs) a partir dos docs reais do
 * zentriz-voices, para ingerir no Genesis (POST /api/products/ingest) e rodar a fábrica.
 *
 * Fatia (roadmap 06, estendida com as libs base reais do zvoices):
 *   Onda 0: SPEC-00 contracts (lib_ts), SPEC-20 tokens (lib_ts)
 *   Onda 1: SPEC-01 identity, SPEC-02 content, SPEC-03 progress (backend_api_nestjs)
 *   Onda 2: SPEC-15 bff-mobile (backend_api_nestjs) — depende de 00,01,02,03
 *   Onda 3: SPEC-19 mobile (mobile_expo) — depende de 20,00,15
 *
 * Deps externas à fatia (SPEC-17 realtime-gw) são APARADAS — o app fala com o BFF; o
 * realtime é composição de runtime, não predecessor de build (convenção §5 do zvoices).
 *
 * Uso: node scripts/build-zvoices-slice-zip.mjs [saida.zip]
 */
import AdmZip from "adm-zip";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SPECS_DIR = "/home/ubuntu/workspace/current/zentriz/zentriz-voices/docs/projects/specs";
const OUT = process.argv[2] || "/tmp/zvoices-slice.zip";

// id do projeto → arquivo de spec + tipo Genesis + dependsOn (dentro da fatia)
const SLICE = [
  { id: "SPEC-00-contracts",   file: "SPEC-00-contracts.md",   type: "lib_ts",             dependsOn: [] },
  { id: "SPEC-20-tokens",      file: "SPEC-20-tokens.md",      type: "lib_ts",             dependsOn: [] },
  { id: "SPEC-01-identity-svc", file: "SPEC-01-identity-svc.md", type: "backend_api_nestjs", dependsOn: ["SPEC-00-contracts"] },
  { id: "SPEC-02-content-svc",  file: "SPEC-02-content-svc.md",  type: "backend_api_nestjs", dependsOn: ["SPEC-00-contracts"] },
  { id: "SPEC-03-progress-svc", file: "SPEC-03-progress-svc.md", type: "backend_api_nestjs", dependsOn: ["SPEC-00-contracts", "SPEC-02-content-svc"] },
  { id: "SPEC-15-bff-mobile",   file: "SPEC-15-bff-mobile.md",   type: "backend_api_nestjs", dependsOn: ["SPEC-00-contracts", "SPEC-01-identity-svc", "SPEC-02-content-svc", "SPEC-03-progress-svc"] },
  { id: "SPEC-19-mobile",       file: "SPEC-19-mobile.md",       type: "mobile_expo",        dependsOn: ["SPEC-20-tokens", "SPEC-00-contracts", "SPEC-15-bff-mobile"], delivery: "source_only" },
];

const manifest = {
  schemaVersion: "1.1.0",
  product: {
    name: "ZVoices — fatia vertical (Genesis e2e)",
    systemId: "zentriz-voices",
    specApproved: true,          // as specs já passaram por rodadas adversárias no zvoices
    deliveryDefault: "source_only",
  },
  projects: SLICE.map((s) => ({
    id: s.id,
    spec: `specs/${s.file}`,
    type: s.type,
    dependsOn: s.dependsOn,
    ...(s.delivery ? { delivery: s.delivery } : {}),
  })),
};

const zip = new AdmZip();
zip.addFile("PRODUCT.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));
for (const s of SLICE) {
  const content = readFileSync(join(SPECS_DIR, s.file), "utf-8");
  zip.addFile(`specs/${s.file}`, Buffer.from(content, "utf-8"));
}
writeFileSync(OUT, zip.toBuffer());

console.log(`✓ ZIP da fatia vertical: ${OUT}`);
console.log(`  produto: ${manifest.product.name}`);
console.log(`  projetos: ${manifest.projects.length}`);
for (const p of manifest.projects) {
  console.log(`   - ${p.id} [${p.type}] ← ${p.dependsOn.join(", ") || "(onda 0)"}`);
}
