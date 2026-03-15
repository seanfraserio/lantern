import type { FastifyInstance } from "fastify";
import type pg from "pg";

export function registerHealthRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return reply.send({ status: "ok", uptime: process.uptime() });
    } catch {
      return reply.status(503).send({ status: "unhealthy" });
    }
  });
}
