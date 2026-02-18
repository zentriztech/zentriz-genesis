import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { voucherRoutes } from "./vouchers.js";

describe("voucher routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp() {
    const fastify = Fastify();
    await fastify.register(voucherRoutes);
    return fastify;
  }

  beforeEach(async () => {
    app = await buildApp();
  });

  it("POST /api/vouchers returns 201 and voucherId, status ACTIVE (FR-01)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vouchers",
      payload: {
        value: 100,
        recipient_name: "Jane",
        recipient_document: "12345678900",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("voucherId");
    expect(body.status).toBe("ACTIVE");
  });

  it("POST /api/vouchers returns 400 when body is invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vouchers",
      payload: { value: 50 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body).toHaveProperty("request_id");
  });

  it("GET /api/vouchers/:id returns 404 for unknown id (FR-02)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/vouchers/unknown-id",
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("GET /api/vouchers/:id returns voucher after create (FR-02)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/vouchers",
      payload: {
        value: 200,
        recipient_name: "John",
        recipient_document: "98765432100",
      },
    });
    const { voucherId } = JSON.parse(create.body);
    const res = await app.inject({
      method: "GET",
      url: `/api/vouchers/${voucherId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.voucherId).toBe(voucherId);
    expect(body.status).toBe("ACTIVE");
    expect(body.value).toBe(200);
  });

  it("POST /api/vouchers/:id/redeem returns REDEEMED (FR-03)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/vouchers",
      payload: {
        value: 50,
        recipient_name: "Test",
        recipient_document: "11111111111",
      },
    });
    const { voucherId } = JSON.parse(create.body);
    const res = await app.inject({
      method: "POST",
      url: `/api/vouchers/${voucherId}/redeem`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("REDEEMED");
    const redeemAgain = await app.inject({
      method: "POST",
      url: `/api/vouchers/${voucherId}/redeem`,
    });
    expect(redeemAgain.statusCode).toBe(400);
    expect(JSON.parse(redeemAgain.body).code).toBe("INVALID_STATE");
  });

  it("GET /api/admin/vouchers returns paginated list (FR-04)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/vouchers?page=1&pageSize=10",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty("page", 1);
    expect(body).toHaveProperty("pageSize", 10);
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("request_id");
  });
});
