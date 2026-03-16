import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerApiKeyRoutes } from "../api-keys.js";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";
import type { TenantStore } from "../../store/tenant-store.js";

const JWT_SECRET = "test-jwt-secret-32chars-for-hs256";
const USER = { sub: "u1", tenantId: "t1", tenantSlug: "acme", role: "owner" };

function authHeaders(payload = USER) {
  return { authorization: `Bearer ${signJwt(payload, JWT_SECRET)}` };
}

function makeMockStore(): TenantStore {
  return {
    storeApiKey: vi.fn().mockResolvedValue({
      id: "k1",
      tenantId: "t1",
      keyPrefix: "lnt_abc123",
      name: "My Key",
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    }),
    listApiKeys: vi.fn().mockResolvedValue([
      { id: "k1", tenantId: "t1", keyPrefix: "lnt_abc", name: "My Key", lastUsedAt: null, revokedAt: null, createdAt: new Date().toISOString() },
    ]),
    revokeApiKey: vi.fn().mockResolvedValue(true),
    getUserByEmail: vi.fn(),
    getTenantBySlug: vi.fn(),
    getTenantById: vi.fn(),
    createTenant: vi.fn(),
    createUser: vi.fn(),
    resolveApiKey: vi.fn(),
    initialize: vi.fn(),
  } as unknown as TenantStore;
}

async function buildApp(store: TenantStore) {
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerApiKeyRoutes(app, store);
  await app.ready();
  return app;
}

describe("POST /api-keys", () => {
  it("creates an API key and returns it with 201", async () => {
    const store = makeMockStore();
    const app = await buildApp(store);

    const res = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: authHeaders(),
      payload: { name: "My Key" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^lnt_/);
    expect(body.name).toBe("My Key");
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("prefix");
    expect(store.storeApiKey).toHaveBeenCalledWith("t1", expect.any(String), expect.any(String), "My Key");
  });

  it("returns 400 when name is missing", async () => {
    const app = await buildApp(makeMockStore());
    const res = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name/i);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockStore());
    const res = await app.inject({
      method: "POST",
      url: "/api-keys",
      payload: { name: "My Key" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api-keys", () => {
  it("returns list of API keys for tenant", async () => {
    const store = makeMockStore();
    const app = await buildApp(store);

    const res = await app.inject({
      method: "GET",
      url: "/api-keys",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].name).toBe("My Key");
    expect(store.listApiKeys).toHaveBeenCalledWith("t1");
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockStore());
    const res = await app.inject({ method: "GET", url: "/api-keys" });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api-keys/:id", () => {
  it("revokes an API key and returns revoked: true", async () => {
    const store = makeMockStore();
    const app = await buildApp(store);

    const res = await app.inject({
      method: "DELETE",
      url: "/api-keys/k1",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBe(true);
    expect(store.revokeApiKey).toHaveBeenCalledWith("k1", "t1");
  });

  it("returns 404 when key not found or already revoked", async () => {
    const store = makeMockStore();
    (store.revokeApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const app = await buildApp(store);

    const res = await app.inject({
      method: "DELETE",
      url: "/api-keys/nonexistent",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockStore());
    const res = await app.inject({ method: "DELETE", url: "/api-keys/k1" });
    expect(res.statusCode).toBe(401);
  });
});
