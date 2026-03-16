import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";

// Mock @lantern-ai/ingest before importing the route
const mockQueryTraces = vi.fn().mockResolvedValue([]);
const mockGetTrace = vi.fn().mockResolvedValue(null);
const mockGetSources = vi.fn().mockResolvedValue([]);

vi.mock("@lantern-ai/ingest", () => ({
  PostgresTraceStore: vi.fn().mockImplementation(() => ({
    queryTraces: mockQueryTraces,
    getTrace: mockGetTrace,
    getSources: mockGetSources,
  })),
}));

const JWT_SECRET = "test-jwt-secret-32chars-for-hs256";
const USER = { sub: "u1", tenantId: "t1", tenantSlug: "acme", role: "owner" };

function authHeaders(payload = USER) {
  return { authorization: `Bearer ${signJwt(payload, JWT_SECRET)}` };
}

async function buildApp(dbUrl = "postgres://localhost/test") {
  const { registerTraceRoutes } = await import("../traces.js");
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerTraceRoutes(app, dbUrl);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /traces", () => {
  it("returns list of traces", async () => {
    const trace = { id: "trace-1", agentName: "my-agent", status: "success" };
    mockQueryTraces.mockResolvedValue([trace]);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/traces",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().traces).toHaveLength(1);
    expect(res.json().traces[0].id).toBe("trace-1");
    expect(mockQueryTraces).toHaveBeenCalled();
  });

  it("passes query filters to store", async () => {
    mockQueryTraces.mockResolvedValue([]);
    const app = await buildApp();

    await app.inject({
      method: "GET",
      url: "/traces?agentName=my-agent&status=success&limit=10",
      headers: authHeaders(),
    });

    expect(mockQueryTraces).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "my-agent", status: "success" })
    );
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/traces" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 500 when store throws", async () => {
    mockQueryTraces.mockRejectedValue(new Error("DB error"));
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/traces",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(500);
  });
});

describe("GET /traces/:id", () => {
  it("returns the trace when found", async () => {
    const trace = { id: "trace-1", agentName: "my-agent", status: "success" };
    mockGetTrace.mockResolvedValue(trace);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/traces/trace-1",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("trace-1");
    expect(mockGetTrace).toHaveBeenCalledWith("trace-1");
  });

  it("returns 404 when trace not found", async () => {
    mockGetTrace.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/traces/no-such-trace",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/traces/trace-1" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /sources", () => {
  it("returns list of sources", async () => {
    mockGetSources.mockResolvedValue(["sdk", "proxy"]);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/sources",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sources).toEqual(["sdk", "proxy"]);
  });

  it("uses store cache for same db url + tenant", async () => {
    mockGetSources.mockResolvedValue([]);
    const { PostgresTraceStore } = await import("@lantern-ai/ingest");

    const app = await buildApp("postgres://localhost/test-cache");
    await app.inject({ method: "GET", url: "/sources", headers: authHeaders() });
    await app.inject({ method: "GET", url: "/sources", headers: authHeaders() });

    // Store should be constructed once (cached)
    expect(PostgresTraceStore).toHaveBeenCalledTimes(1);
  });
});
