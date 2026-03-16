import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerBillingRoutes } from "../billing.js";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";
import type pg from "pg";

// Mock Stripe
const mockSessionCreate = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/pay/test" });
const mockPortalCreate = vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/portal/test" });
const mockWebhooksConstruct = vi.fn();

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    customers: {
      create: vi.fn().mockResolvedValue({ id: "cus_test123" }),
    },
    checkout: {
      sessions: { create: mockSessionCreate },
    },
    billingPortal: {
      sessions: { create: mockPortalCreate },
    },
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        cancel_at_period_end: false,
      }),
    },
    webhooks: {
      constructEvent: mockWebhooksConstruct,
    },
  })),
}));

const JWT_SECRET = "test-jwt-secret-32chars-for-hs256";
const USER = { sub: "u1", tenantId: "t1", tenantSlug: "acme", role: "owner" };

const BILLING_CONFIG = {
  stripeSecretKey: "sk_test_fake",
  stripePriceId: "price_test",
  appUrl: "https://app.test",
  stripeWebhookSecret: "whsec_test",
};

function authHeaders(payload = USER) {
  return { authorization: `Bearer ${signJwt(payload, JWT_SECRET)}` };
}

function makeMockPool(tenantRow?: Record<string, unknown>): pg.Pool {
  const defaultTenant = { id: "t1", name: "Acme", slug: "acme", plan: "free", stripe_customer_id: null, stripe_subscription_id: null };
  return {
    query: vi.fn().mockResolvedValue({
      rows: [tenantRow ?? defaultTenant],
      rowCount: 1,
    }),
  } as unknown as pg.Pool;
}

async function buildApp(pool: pg.Pool) {
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerBillingRoutes(app, pool, BILLING_CONFIG);
  await app.ready();
  return app;
}

describe("POST /billing/checkout", () => {
  it("creates checkout session and returns URL", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "t1", name: "Acme", stripe_customer_id: null }], rowCount: 1 })  // get tenant
      .mockResolvedValueOnce({ rows: [{ email: "owner@acme.com" }], rowCount: 1 })  // get user email
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });  // update stripe_customer_id

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain("checkout.stripe.com");
    expect(mockSessionCreate).toHaveBeenCalled();
  });

  it("returns 404 when tenant not found", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "POST", url: "/billing/checkout" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /billing/status", () => {
  it("returns billing status with plan and usage", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [{ plan: "team", stripe_customer_id: null, stripe_subscription_id: null }], rowCount: 1 })  // tenant
      .mockResolvedValueOnce({ rows: [{ trace_count: 5000, input_tokens: 100000, output_tokens: 50000 }], rowCount: 1 });  // usage

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/billing/status",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan).toBe("team");
    expect(body.usage.traceCount).toBe(5000);
    expect(body.limits).toBeDefined();
    expect(body.limits.tracesPerMonth).toBe(1_000_000);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "GET", url: "/billing/status" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /billing/portal", () => {
  it("returns portal URL for tenant with Stripe customer", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ stripe_customer_id: "cus_existing" }],
      rowCount: 1,
    });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain("billing.stripe.com");
    expect(mockPortalCreate).toHaveBeenCalled();
  });

  it("returns 400 when no Stripe customer exists", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ stripe_customer_id: null }],
      rowCount: 1,
    });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/subscribe/i);
  });
});

describe("POST /billing/webhook", () => {
  it("returns 400 when stripe-signature header is missing", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      payload: JSON.stringify({ type: "checkout.session.completed" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/stripe-signature/i);
  });

  it("handles checkout.session.completed webhook event", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 1 });

    mockWebhooksConstruct.mockReturnValueOnce({
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { tenantId: "t1" },
          subscription: "sub_test123",
        },
      },
    });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "stripe-signature": "t=123,v1=abc" },
      payload: Buffer.from(JSON.stringify({ type: "checkout.session.completed" })),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });
});
