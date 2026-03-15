import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getUser } from "../middleware/jwt.js";

export function registerComplianceRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // POST /compliance/export — generate compliance report
  app.post<{ Body: { framework: string; startDate: string; endDate: string } }>(
    "/compliance/export",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "owner" && user.role !== "admin") {
        return reply.status(403).send({ error: "Only owners and admins can export compliance reports" });
      }

      const { framework, startDate, endDate } = request.body;
      if (!framework || !startDate || !endDate) {
        return reply.status(400).send({ error: "framework, startDate, and endDate are required" });
      }

      try {
        const mod = await (Function('return import("@lantern-ai/enterprise")')() as Promise<Record<string, unknown>>);
        const ComplianceExporter = mod.ComplianceExporter as new (pool: pg.Pool) => { export: (fw: string, s: string, e: string) => Promise<unknown> };
        const exporter = new ComplianceExporter(pool);
        const report = await exporter.export(
          framework as "soc2" | "hipaa" | "gdpr",
          startDate,
          endDate
        );
        return reply.send(report);
      } catch (err) {
        if ((err as Error).message?.includes("not available")) {
          return reply.status(501).send({ error: "Compliance export not available" });
        }
        request.log.error(err);
        return reply.status(500).send({ error: "Export failed" });
      }
    }
  );

  // GET /compliance/frameworks — list available frameworks
  app.get("/compliance/frameworks", async (_request, reply) => {
    return reply.send({
      frameworks: [
        { id: "soc2", name: "SOC 2 Type II", description: "Access control and change management audit" },
        { id: "hipaa", name: "HIPAA", description: "Healthcare data access and processing audit" },
        { id: "gdpr", name: "GDPR", description: "Data processing and inventory audit" },
      ],
    });
  });
}
