import type { FastifyInstance } from "fastify";
import type { ITraceStore } from "@lantern-ai/sdk";

export function registerHealthRoutes(app: FastifyInstance, store: ITraceStore): void {
  app.get("/health", async (_request, reply) => {
    try {
      const traceCount = await store.getTraceCount();
      return reply.status(200).send({
        status: "ok",
        traceCount,
      });
    } catch {
      return reply.status(503).send({
        status: "unhealthy",
      });
    }
  });
}
