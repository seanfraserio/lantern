import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerRegressionRoutes } from "../regressions.js";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";
import type pg from "pg";

const JWT_SECRET = "test-jwt-secret-32chars-for-hs256";
const USER = { sub: "u1", tenantId: "t1", tenantSlug: "acme", role: "owner" };

function authHeaders(payload = USER) {
  return { authorization: `Bearer ${signJwt(payload, JWT_SECRET)}` };
}

function makeMockPool(): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as pg.Pool;
}

async function buildApp(pool: pg.Pool) {
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerRegressionRoutes(app, pool);
  await app.ready();
  return app;
}

describe("GET /regressions/check", () => {
  it("returns regression check results for all agents", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;

    // ENSURE_TABLE_SQL fires at startup (pool.query called outside routes)
    // Then when the route is hit: get agents, then baseline + recent per agent
    queryMock
      .mockResolvedValueOnce({ rows: [{ agent_name: "my-agent" }], rowCount: 1 })  // DISTINCT agents
      .mockResolvedValueOnce({
        rows: [
          { status: "success", duration_ms: 200, total_input_tokens: 100, total_output_tokens: 50, spans: [] },
        ],
        rowCount: 1,
      })  // baseline rows
      .mockResolvedValueOnce({
        rows: [
          { status: "success", duration_ms: 250, total_input_tokens: 100, total_output_tokens: 60, spans: [] },
        ],
        rowCount: 1,
      })  // recent rows (no significant deviation → no regression events)
      ;

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/regressions/check",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("checkedAt");
    expect(body.agentCount).toBe(1);
    expect(body.agents[0].agentName).toBe("my-agent");
    expect(body.agents[0]).toHaveProperty("baselineMetrics");
    expect(body.agents[0]).toHaveProperty("currentMetrics");
    expect(body.agents[0]).toHaveProperty("regressions");
  });

  it("returns empty results when no agents found", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/regressions/check",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().agentCount).toBe(0);
    expect(res.json().agents).toEqual([]);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "GET", url: "/regressions/check" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /regressions/history", () => {
  it("returns paginated regression events", async () => {
    const event = {
      id: "evt-1",
      agent_name: "my-agent",
      metric: "error_rate",
      baseline_value: 0.02,
      current_value: 0.15,
      change_percent: 650.0,
      detected_at: new Date(),
    };

    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [event], rowCount: 1 })   // main query
      .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });  // count query

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/regressions/history",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body).toHaveProperty("limit");
    expect(body).toHaveProperty("offset");
  });

  it("accepts agentName filter", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/regressions/history?agentName=specific-agent",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
  });
});

describe("POST /regressions/baseline/:agentName", () => {
  it("returns baseline metrics for agent", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        { status: "success", duration_ms: 300, total_input_tokens: 200, total_output_tokens: 100, spans: [] },
        { status: "success", duration_ms: 350, total_input_tokens: 220, total_output_tokens: 110, spans: [] },
      ],
      rowCount: 2,
    });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/regressions/baseline/my-agent",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentName).toBe("my-agent");
    expect(body.traceCount).toBe(2);
    expect(body).toHaveProperty("baseline");
    expect(body.windowDays).toBe(7);
  });

  it("returns 404 when no traces found for agent", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/regressions/baseline/no-such-agent",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
  });
});
