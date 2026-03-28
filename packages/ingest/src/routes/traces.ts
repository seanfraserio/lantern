import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ITraceStore, TraceIngestRequest, TraceIngestResponse, TraceQueryFilter } from "@openlantern-ai/sdk";
import type { EvalTrigger } from "../triggers/eval-trigger.js";
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

export function registerTraceRoutes(app: FastifyInstance, defaultStore: ITraceStore, _multiTenant?: boolean, evalTrigger?: EvalTrigger): void {
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

    // Record metrics synchronously
    const tenantSlug = (request as unknown as Record<string, unknown>).tenantSlug as string | undefined;
    recordMetric("traces_ingested_total", traces.length, { tenant: tenantSlug ?? "single" });

    let totalTokens = 0;
    for (const trace of traces) {
      const t = trace as unknown as Record<string, unknown>;
      if (typeof t.totalInputTokens === "number") totalTokens += t.totalInputTokens as number;
      if (typeof t.totalOutputTokens === "number") totalTokens += t.totalOutputTokens as number;
    }
    if (totalTokens > 0) {
      recordMetric("traces_ingested_tokens", totalTokens, { tenant: tenantSlug ?? "single" });
    }

    // Write to DB asynchronously — respond immediately with 202
    const store = getStore(request, defaultStore);
    store.insert(traces).catch((error) => {
      request.log.error(error, "Background trace insert failed");
      recordMetric("traces_insert_errors", 1, { tenant: tenantSlug ?? "single" });
    });

    // Enqueue evaluation jobs for successful traces
    if (evalTrigger) {
      const jobs = traces
        .filter((t) => t.status === "success")
        .map((t) => ({ traceId: t.id, agentName: t.agentName }));
      if (jobs.length > 0) {
        evalTrigger.enqueue(jobs).catch((err) =>
          request.log.error(err, "Failed to enqueue eval jobs")
        );
      }
    }

    return reply.status(202).send({
      accepted: traces.length,
    } satisfies TraceIngestResponse);
  });

  // POST /v1/pubsub — Pub/Sub push endpoint
  // Pub/Sub delivers messages as HTTP POST with envelope: { message: { data: base64, ... }, subscription: ... }
  // No auth required — Pub/Sub push uses OIDC token verification at the Cloud Run level
  app.post<{ Body: { message?: { data?: string; attributes?: Record<string, string>; messageId?: string }; subscription?: string } }>("/v1/pubsub", async (request, reply) => {
    const envelope = request.body;
    if (!envelope?.message?.data) {
      return reply.status(400).send({ error: "Invalid Pub/Sub message envelope" });
    }

    let traces;
    try {
      const decoded = Buffer.from(envelope.message.data, "base64").toString();
      const payload = JSON.parse(decoded);
      traces = payload.traces;
    } catch {
      request.log.error("Failed to decode Pub/Sub message");
      return reply.status(400).send({ error: "Invalid message data" });
    }

    if (!Array.isArray(traces) || traces.length === 0) {
      return reply.status(200).send({ accepted: 0 });
    }

    // Validate traces
    const errors: string[] = [];
    for (let i = 0; i < traces.length; i++) {
      const err = validateTrace(traces[i] as unknown as TraceInput, i);
      if (err) errors.push(err);
    }
    if (errors.length > 0) {
      request.log.error({ errors }, "Pub/Sub traces failed validation");
      return reply.status(200).send({ accepted: 0, errors });
    }

    // Record metrics
    recordMetric("traces_ingested_total", traces.length, { source: "pubsub" });

    // Insert — for push, we AWAIT the insert and return 200 only on success
    // Returning non-2xx causes Pub/Sub to retry
    const store = getStore(request, defaultStore);
    try {
      await store.insert(traces);
    } catch (error) {
      request.log.error(error, "Pub/Sub trace insert failed — will be retried");
      recordMetric("traces_insert_errors", 1, { source: "pubsub" });
      return reply.status(500).send({ error: "Insert failed" });
    }

    // Enqueue evaluation jobs
    if (evalTrigger) {
      const jobs = traces
        .filter((t: any) => t.status === "success")
        .map((t: any) => ({ traceId: t.id, agentName: t.agentName }));
      if (jobs.length > 0) {
        evalTrigger.enqueue(jobs).catch((err: unknown) =>
          request.log.error(err, "Failed to enqueue eval jobs from Pub/Sub")
        );
      }
    }

    return reply.status(200).send({ accepted: traces.length });
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
