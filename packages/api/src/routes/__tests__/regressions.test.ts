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

/**
 * SQL-matching pool mock — robust against registerRegressionRoutes firing
 * ENSURE_TABLE_SQL at registration time (a fire-and-forget pool.query call).
 * By matching on SQL content, we avoid fragile call-order mocking.
 */
function makeMockPool(options: {
  agents?: Array<{ agent_name: string }>;
  baselineRows?: unknown[];
  recentRows?: unknown[];
  historyRows?: unknown[];
  historyCount?: string;
  snapshotRows?: unknown[];
} = {}): pg.Pool {
  const {
    agents = [],
    baselineRows = [],
    recentRows = [],
    historyRows = [],
    historyCount = "0",
    snapshotRows = [],
  } = options;

  return {
    query: vi.fn().mockImplementation((sql: string) => {
      // Table creation (fires at registration) — always succeeds silently
      if (sql.includes("CREATE TABLE")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      // /regressions/check: get distinct agents
      if (sql.includes("DISTINCT agent_name")) {
        return Promise.resolve({ rows: agents, rowCount: agents.length });
      }
      // /regressions/check: insert detected regression events
      if (sql.includes("INSERT INTO public.regression_events")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      // /regressions/history: count query
      if (sql.includes("SELECT COUNT(*)")) {
        return Promise.resolve({ rows: [{ count: historyCount }], rowCount: 1 });
      }
      // /regressions/history: main events query
      if (sql.includes("SELECT id, agent_name, metric")) {
        return Promise.resolve({ rows: historyRows, rowCount: historyRows.length });
      }
      // Baseline traces query: has both start_time >= $2 AND start_time < $3
      if (sql.includes("start_time >= $2") && sql.includes("start_time < $3")) {
        return Promise.resolve({ rows: baselineRows, rowCount: baselineRows.length });
      }
      // Recent traces or snapshot query: has start_time >= $2 only
      if (sql.includes("start_time >= $2")) {
        const rows = snapshotRows.length > 0 ? snapshotRows : recentRows;
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  } as unknown as pg.Pool;
}

async function buildApp(pool: pg.Pool) {
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerRegressionRoutes(app, pool);
  await app.ready();
  return app;
}

const sampleTrace = {
  status: "success",
  duration_ms: 200,
  total_input_tokens: 100,
  total_output_tokens: 50,
  spans: [],
};

describe("GET /regressions/check", () => {
  it("returns regression check results for all agents", async () => {
    const pool = makeMockPool({
      agents: [{ agent_name: "my-agent" }],
      baselineRows: [sampleTrace, sampleTrace],
      recentRows: [sampleTrace],  // similar metrics → no regression
    });

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
    expect(body.agents[0]).toHaveProperty("hasRegression");
  });

  it("returns empty results when no agents found", async () => {
    const pool = makeMockPool({ agents: [] });
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

  it("detects regression when error rate significantly increases", async () => {
    const goodTrace = { ...sampleTrace, status: "success", spans: [] };
    const errorTrace = { status: "error", duration_ms: 500, total_input_tokens: 100, total_output_tokens: 50, spans: [] };

    const pool = makeMockPool({
      agents: [{ agent_name: "my-agent" }],
      // Baseline: 10 good traces → 0% error rate
      baselineRows: Array(10).fill(goodTrace),
      // Recent: 5 error traces → 100% error rate (regression!)
      recentRows: Array(5).fill(errorTrace),
    });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/regressions/check",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents[0].hasRegression).toBe(true);
    expect(body.agents[0].regressions.length).toBeGreaterThan(0);
    expect(body.regressionsFound).toBeGreaterThan(0);
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

    const pool = makeMockPool({
      historyRows: [event],
      historyCount: "1",
    });

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

  it("returns empty history when no events", async () => {
    const pool = makeMockPool({ historyRows: [], historyCount: "0" });
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/regressions/history",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(0);
    expect(res.json().total).toBe(0);
  });

  it("accepts agentName filter", async () => {
    const pool = makeMockPool({ historyRows: [], historyCount: "0" });
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/regressions/history?agentName=specific-agent",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 401 without auth", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "GET", url: "/regressions/history" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /regressions/baseline/:agentName", () => {
  it("returns baseline metrics for agent", async () => {
    const pool = makeMockPool({
      snapshotRows: [sampleTrace, sampleTrace],
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
    const pool = makeMockPool({ snapshotRows: [] });
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/regressions/baseline/no-such-agent",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "POST", url: "/regressions/baseline/my-agent" });
    expect(res.statusCode).toBe(401);
  });
});
