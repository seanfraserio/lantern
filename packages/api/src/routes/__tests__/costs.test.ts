import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerCostRoutes } from "../costs.js";
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
  registerCostRoutes(app, pool);
  await app.ready();
  return app;
}

describe("GET /costs/breakdown", () => {
  it("returns cost breakdown with empty data", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // per-agent
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // per-model
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // daily

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/costs/breakdown",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.perAgent).toEqual([]);
    expect(body.perModel).toEqual([]);
    expect(body.daily).toEqual([]);
  });

  it("aggregates cost data by agent", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { agent_name: "my-agent", total_cost: 1.5, trace_count: 100, avg_cost_per_trace: 0.015, spans: null },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // per-model
      .mockResolvedValueOnce({
        rows: [{ date: "2026-03-01", cost: 1.5, trace_count: 100 }],
        rowCount: 1,
      });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/costs/breakdown",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.perAgent).toHaveLength(1);
    expect(body.perAgent[0].agentName).toBe("my-agent");
    expect(body.perAgent[0].totalCost).toBe(1.5);
    expect(body.daily).toHaveLength(1);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "GET", url: "/costs/breakdown" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /costs/forecast", () => {
  it("returns forecast with current and last month spend", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [{ total_cost: 50.0 }], rowCount: 1 })   // current month spend
      .mockResolvedValueOnce({ rows: [{ total_cost: 40.0 }], rowCount: 1 })   // last month spend
      .mockResolvedValueOnce({ rows: [{ agent_name: "my-agent", current_spend: 50.0 }], rowCount: 1 });  // per-agent

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/costs/forecast",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentMonthSpend).toBe(50.0);
    expect(body.lastMonthSpend).toBe(40.0);
    expect(body).toHaveProperty("projectedMonthlyTotal");
    expect(body).toHaveProperty("dailyAverage");
    expect(body.perAgent).toHaveLength(1);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "GET", url: "/costs/forecast" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /costs/budget", () => {
  it("sets a monthly budget for an agent", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // CREATE TABLE cost_budgets
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });   // INSERT/UPDATE budget

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/costs/budget",
      headers: authHeaders(),
      payload: { agentName: "my-agent", monthlyBudget: 100 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.agentName).toBe("my-agent");
    expect(body.monthlyBudget).toBe(100);
  });

  it("returns 400 when agentName is missing", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/costs/budget",
      headers: authHeaders(),
      payload: { monthlyBudget: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/agentName/i);
  });

  it("returns 400 for non-positive monthlyBudget", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/costs/budget",
      headers: authHeaders(),
      payload: { agentName: "my-agent", monthlyBudget: -10 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/positive/i);
  });
});

describe("GET /costs/budget/alerts", () => {
  it("returns empty alerts when no budgets are set", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // CREATE TABLE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });   // SELECT budgets

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/costs/budget/alerts",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().alerts).toEqual([]);
  });
});
