import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { registerAuthRoutes } from "../auth.js";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";
import type { TenantStore } from "../../store/tenant-store.js";
import type { SchemaManager } from "../../store/schema-manager.js";

const JWT_SECRET = "test-jwt-secret-32chars-for-hs256";

function makeMockStore(): TenantStore {
  return {
    getUserByEmail: vi.fn().mockResolvedValue(null),
    getTenantBySlug: vi.fn().mockResolvedValue(null),
    getTenantById: vi.fn().mockResolvedValue(null),
    createTenant: vi.fn().mockResolvedValue({ id: "t1", slug: "acme", name: "Acme", plan: "team", stripeCustomerId: null, stripeSubscriptionId: null, createdAt: new Date().toISOString() }),
    createUser: vi.fn().mockResolvedValue({ id: "u1", email: "user@acme.com", role: "owner", tenantId: "t1", createdAt: new Date().toISOString() }),
    storeApiKey: vi.fn().mockResolvedValue({ id: "k1", tenantId: "t1", keyPrefix: "lnt_abc", name: "Default", lastUsedAt: null, revokedAt: null, createdAt: new Date().toISOString() }),
    listApiKeys: vi.fn().mockResolvedValue([]),
    revokeApiKey: vi.fn().mockResolvedValue(true),
    resolveApiKey: vi.fn().mockResolvedValue(null),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as TenantStore;
}

function makeMockSchemaManager(): SchemaManager {
  return {
    validateSlug: vi.fn().mockReturnValue(true),
    createTenantSchema: vi.fn().mockResolvedValue(undefined),
    dropTenantSchema: vi.fn().mockResolvedValue(undefined),
  } as unknown as SchemaManager;
}

async function buildApp(store: TenantStore, schemaManager: SchemaManager) {
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerAuthRoutes(app, store, schemaManager, JWT_SECRET);
  await app.ready();
  return app;
}

// Use unique remote addresses per test to avoid hitting rate limits
let ipCounter = 1;
function nextIp() {
  return `10.0.${Math.floor(ipCounter / 255)}.${ipCounter++ % 255 || 1}`;
}

describe("POST /auth/register", () => {
  it("creates tenant + user and returns 201 with token and apiKey", async () => {
    const store = makeMockStore();
    const schemaManager = makeMockSchemaManager();
    const app = await buildApp(store, schemaManager);

    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      remoteAddress: nextIp(),
      payload: { email: "user@acme.com", password: "ValidPass1", tenantSlug: "acme", tenantName: "Acme Corp" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toHaveProperty("token");
    expect(body).toHaveProperty("apiKey");
    expect(body.apiKey).toMatch(/^lnt_/);
    expect(body.user.email).toBe("user@acme.com");
    expect(body.user.role).toBe("owner");
    expect(body.tenant.slug).toBe("acme");
    expect(schemaManager.createTenantSchema).toHaveBeenCalledWith("acme");
  });

  it("returns 400 when required fields are missing", async () => {
    const app = await buildApp(makeMockStore(), makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      remoteAddress: nextIp(),
      payload: { email: "user@acme.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/required/i);
  });

  it("returns 400 for password too short", async () => {
    const app = await buildApp(makeMockStore(), makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      remoteAddress: nextIp(),
      payload: { email: "u@a.com", password: "short", tenantSlug: "acme", tenantName: "Acme" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/password/i);
  });

  it("returns 400 for password missing uppercase", async () => {
    const app = await buildApp(makeMockStore(), makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      remoteAddress: nextIp(),
      payload: { email: "u@a.com", password: "nouppercase1", tenantSlug: "acme", tenantName: "Acme" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for invalid tenant slug", async () => {
    const schemaManager = makeMockSchemaManager();
    (schemaManager.validateSlug as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const app = await buildApp(makeMockStore(), schemaManager);
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      remoteAddress: nextIp(),
      payload: { email: "u@a.com", password: "ValidPass1", tenantSlug: "INVALID SLUG!", tenantName: "Acme" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/slug/i);
  });

  it("returns 409 when email already exists", async () => {
    const store = makeMockStore();
    (store.getUserByEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "existing", email: "user@acme.com", role: "owner", tenantId: "t0", passwordHash: "x", createdAt: new Date().toISOString(),
    });
    const app = await buildApp(store, makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      remoteAddress: nextIp(),
      payload: { email: "user@acme.com", password: "ValidPass1", tenantSlug: "acme", tenantName: "Acme" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when slug already taken", async () => {
    const store = makeMockStore();
    (store.getTenantBySlug as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t0", slug: "acme" });
    const app = await buildApp(store, makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      remoteAddress: nextIp(),
      payload: { email: "new@user.com", password: "ValidPass1", tenantSlug: "acme", tenantName: "Acme" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /auth/login", () => {
  it("returns token and user on valid credentials", async () => {
    const { hashPassword } = await import("../../lib/passwords.js");
    const hash = await hashPassword("ValidPass1");
    const store = makeMockStore();
    (store.getUserByEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: "user@acme.com", role: "owner", tenantId: "t1", passwordHash: hash, createdAt: new Date().toISOString(),
    });
    (store.getTenantById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t1", slug: "acme", name: "Acme", plan: "team", stripeCustomerId: null, stripeSubscriptionId: null, createdAt: new Date().toISOString(),
    });

    const app = await buildApp(store, makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: nextIp(),
      payload: { email: "user@acme.com", password: "ValidPass1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("token");
    expect(body.user.email).toBe("user@acme.com");
  });

  it("returns 400 when email is missing", async () => {
    const app = await buildApp(makeMockStore(), makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: nextIp(),
      payload: { password: "ValidPass1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 for wrong password", async () => {
    const { hashPassword } = await import("../../lib/passwords.js");
    const hash = await hashPassword("CorrectPass1");
    const store = makeMockStore();
    (store.getUserByEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: "user@acme.com", role: "owner", tenantId: "t1", passwordHash: hash, createdAt: new Date().toISOString(),
    });

    const app = await buildApp(store, makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: nextIp(),
      payload: { email: "user@acme.com", password: "WrongPassword1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for unknown email", async () => {
    const app = await buildApp(makeMockStore(), makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: nextIp(),
      payload: { email: "nobody@acme.com", password: "ValidPass1" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /token/refresh", () => {
  it("returns new token when valid JWT is provided", async () => {
    const app = await buildApp(makeMockStore(), makeMockSchemaManager());
    const token = signJwt({ sub: "u1", tenantId: "t1", tenantSlug: "acme", role: "owner" }, JWT_SECRET);

    const res = await app.inject({
      method: "POST",
      url: "/token/refresh",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("token");
  });

  it("returns 401 when no authorization header", async () => {
    const app = await buildApp(makeMockStore(), makeMockSchemaManager());
    const res = await app.inject({ method: "POST", url: "/token/refresh" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for invalid token", async () => {
    const app = await buildApp(makeMockStore(), makeMockSchemaManager());
    const res = await app.inject({
      method: "POST",
      url: "/token/refresh",
      headers: { authorization: "Bearer not.a.valid.token" },
    });
    expect(res.statusCode).toBe(401);
  });
});
