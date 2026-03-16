import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { registerJwtAuth, signJwt, getUser } from "../jwt.js";
import type { JwtPayload } from "../jwt.js";

const SECRET = "test-jwt-secret-32chars-for-hs256";
const VALID_PAYLOAD = { sub: "user-1", tenantId: "tenant-1", tenantSlug: "acme", role: "owner" };

async function buildApp(additionalSkipPaths?: string[]) {
  const app = Fastify({ logger: false });
  registerJwtAuth(app, SECRET, additionalSkipPaths);
  // Protected route
  app.get("/protected", async (request) => {
    const user = getUser(request);
    return { userId: user.sub, role: user.role };
  });
  // Route that skips auth (like /health)
  app.get("/health", async () => ({ status: "ok" }));
  await app.ready();
  return app;
}

describe("signJwt", () => {
  it("produces a valid JWT signed with HS256", () => {
    const token = signJwt(VALID_PAYLOAD, SECRET);
    const decoded = jwt.verify(token, SECRET, { algorithms: ["HS256"] }) as JwtPayload;
    expect(decoded.sub).toBe(VALID_PAYLOAD.sub);
    expect(decoded.tenantId).toBe(VALID_PAYLOAD.tenantId);
    expect(decoded.tenantSlug).toBe(VALID_PAYLOAD.tenantSlug);
    expect(decoded.role).toBe(VALID_PAYLOAD.role);
    expect(decoded.exp).toBeDefined();
  });

  it("sets expiry to 24h from now", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signJwt(VALID_PAYLOAD, SECRET);
    const after = Math.floor(Date.now() / 1000);
    const decoded = jwt.decode(token) as JwtPayload;
    const exp = decoded.exp;
    const expectedMin = before + 24 * 3600 - 1;
    const expectedMax = after + 24 * 3600 + 1;
    expect(exp).toBeGreaterThanOrEqual(expectedMin);
    expect(exp).toBeLessThanOrEqual(expectedMax);
  });

  it("generates different tokens for different secrets", () => {
    const t1 = signJwt(VALID_PAYLOAD, "secret-one");
    const t2 = signJwt(VALID_PAYLOAD, "secret-two");
    expect(t1).not.toBe(t2);
  });
});

describe("registerJwtAuth + getUser round-trip", () => {
  it("attaches user to request when valid token is provided", async () => {
    const app = await buildApp();
    const token = signJwt(VALID_PAYLOAD, SECRET);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe("user-1");
    expect(body.role).toBe("owner");
  });

  it("returns 401 when authorization header is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/missing authorization/i);
  });

  it("returns 401 when token is malformed", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer not-a-valid-jwt" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/invalid or expired/i);
  });

  it("returns 401 when token is signed with wrong secret", async () => {
    const app = await buildApp();
    const token = signJwt(VALID_PAYLOAD, "wrong-secret");
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when token is expired", async () => {
    const app = await buildApp();
    const token = jwt.sign(
      { sub: "user-1", tenantId: "t1", tenantSlug: "acme", role: "owner" },
      SECRET,
      { algorithm: "HS256", expiresIn: 1 }
    );
    // Wait 2ms to ensure the 1-second token expires (use past exp)
    const expiredToken = jwt.sign(
      { sub: "user-1", tenantId: "t1", tenantSlug: "acme", role: "owner", exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
      { algorithm: "HS256" }
    );

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when tenantSlug in token is invalid", async () => {
    const app = await buildApp();
    const token = signJwt({ ...VALID_PAYLOAD, tenantSlug: "INVALID SLUG!" }, SECRET);
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/invalid token payload/i);
  });
});

describe("JWT skip paths", () => {
  it("skips auth for /health", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("skips auth for /auth/* routes", async () => {
    const app = Fastify({ logger: false });
    registerJwtAuth(app, SECRET);
    app.post("/auth/login", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/auth/login" });
    expect(res.statusCode).toBe(200);
  });

  it("skips auth for OPTIONS requests (CORS preflight)", async () => {
    const app = Fastify({ logger: false });
    registerJwtAuth(app, SECRET);
    app.options("/protected", async () => ({}));
    await app.ready();

    const res = await app.inject({ method: "OPTIONS", url: "/protected" });
    expect(res.statusCode).toBe(200);
  });

  it("skips auth for additionalSkipPaths exact match", async () => {
    const app = Fastify({ logger: false });
    registerJwtAuth(app, SECRET, ["/sso/callback"]);
    app.get("/sso/callback", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/sso/callback" });
    expect(res.statusCode).toBe(200);
  });

  it("skips auth for additionalSkipPaths prefix match (trailing slash)", async () => {
    const app = Fastify({ logger: false });
    registerJwtAuth(app, SECRET, ["/sso/"]);
    app.get("/sso/login", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/sso/login" });
    expect(res.statusCode).toBe(200);
  });
});

describe("getUser", () => {
  it("throws when no user is set on request", async () => {
    const app = Fastify({ logger: false });
    app.get("/no-auth", async (request, reply) => {
      try {
        getUser(request);
        return reply.send({ ok: true });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/no-auth" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/no authenticated user/i);
  });
});
