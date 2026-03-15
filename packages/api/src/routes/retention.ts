import type { FastifyInstance } from "fastify";
import type pg from "pg";

/**
 * Retention policies by plan. Traces older than the retention period are deleted.
 */
const RETENTION_DAYS: Record<string, number> = {
  free: 7,
  team: 90,
  enterprise: 365,
};

/**
 * Register trace retention routes.
 * POST /retention/cleanup — runs the retention job (called by Cloud Scheduler or cron).
 * Protected by a shared secret, not JWT.
 */
export function registerRetentionRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post("/retention/cleanup", async (request, reply) => {
    // Auth via shared secret (not JWT — this is called by a scheduler)
    const secret = process.env.RETENTION_SECRET;
    if (!secret) {
      request.log.error("RETENTION_SECRET is not configured — refusing cleanup request");
      return reply.status(503).send({ error: "Retention cleanup is not configured" });
    }
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const { timingSafeEqual } = await import("node:crypto");
    const expected = Buffer.from(secret);
    const provided = Buffer.from(auth.slice(7));
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const results: Array<{ tenant: string; plan: string; deleted: number }> = [];

    try {
      // Get all tenants and their plans
      const { rows: tenants } = await pool.query(
        "SELECT id, slug, plan FROM public.tenants"
      );

      for (const tenant of tenants) {
        const slug = tenant.slug as string;
        const plan = (tenant.plan as string) ?? "free";
        const retentionDays = RETENTION_DAYS[plan] ?? RETENTION_DAYS.free;
        const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

        const schema = `tenant_${slug}`;

        try {
          // Check if schema exists
          const { rows: schemaCheck } = await pool.query(
            "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
            [schema]
          );
          if (schemaCheck.length === 0) continue;

          // Delete traces older than retention period
          const { rowCount } = await pool.query(
            `DELETE FROM "${schema}".traces WHERE start_time < $1`,
            [cutoffMs]
          );

          const deleted = rowCount ?? 0;
          if (deleted > 0) {
            results.push({ tenant: slug, plan, deleted });
          }
        } catch (err) {
          request.log.error({ tenant: slug, error: err }, "Retention cleanup failed for tenant");
        }
      }

      return reply.send({
        cleaned: results.length,
        details: results,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Retention cleanup failed" });
    }
  });

  // GET /retention/policy — show retention policies
  app.get("/retention/policy", async (_request, reply) => {
    return reply.send({
      policies: Object.entries(RETENTION_DAYS).map(([plan, days]) => ({
        plan,
        retentionDays: days,
      })),
    });
  });
}
