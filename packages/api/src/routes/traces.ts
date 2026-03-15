import type { FastifyInstance } from "fastify";
import type { TraceQueryFilter } from "@lantern-ai/sdk";
import { PostgresTraceStore } from "@lantern-ai/ingest";
import { getUser } from "../middleware/jwt.js";

const storeCache = new Map<string, PostgresTraceStore>();

function getOrCreateStore(databaseUrl: string, tenantSlug: string): PostgresTraceStore {
  const schema = `tenant_${tenantSlug}`;
  let store = storeCache.get(schema);
  if (!store) {
    store = new PostgresTraceStore({
      connectionString: databaseUrl,
      tenantSchema: schema,
      poolSize: 2,
    });
    storeCache.set(schema, store);
  }
  return store;
}

export function registerTraceRoutes(app: FastifyInstance, databaseUrl: string): void {
  app.get<{ Querystring: TraceQueryFilter }>("/traces", async (request, reply) => {
    const user = getUser(request);
    const store = getOrCreateStore(databaseUrl, user.tenantSlug);
    try {
      const traces = await store.queryTraces(request.query);
      return { traces };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  app.get<{ Params: { id: string } }>("/traces/:id", async (request, reply) => {
    const user = getUser(request);
    const store = getOrCreateStore(databaseUrl, user.tenantSlug);
    try {
      const trace = await store.getTrace(request.params.id);
      if (!trace) return reply.status(404).send({ error: "Trace not found" });
      return trace;
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  app.get("/sources", async (request, reply) => {
    const user = getUser(request);
    const store = getOrCreateStore(databaseUrl, user.tenantSlug);
    try {
      return { sources: await store.getSources() };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
