import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerHealthRoutes } from "../health.js";
import type pg from "pg";

function makeMockPool(healthy = true): pg.Pool {
  return {
    query: vi.fn().mockImplementation(() =>
      healthy ? Promise.resolve({ rows: [{ "?column?": 1 }] }) : Promise.reject(new Error("DB down"))
    ),
  } as unknown as pg.Pool;
}

describe("GET /health", () => {
  it("returns 200 with status ok when DB is reachable", async () => {
    const app = Fastify({ logger: false });
    registerHealthRoutes(app, makeMockPool(true));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("uptime");
  });

  it("returns 503 when DB query fails", async () => {
    const app = Fastify({ logger: false });
    registerHealthRoutes(app, makeMockPool(false));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("unhealthy");
  });

  it("does not require auth header", async () => {
    // health is a public endpoint — no JWT needed
    const app = Fastify({ logger: false });
    const { registerJwtAuth } = await import("../../middleware/jwt.js");
    registerJwtAuth(app, "secret");
    registerHealthRoutes(app, makeMockPool(true));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});
