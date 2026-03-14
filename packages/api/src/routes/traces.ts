import type { FastifyInstance } from "fastify";
import type { TraceQueryFilter } from "@lantern-ai/sdk";
import { PostgresTraceStore } from "@lantern-ai/ingest";
import { getUser } from "../middleware/jwt.js";

export function registerTraceRoutes(app: FastifyInstance, databaseUrl: string): void {
  app.get<{ Querystring: TraceQueryFilter }>("/traces", async (request, reply) => {
    const user = getUser(request);
    const store = new PostgresTraceStore({
      connectionString: databaseUrl,
      tenantSchema: `tenant_${user.tenantSlug}`,
      poolSize: 2,
    });
    try {
      const traces = await store.queryTraces(request.query);
      return { traces };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    } finally {
      await store.close();
    }
  });

  app.get<{ Params: { id: string } }>("/traces/:id", async (request, reply) => {
    const user = getUser(request);
    const store = new PostgresTraceStore({
      connectionString: databaseUrl,
      tenantSchema: `tenant_${user.tenantSlug}`,
      poolSize: 2,
    });
    try {
      const trace = await store.getTrace(request.params.id);
      if (!trace) return reply.status(404).send({ error: "Trace not found" });
      return trace;
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    } finally {
      await store.close();
    }
  });

  app.get("/sources", async (request, reply) => {
    const user = getUser(request);
    const store = new PostgresTraceStore({
      connectionString: databaseUrl,
      tenantSchema: `tenant_${user.tenantSlug}`,
      poolSize: 2,
    });
    try {
      return { sources: await store.getSources() };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    } finally {
      await store.close();
    }
  });
}
