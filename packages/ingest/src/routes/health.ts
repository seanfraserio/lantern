import type { FastifyInstance } from "fastify";
import type { ITraceStore } from "@lantern-ai/sdk";

export function registerHealthRoutes(app: FastifyInstance, store: ITraceStore): void {
  app.get("/health", async (_request, reply) => {
    try {
      const count = await store.getTraceCount();
      return reply.status(200).send({
        status: "ok",
        traceCount: count,
        uptime: process.uptime(),
      });
    } catch {
      return reply.status(503).send({
        status: "unhealthy",
      });
    }
  });
}
