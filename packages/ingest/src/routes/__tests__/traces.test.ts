import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerTraceRoutes } from "../../routes/traces.js";
import type { ITraceStore, Trace, SourceSummary, TraceQueryFilter } from "@lantern-ai/sdk";

function makeValidTrace(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    agentName: "test-agent",
    environment: "dev",
    startTime: Date.now(),
    status: "success",
    spans: [],
    metadata: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
    ...overrides,
  };
}

function makeMockStore(): ITraceStore & { traces: Map<string, Trace> } {
  const traces = new Map<string, Trace>();
  return {
    traces,
    insert: vi.fn(async (newTraces: Trace[]) => {
      for (const t of newTraces) traces.set(t.id, t);
    }),
    getTrace: vi.fn(async (id: string) => traces.get(id) ?? null),
    queryTraces: vi.fn(async (_filter: TraceQueryFilter) => Array.from(traces.values())),
    getTraceCount: vi.fn(async () => traces.size),
    getSources: vi.fn(async (): Promise<SourceSummary[]> => []),
  };
}

describe("POST /v1/traces — validation", () => {
  let app: FastifyInstance;
  let store: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    store = makeMockStore();
    app = Fastify({ logger: false });
    registerTraceRoutes(app, store as unknown as ITraceStore);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("accepts a valid trace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace()] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBe(1);
    expect(store.insert).toHaveBeenCalledOnce();
  });

  it("accepts multiple valid traces", async () => {
    const traces = [makeValidTrace(), makeValidTrace(), makeValidTrace()];
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).accepted).toBe(3);
  });

  it("rejects empty traces array", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors).toBeDefined();
  });

  it("rejects when traces field is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects batch exceeding 100 traces", async () => {
    const traces = Array.from({ length: 101 }, () => makeValidTrace());
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0]).toMatch(/100/);
  });

  it("rejects trace with invalid UUID for id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace({ id: "not-a-uuid" })] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0]).toMatch(/UUID/i);
  });

  it("rejects trace with invalid UUID for sessionId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace({ sessionId: "bad-session" })] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0]).toMatch(/sessionId/i);
  });

  it("rejects trace with invalid status", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace({ status: "invalid_status" })] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0]).toMatch(/status/i);
  });

  it("accepts all valid statuses: success, error, running", async () => {
    for (const status of ["success", "error", "running"]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/traces",
        payload: { traces: [makeValidTrace({ status })] },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects trace with empty agentName", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace({ agentName: "" })] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0]).toMatch(/agentName/i);
  });

  it("rejects trace with agentName over 255 chars", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace({ agentName: "a".repeat(256) })] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts agentName of exactly 255 chars", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace({ agentName: "a".repeat(255) })] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects trace with non-numeric startTime", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace({ startTime: "not-a-number" })] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors[0]).toMatch(/startTime/i);
  });

  it("rejects trace with missing required fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [{ id: crypto.randomUUID() }] }, // missing most fields
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 when store.insert throws", async () => {
    (store.insert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB error"));
    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace()] },
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).errors[0]).toMatch(/internal server error/i);
  });
});

describe("GET /v1/traces/:id", () => {
  let app: FastifyInstance;
  let store: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    store = makeMockStore();
    app = Fastify({ logger: false });
    registerTraceRoutes(app, store as unknown as ITraceStore);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns trace by valid UUID", async () => {
    const trace = makeValidTrace() as unknown as Trace;
    store.traces.set(trace.id, trace);

    const res = await app.inject({
      method: "GET",
      url: `/v1/traces/${trace.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(trace.id);
  });

  it("returns 404 for unknown trace UUID", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/traces/${crypto.randomUUID()}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for non-UUID trace ID", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/traces/not-valid-uuid",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/invalid/i);
  });
});

describe("GET /v1/traces", () => {
  let app: FastifyInstance;
  let store: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    store = makeMockStore();
    app = Fastify({ logger: false });
    registerTraceRoutes(app, store as unknown as ITraceStore);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns list of traces", async () => {
    const trace = makeValidTrace() as unknown as Trace;
    store.traces.set(trace.id, trace);

    const res = await app.inject({ method: "GET", url: "/v1/traces" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.traces).toBeInstanceOf(Array);
  });

  it("returns 500 when store.queryTraces throws", async () => {
    (store.queryTraces as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB error"));
    const res = await app.inject({ method: "GET", url: "/v1/traces" });
    expect(res.statusCode).toBe(500);
  });
});
