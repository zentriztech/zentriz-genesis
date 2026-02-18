import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { saveVoucher, getVoucher, listVouchers as listVouchersFromStore } from "../store.js";
import type { CreateVoucherBody } from "../types.js";

interface ParamsId {
  id: string;
}

interface QueriesAdmin {
  page?: string;
  pageSize?: string;
}

function getRequestId(request: FastifyRequest): string {
  return (request.headers["x-request-id"] as string) ?? randomUUID();
}

export async function voucherRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/vouchers (FR-01)
  app.post<{ Body: CreateVoucherBody }>("/api/vouchers", async (request, reply) => {
    const requestId = getRequestId(request);
    const body = request.body;
    if (!body?.value || !body?.recipient_name || !body?.recipient_document) {
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: "value, recipient_name and recipient_document are required",
        request_id: requestId,
      });
    }
    const voucherId = randomUUID();
    const voucher = {
      voucherId,
      value: body.value,
      recipient_name: body.recipient_name,
      recipient_document: body.recipient_document,
      status: "ACTIVE" as const,
      createdAt: new Date().toISOString(),
    };
    saveVoucher(voucher);
    return reply.status(201).send({ voucherId, status: "ACTIVE" });
  });

  // GET /api/vouchers/:id (FR-02)
  app.get<{ Params: ParamsId }>("/api/vouchers/:id", async (request, reply) => {
    const requestId = getRequestId(request);
    const v = getVoucher(request.params.id);
    if (!v) {
      return reply.status(404).send({
        code: "NOT_FOUND",
        message: "Voucher not found",
        request_id: requestId,
      });
    }
    return reply.send({
      voucherId: v.voucherId,
      value: v.value,
      recipient_name: v.recipient_name,
      recipient_document: v.recipient_document,
      status: v.status,
      createdAt: v.createdAt,
    });
  });

  // POST /api/vouchers/:id/redeem (FR-03)
  app.post<{ Params: ParamsId }>("/api/vouchers/:id/redeem", async (request, reply) => {
    const requestId = getRequestId(request);
    const v = getVoucher(request.params.id);
    if (!v) {
      return reply.status(404).send({
        code: "NOT_FOUND",
        message: "Voucher not found",
        request_id: requestId,
      });
    }
    if (v.status !== "ACTIVE") {
      return reply.status(400).send({
        code: "INVALID_STATE",
        message: "Voucher is not ACTIVE",
        details: { status: v.status },
        request_id: requestId,
      });
    }
    v.status = "REDEEMED";
    saveVoucher(v);
    return reply.send({ voucherId: v.voucherId, status: "REDEEMED" });
  });

  // GET /api/admin/vouchers (FR-04)
  app.get<{ Querystring: QueriesAdmin }>("/api/admin/vouchers", async (request, reply) => {
    const requestId = getRequestId(request);
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(request.query.pageSize ?? "20", 10) || 20));
    const { items, total } = listVouchersFromStore(page, pageSize);
    return reply.send({
      items,
      page,
      pageSize,
      total,
      request_id: requestId,
    });
  });
}
