import type { FastifyInstance } from "fastify";
import type { ITraceStore, TraceIngestRequest, TraceIngestResponse, TraceQueryFilter } from "@lantern-ai/sdk";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerTraceRoutes(app: FastifyInstance, store: ITraceStore): void {
  // POST /v1/traces — ingest traces
  app.post<{ Body: TraceIngestRequest }>("/v1/traces", async (request, reply) => {
    const { traces } = request.body;

    if (!traces || !Array.isArray(traces) || traces.length === 0) {
      return reply.status(400).send({
        accepted: 0,
        errors: ["Request body must contain a non-empty 'traces' array"],
      } satisfies TraceIngestResponse);
    }

    try {
      await store.insert(traces);
      return reply.status(200).send({
        accepted: traces.length,
      } satisfies TraceIngestResponse);
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({
        accepted: 0,
        errors: ["Internal server error"],
      } satisfies TraceIngestResponse);
    }
  });

  // GET /v1/traces — query traces
  app.get<{ Querystring: TraceQueryFilter }>("/v1/traces", async (request, reply) => {
    try {
      const traces = await store.queryTraces(request.query);
      return reply.status(200).send({ traces });
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /v1/sources — list connected data sources
  app.get("/v1/sources", async (request, reply) => {
    try {
      const sources = await store.getSources();
      return reply.status(200).send({ sources });
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /v1/traces/:id — get single trace
  app.get<{ Params: { id: string } }>("/v1/traces/:id", async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: "Invalid trace ID format" });
    }
    try {
      const trace = await store.getTrace(request.params.id);
      if (!trace) {
        return reply.status(404).send({ error: "Trace not found" });
      }
      return reply.status(200).send(trace);
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
