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

    // Get creator's email to add them as a member
    const { rows: userRows } = await pool.query("SELECT email FROM public.users WHERE id = $1", [user.sub]);
    const creatorEmail = userRows[0]?.email as string;
    const memberList = members ?? [];
    if (creatorEmail && !memberList.includes(creatorEmail)) {
      memberList.push(creatorEmail);
    }

    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS public.teams (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS public.team_members (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), team_id UUID NOT NULL REFERENCES public.teams(id), user_email TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(team_id, user_email))`);

      const { rows } = await pool.query(
        `INSERT INTO public.teams (tenant_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
        [user.tenantId, name]
      );
      const team = rows[0];

      for (const email of memberList) {
        await pool.query(
          `INSERT INTO public.team_members (team_id, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [team.id, email]
        );
      }

      return reply.status(201).send({
        id: team.id,
        name: team.name,
        members: memberList,
        agentScope: [],
      });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: "Failed to create team" });
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
      await pool.query(`CREATE TABLE IF NOT EXISTS public.team_scopes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), team_id UUID NOT NULL REFERENCES public.teams(id), agent_name TEXT NOT NULL, UNIQUE(team_id, agent_name))`);
      const { rows: teamRows } = await pool.query("SELECT id FROM public.teams WHERE id = $1 AND tenant_id = $2", [request.params.id, user.tenantId]);
      if (teamRows.length === 0) return reply.status(404).send({ error: "Team not found" });
      await pool.query("DELETE FROM public.team_scopes WHERE team_id = $1", [request.params.id]);
      for (const agentName of agentNames) {
        await pool.query(`INSERT INTO public.team_scopes (team_id, agent_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [request.params.id, agentName]);
      }
      return reply.send({ updated: true });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: "Failed to update team scope" });
    }
  });

  // Ensure tables exist on first use
  let tablesInitialized = false;
  async function ensureTables(): Promise<void> {
    if (tablesInitialized) return;
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS public.teams (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS public.team_members (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), team_id UUID NOT NULL REFERENCES public.teams(id), user_email TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(team_id, user_email))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS public.team_scopes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), team_id UUID NOT NULL REFERENCES public.teams(id), agent_name TEXT NOT NULL, UNIQUE(team_id, agent_name))`);
      tablesInitialized = true;
    } catch {
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
