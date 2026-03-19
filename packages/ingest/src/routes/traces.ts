import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ITraceStore, TraceIngestRequest, TraceIngestResponse, TraceQueryFilter } from "@lantern-ai/sdk";
import { recordMetric } from "../lib/observability.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRACES_PER_REQUEST = 100;
const VALID_STATUSES = new Set(["success", "error", "running"]);

interface TraceInput {
  id?: unknown;
  sessionId?: unknown;
  agentName?: unknown;
  environment?: unknown;
  status?: unknown;
  startTime?: unknown;
  [key: string]: unknown;
}

function validateTrace(trace: TraceInput, index: number): string | null {
  if (!trace || typeof trace !== "object") return `traces[${index}]: must be an object`;
  if (typeof trace.id !== "string" || !UUID_RE.test(trace.id)) return `traces[${index}].id: must be a valid UUID`;
  if (typeof trace.sessionId !== "string" || !UUID_RE.test(trace.sessionId)) return `traces[${index}].sessionId: must be a valid UUID`;
  if (typeof trace.agentName !== "string" || trace.agentName.length === 0 || trace.agentName.length > 255) return `traces[${index}].agentName: must be 1-255 chars`;
  if (typeof trace.environment !== "string" || trace.environment.length === 0 || trace.environment.length > 64) return `traces[${index}].environment: must be 1-64 chars`;
  if (typeof trace.status !== "string" || !VALID_STATUSES.has(trace.status)) return `traces[${index}].status: must be success, error, or running`;
  if (typeof trace.startTime !== "number" || !Number.isFinite(trace.startTime)) return `traces[${index}].startTime: must be a number`;
  return null;
}

/**
 * Get the store for this request.
 * In multi-tenant mode, the tenant middleware attaches a per-tenant store.
 * In single-tenant mode, fall back to the default store.
 */
function getStore(request: FastifyRequest, defaultStore: ITraceStore): ITraceStore {
  return ((request as unknown as Record<string, unknown>).tenantStore as ITraceStore) ?? defaultStore;
}

export function registerTraceRoutes(app: FastifyInstance, defaultStore: ITraceStore, multiTenant?: boolean): void {
  // POST /v1/traces — ingest traces
  app.post<{ Body: TraceIngestRequest }>("/v1/traces", async (request, reply) => {
    const { traces } = request.body;

    if (!traces || !Array.isArray(traces) || traces.length === 0) {
      return reply.status(400).send({
        accepted: 0,
        errors: ["Request body must contain a non-empty 'traces' array"],
      } satisfies TraceIngestResponse);
    }

    if (traces.length > MAX_TRACES_PER_REQUEST) {
      return reply.status(400).send({
        accepted: 0,
        errors: [`Maximum ${MAX_TRACES_PER_REQUEST} traces per request`],
      } satisfies TraceIngestResponse);
    }

    const errors: string[] = [];
    for (let i = 0; i < traces.length; i++) {
      const err = validateTrace(traces[i] as unknown as TraceInput, i);
      if (err) errors.push(err);
    }
    if (errors.length > 0) {
      return reply.status(400).send({ accepted: 0, errors } satisfies TraceIngestResponse);
    }

    try {
      const store = getStore(request, defaultStore);
      await store.insert(traces);

      // Business metrics: trace ingestion volume
      const tenantSlug = (request as unknown as Record<string, unknown>).tenantSlug as string | undefined;
      recordMetric("traces_ingested_total", traces.length, { tenant: tenantSlug ?? "single" });

      // Sum tokens across all traces if available
      let totalTokens = 0;
      for (const trace of traces) {
        const t = trace as unknown as Record<string, unknown>;
        if (typeof t.totalInputTokens === "number") totalTokens += t.totalInputTokens as number;
        if (typeof t.totalOutputTokens === "number") totalTokens += t.totalOutputTokens as number;
      }
      if (totalTokens > 0) {
        recordMetric("traces_ingested_tokens", totalTokens, { tenant: tenantSlug ?? "single" });
      }

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
      const store = getStore(request, defaultStore);
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
      const store = getStore(request, defaultStore);
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
      const store = getStore(request, defaultStore);
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
