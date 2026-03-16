import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerTeamRoutes } from "../teams.js";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";
import type pg from "pg";

const JWT_SECRET = "test-jwt-secret-32chars-for-hs256";
const OWNER = { sub: "u1", tenantId: "t1", tenantSlug: "acme", role: "owner" };
const MEMBER = { ...OWNER, role: "member" };

function makeToken(payload = OWNER) {
  return signJwt(payload, JWT_SECRET);
}

function authHeaders(payload = OWNER) {
  return { authorization: `Bearer ${makeToken(payload)}` };
}

/** Pool mock whose query() returns empty rows by default; override with mockImplementation */
function makeMockPool(implementation?: (sql: string, params?: unknown[]) => unknown): pg.Pool {
  const defaultImpl = (_sql: string) => ({ rows: [], rowCount: 0 });
  return {
    query: vi.fn().mockImplementation(implementation ?? defaultImpl),
  } as unknown as pg.Pool;
}

async function buildApp(pool: pg.Pool) {
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerTeamRoutes(app, pool);
  await app.ready();
  return app;
}

describe("POST /teams", () => {
  it("creates a team and adds creator as member (201)", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;

    // Call sequence: get creator email, CREATE TABLE teams, CREATE TABLE team_members, INSERT team, INSERT member
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: "owner@acme.com" }], rowCount: 1 })  // get creator email
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // CREATE TABLE teams
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // CREATE TABLE team_members
      .mockResolvedValueOnce({ rows: [{ id: "team-1", name: "Engineering", created_at: new Date() }], rowCount: 1 })  // INSERT team
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });  // INSERT member

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/teams",
      headers: authHeaders(),
      payload: { name: "Engineering", members: [] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("Engineering");
    expect(body.members).toContain("owner@acme.com");
    expect(body.agentScope).toEqual([]);
  });

  it("returns 400 when name is missing", async () => {
    const pool = makeMockPool();
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/teams",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name/i);
  });

  it("returns 400 when name is over 100 characters", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ email: "owner@acme.com" }], rowCount: 1 });
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/teams",
      headers: authHeaders(),
      payload: { name: "x".repeat(101), members: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/100/);
  });

  it("returns 403 for member role (insufficient permissions)", async () => {
    const pool = makeMockPool();
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/teams",
      headers: authHeaders(MEMBER),
      payload: { name: "Engineering", members: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 when no auth header", async () => {
    const pool = makeMockPool();
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/teams",
      payload: { name: "Engineering" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /teams", () => {
  it("returns list of teams for tenant", async () => {
    const teamRow = { id: "team-1", name: "Engineering", created_at: new Date() };
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;

    // ensureTables: 3 CREATE TABLE queries, then SELECT teams
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // CREATE TABLE teams
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // CREATE TABLE team_members
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // CREATE TABLE team_scopes
      .mockResolvedValueOnce({ rows: [teamRow], rowCount: 1 });  // SELECT

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/teams",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().teams).toHaveLength(1);
    expect(res.json().teams[0].name).toBe("Engineering");
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "GET", url: "/teams" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /teams/my", () => {
  it("returns teams the user belongs to", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: "owner@acme.com" }], rowCount: 1 })  // get user email
      .mockResolvedValueOnce({
        rows: [{ id: "team-1", name: "Engineering", created_at: new Date(), member_count: 3 }],
        rowCount: 1,
      });  // member teams

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/teams/my",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0].memberCount).toBe(3);
  });

  it("returns 404 when user not found", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/teams/my",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /teams/:id", () => {
  it("returns team details with members and scope", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "team-1", name: "Eng", created_at: new Date() }], rowCount: 1 })  // get team
      .mockResolvedValueOnce({ rows: [{ user_email: "alice@acme.com" }], rowCount: 1 })  // members
      .mockResolvedValueOnce({ rows: [{ agent_name: "deploy-bot" }], rowCount: 1 });  // scopes

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/teams/team-1",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toContain("alice@acme.com");
    expect(body.agentScope).toContain("deploy-bot");
  });

  it("returns 404 when team not found", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/teams/nonexistent",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /teams/:id/scope", () => {
  it("updates team agent scope", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // CREATE TABLE team_scopes
      .mockResolvedValueOnce({ rows: [{ id: "team-1" }], rowCount: 1 })  // verify team exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // DELETE existing scopes
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });  // INSERT scope

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "PUT",
      url: "/teams/team-1/scope",
      headers: authHeaders(),
      payload: { agentNames: ["deploy-bot"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(true);
  });

  it("returns 400 when agentNames is missing", async () => {
    const pool = makeMockPool();
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "PUT",
      url: "/teams/team-1/scope",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for member role", async () => {
    const pool = makeMockPool();
    const app = await buildApp(pool);
    const res = await app.inject({
      method: "PUT",
      url: "/teams/team-1/scope",
      headers: authHeaders(MEMBER),
      payload: { agentNames: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});
