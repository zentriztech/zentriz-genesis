/**
 * acm.ts — G1-T18 (Fase C). Certificado TLS via ACM com validação DNS AUTOMÁTICA.
 *
 * GATE 1: cert e hosted zone na MESMA conta Zentriz → criamos o CNAME de validação
 * na zona e esperamos ISSUED de forma síncrona (sem WAITING_CERT_DNS manual).
 *
 * Reusa cert PENDING/ISSUED por domínio (describe-before-create via ledger) — não
 * vaza um cert novo a cada retry. Sem hosted zone (dev), vira no-op: a cadeia segue
 * só com HTTP no ALB (o driver alb trata a ausência de cert).
 */

import {
  RequestCertificateCommand, DescribeCertificateCommand, DeleteCertificateCommand,
  type ACMClient,
} from "@aws-sdk/client-acm";
import {
  ChangeResourceRecordSetsCommand, type Route53Client,
} from "@aws-sdk/client-route-53";
import { acmClient, route53Client } from "./awsClients.js";
import { appHostname, hostedZoneId } from "./dnsConfig.js";
import {
  recordResourceIntent, markResourceCreated, findCreatedResource, patchDeployment,
} from "./backendState.js";
import { registerDriver, type ProvisionContext, type ProvisionDriver } from "./provisionChain.js";

async function upsertValidationRecord(
  r53: Route53Client, zoneId: string, name: string, value: string,
): Promise<void> {
  await r53.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: zoneId,
    ChangeBatch: {
      Changes: [{
        Action: "UPSERT",
        ResourceRecordSet: { Name: name, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: value }] },
      }],
    },
  }));
}

async function waitIssued(acm: ACMClient, r53: Route53Client, zoneId: string, certArn: string): Promise<void> {
  const maxAttempts = 40; // 40 × 15s = 10min
  let validationWritten = false;
  for (let i = 0; i < maxAttempts; i++) {
    const out = await acm.send(new DescribeCertificateCommand({ CertificateArn: certArn }));
    const cert = out.Certificate;
    if (cert?.Status === "ISSUED") return;
    if (cert?.Status === "FAILED" || cert?.Status === "VALIDATION_TIMED_OUT") {
      throw new Error(`ACM_${cert.Status}: cert ${certArn}`);
    }
    // Escreve o CNAME de validação (uma vez, quando o ACM já expôs o ResourceRecord).
    if (!validationWritten) {
      const opt = cert?.DomainValidationOptions?.find((o) => o.ResourceRecord);
      if (opt?.ResourceRecord?.Name && opt.ResourceRecord.Value) {
        await upsertValidationRecord(r53, zoneId, opt.ResourceRecord.Name, opt.ResourceRecord.Value);
        validationWritten = true;
      }
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error(`ACM_TIMEOUT: cert ${certArn} não ficou ISSUED em 10min`);
}

export const acmDriver: ProvisionDriver = {
  key: "acm",
  status: "waiting_cert_dns",

  async provision(ctx: ProvisionContext): Promise<void> {
    const zoneId = hostedZoneId();
    if (!zoneId) {
      // Sem hosted zone → sem cert (dev/homolog). ALB seguirá em HTTP.
      ctx.scratch.acmCertArn = undefined;
      return;
    }
    const hostname = appHostname(ctx);
    const acm = acmClient(ctx.creds);
    const r53 = route53Client(ctx.creds);

    // describe-before-create: reusa cert já pedido p/ este deployment.
    let certArn: string | undefined;
    const prior = await findCreatedResource(ctx.deploymentId, "acm_cert");
    if (prior?.arn) {
      certArn = prior.arn;
    } else {
      const ledgerId = await recordResourceIntent(ctx.deploymentId, "acm_cert", hostname, ctx.creds.region);
      // idempotencyToken = deployment → RequestCertificate repetido não vaza cert novo.
      const out = await acm.send(new RequestCertificateCommand({
        DomainName: hostname, ValidationMethod: "DNS",
        IdempotencyToken: `g${ctx.deploymentId.replace(/-/g, "").slice(0, 31)}`,
        Tags: [{ Key: "zentriz:product", Value: "genesis" }, { Key: "zentriz:deployment_id", Value: ctx.deploymentId }],
      }));
      certArn = out.CertificateArn!;
      await markResourceCreated(ledgerId, certArn, { hostname });
    }

    await waitIssued(acm, r53, zoneId, certArn);
    await patchDeployment(ctx.deploymentId, { acm_cert_arn: certArn });
    ctx.scratch.acmCertArn = certArn;
    ctx.scratch.appHostname = hostname;
  },

  async teardown(ctx: ProvisionContext): Promise<void> {
    const res = await findCreatedResource(ctx.deploymentId, "acm_cert");
    if (res?.arn) {
      const acm = acmClient(ctx.creds);
      // Cert só deleta quando não está mais em uso por listener (o alb.teardown roda antes).
      await acm.send(new DeleteCertificateCommand({ CertificateArn: res.arn })).catch(() => { /* T21 reconcilia */ });
    }
  },
};

registerDriver(acmDriver);
