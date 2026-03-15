import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getUser } from "../middleware/jwt.js";

export function registerTeamRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // POST /teams — create a team
  app.post<{ Body: { name: string; members: string[] } }>("/teams", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "owner" && user.role !== "admin") {
      return reply.status(403).send({ error: "Only owners and admins can create teams" });
    }

    const { name, members } = request.body;
    if (!name) return reply.status(400).send({ error: "name is required" });

    try {
      const { TeamManager } = await (Function('return import("@lantern-ai/enterprise")')() as Promise<Record<string, any>>);
      const mgr = new TeamManager(pool);
      await mgr.initialize();
      const team = await mgr.createTeam(name, members ?? [], user.tenantId);
      return reply.status(201).send(team);
    } catch {
      return reply.status(501).send({ error: "Team management not available" });
    }
  });

  // PUT /teams/:id/scope — set agent scope for a team
  app.put<{ Params: { id: string }; Body: { agentNames: string[] } }>("/teams/:id/scope", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "owner" && user.role !== "admin") {
      return reply.status(403).send({ error: "Only owners and admins can set team scope" });
    }

    const { agentNames } = request.body;
    if (!agentNames || !Array.isArray(agentNames)) {
      return reply.status(400).send({ error: "agentNames array is required" });
    }

    try {
      const { TeamManager } = await (Function('return import("@lantern-ai/enterprise")')() as Promise<Record<string, any>>);
      const mgr = new TeamManager(pool);
      await mgr.setScope(request.params.id, agentNames);
      return reply.send({ updated: true });
    } catch {
      return reply.status(501).send({ error: "Team management not available" });
    }
  });

  // Ensure tables exist on first use
  let tablesInitialized = false;
  async function ensureTables(): Promise<void> {
    if (tablesInitialized) return;
    try {
      const { TeamManager } = await (Function('return import("@lantern-ai/enterprise")')() as Promise<Record<string, any>>);
      const mgr = new TeamManager(pool);
      await mgr.initialize();
      tablesInitialized = true;
    } catch {
      // Tables may already exist or enterprise package not available
      tablesInitialized = true;
    }
  }

  // GET /teams — list teams for tenant
  app.get("/teams", async (request, reply) => {
    const user = getUser(request);
    await ensureTables();

    const { rows } = await pool.query(
      "SELECT id, name, created_at FROM public.teams WHERE tenant_id = $1 ORDER BY created_at DESC",
      [user.tenantId]
    );

    return reply.send({ teams: rows });
  });

  // GET /teams/:id — get team details with members and scope
  app.get<{ Params: { id: string } }>("/teams/:id", async (request, reply) => {
    const user = getUser(request);

    const { rows: teamRows } = await pool.query(
      "SELECT id, name, created_at FROM public.teams WHERE id = $1 AND tenant_id = $2",
      [request.params.id, user.tenantId]
    );
    if (teamRows.length === 0) return reply.status(404).send({ error: "Team not found" });

    const { rows: members } = await pool.query(
      "SELECT user_email FROM public.team_members WHERE team_id = $1",
      [request.params.id]
    );

    const { rows: scopes } = await pool.query(
      "SELECT agent_name FROM public.team_scopes WHERE team_id = $1",
      [request.params.id]
    );

    return reply.send({
      ...teamRows[0],
      members: members.map((m) => m.user_email),
      agentScope: scopes.map((s) => s.agent_name),
    });
  });
}
