/**
 * k8sRenderer.ts — DM-T6 (Fase A). Renderer Kubernetes (Kustomize) do modo source_only.
 *
 * A partir da IR (DM-T3), gera k8s/ aplicável com `kubectl apply -k k8s/`:
 *   - Deployment + Service por serviço (imagem ECR, porta, env, probes no healthPath)
 *   - Ingress único com regras por prefixo (auth antes de api; web no catch-all "/")
 *   - Postgres StatefulSet + Service quando db.kind = sidecar|rds; db.kind=external usa
 *     Secret com DATABASE_URL informado pelo cliente
 *   - Secret (JWT_SECRET, DB creds) via kustomize secretGenerator (placeholders no .env)
 *   - kustomization.yaml amarrando tudo
 *
 * Leste-oeste: <service>.<namespace>.svc.cluster.local — injetado como <SVC>_SERVICE_URL.
 * Puro, determinístico, sem AWS/cluster. Segredos = placeholders (nunca valor real).
 */

import type { ProvisionPlanIR, PlanService } from "../provisionPlanIR.js";
import type { RenderedFile } from "./composeRenderer.js";

function k8sName(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
}
const DB_SVC = "db";

function hasManagedDb(plan: ProvisionPlanIR): boolean {
  return plan.db.kind === "sidecar" || plan.db.kind === "rds";
}

/** Env de um serviço em formato k8s (valueFrom secretKeyRef p/ segredos). */
function envYaml(plan: ProvisionPlanIR, svc: PlanService, indent: string): string {
  const lines: string[] = [];
  const push = (name: string, value: string) => lines.push(`${indent}- name: ${name}\n${indent}  value: "${value}"`);
  const pushSecret = (name: string, key: string) =>
    lines.push(`${indent}- name: ${name}\n${indent}  valueFrom:\n${indent}    secretKeyRef:\n${indent}      name: app-secrets\n${indent}      key: ${key}`);

  push("NODE_ENV", "production");
  push("PORT", String(svc.port));
  if (svc.databaseName && hasManagedDb(plan)) {
    push("DATABASE_URL", `postgresql://genesis:$(DB_PASSWORD)@${DB_SVC}:5432/${svc.databaseName}`);
    pushSecret("DB_PASSWORD", "db-password");
    pushSecret("JWT_SECRET", "jwt-secret");
  } else if (plan.db.kind === "external") {
    pushSecret("DATABASE_URL", "database-url");
    pushSecret("JWT_SECRET", "jwt-secret");
  }
  // Descoberta leste-oeste: DNS interno do k8s.
  for (const other of plan.services) {
    if (other.name === svc.name) continue;
    push(`${other.name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_SERVICE_URL`,
      `http://${k8sName(other.name)}:${other.port}`);
  }
  return lines.join("\n");
}

function renderDeployment(plan: ProvisionPlanIR, svc: PlanService): string {
  const n = k8sName(svc.name);
  return [
    "apiVersion: apps/v1",
    "kind: Deployment",
    `metadata:\n  name: ${n}`,
    "spec:",
    "  replicas: 1",
    `  selector:\n    matchLabels:\n      app: ${n}`,
    "  template:",
    `    metadata:\n      labels:\n        app: ${n}`,
    "    spec:",
    "      containers:",
    `        - name: ${n}`,
    `          image: ${svc.imageRepo}:latest`,
    `          ports:\n            - containerPort: ${svc.port}`,
    "          env:",
    envYaml(plan, svc, "            "),
    `          readinessProbe:\n            httpGet:\n              path: ${svc.healthPath}\n              port: ${svc.port}\n            initialDelaySeconds: 5\n            periodSeconds: 10`,
    `          livenessProbe:\n            httpGet:\n              path: ${svc.healthPath}\n              port: ${svc.port}\n            initialDelaySeconds: 15\n            periodSeconds: 20`,
    "---",
    "apiVersion: v1",
    "kind: Service",
    `metadata:\n  name: ${n}`,
    `spec:\n  selector:\n    app: ${n}\n  ports:\n    - port: ${svc.port}\n      targetPort: ${svc.port}`,
  ].join("\n") + "\n";
}

function renderPostgres(plan: ProvisionPlanIR): string {
  if (!hasManagedDb(plan)) return "";
  const version = (plan.db.kind === "sidecar" || plan.db.kind === "rds") ? plan.db.version : "16";
  const firstDb = (plan.db.kind === "sidecar" || plan.db.kind === "rds") ? (plan.db.databases[0] ?? "appdb") : "appdb";
  return [
    "apiVersion: apps/v1",
    "kind: StatefulSet",
    `metadata:\n  name: ${DB_SVC}`,
    "spec:",
    `  serviceName: ${DB_SVC}`,
    "  replicas: 1",
    `  selector:\n    matchLabels:\n      app: ${DB_SVC}`,
    "  template:",
    `    metadata:\n      labels:\n        app: ${DB_SVC}`,
    "    spec:",
    "      containers:",
    `        - name: postgres\n          image: postgres:${version}-alpine`,
    "          ports:\n            - containerPort: 5432",
    "          env:",
    "            - name: POSTGRES_USER\n              value: \"genesis\"",
    `            - name: POSTGRES_DB\n              value: "${firstDb}"`,
    "            - name: POSTGRES_PASSWORD\n              valueFrom:\n                secretKeyRef:\n                  name: app-secrets\n                  key: db-password",
    "          volumeMounts:\n            - name: data\n              mountPath: /var/lib/postgresql/data",
    "  volumeClaimTemplates:",
    "    - metadata:\n        name: data",
    "      spec:\n        accessModes: [\"ReadWriteOnce\"]\n        resources:\n          requests:\n            storage: 5Gi",
    "---",
    "apiVersion: v1",
    "kind: Service",
    `metadata:\n  name: ${DB_SVC}`,
    `spec:\n  selector:\n    app: ${DB_SVC}\n  ports:\n    - port: 5432\n      targetPort: 5432`,
  ].join("\n") + "\n";
}

function renderIngress(plan: ProvisionPlanIR): string {
  const ingress = plan.services.filter((s) => s.needsIngress);
  if (ingress.length === 0) return "";
  const root = ingress.find((s) => s.isRoot) ?? ingress[ingress.length - 1];
  // Regras específicas primeiro (a IR já vem ordenada por especificidade); catch-all por último.
  const rulePaths: { path: string; svc: PlanService; type: string }[] = [];
  for (const s of ingress) {
    if (s === root) continue;
    rulePaths.push({ path: `${s.routePrefix.replace(/\/$/, "")}`, svc: s, type: "Prefix" });
  }
  rulePaths.push({ path: "/", svc: root, type: "Prefix" });
  const pathsYaml = rulePaths.map((r) =>
    `          - path: ${r.path}\n            pathType: ${r.type}\n            backend:\n              service:\n                name: ${k8sName(r.svc.name)}\n                port:\n                  number: ${r.svc.port}`,
  ).join("\n");
  return [
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata:",
    "  name: genesis",
    "  annotations:",
    "    kubernetes.io/ingress.class: nginx",
    "spec:",
    "  rules:",
    "    - http:",
    "        paths:",
    pathsYaml,
  ].join("\n") + "\n";
}

function renderKustomization(files: string[], plan: ProvisionPlanIR): string {
  const resources = files.map((f) => `  - ${f}`).join("\n");
  const secretLiterals = [
    "      - jwt-secret=CHANGE_ME",
    ...(hasManagedDb(plan) ? ["      - db-password=CHANGE_ME"] : []),
    ...(plan.db.kind === "external" ? ["      - database-url=postgresql://user:pass@host:5432/db"] : []),
  ].join("\n");
  return [
    "apiVersion: kustomize.config.k8s.io/v1beta1",
    "kind: Kustomization",
    "resources:",
    resources,
    "secretGenerator:",
    "  - name: app-secrets",
    "    literals:",
    secretLiterals,
    "generatorOptions:",
    "  disableNameSuffixHash: true",
  ].join("\n") + "\n";
}

/** Bundle Kubernetes completo do modo source_only. */
export function renderK8sBundle(plan: ProvisionPlanIR): RenderedFile[] {
  const files: RenderedFile[] = [];
  const resourceNames: string[] = [];

  for (const svc of plan.services) {
    const path = `k8s/${k8sName(svc.name)}.yaml`;
    files.push({ path, content: renderDeployment(plan, svc) });
    resourceNames.push(`${k8sName(svc.name)}.yaml`);
  }
  const pg = renderPostgres(plan);
  if (pg) { files.push({ path: "k8s/postgres.yaml", content: pg }); resourceNames.push("postgres.yaml"); }
  const ing = renderIngress(plan);
  if (ing) { files.push({ path: "k8s/ingress.yaml", content: ing }); resourceNames.push("ingress.yaml"); }

  files.push({ path: "k8s/kustomization.yaml", content: renderKustomization(resourceNames, plan) });
  return files;
}
