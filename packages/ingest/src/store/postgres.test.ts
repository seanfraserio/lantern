import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgresTraceStore } from "./postgres.js";
import type { Trace } from "@lantern-ai/sdk";

// These tests require a running Postgres instance.
// Skip in CI unless POSTGRES_URL is set.
const POSTGRES_URL = process.env.POSTGRES_URL;
const describeIf = POSTGRES_URL ? describe : describe.skip;

function makeFakeTrace(overrides?: Partial<Trace>): Trace {
  const id = crypto.randomUUID();
  return {
    id,
    sessionId: crypto.randomUUID(),
    agentName: "test-agent",
    environment: "test",
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    durationMs: 1000,
    status: "success",
    spans: [],
    metadata: { test: true },
    source: { serviceName: "test-svc", sdkVersion: "0.1.0", exporterType: "lantern" },
    totalInputTokens: 100,
    totalOutputTokens: 50,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

describeIf("PostgresTraceStore", () => {
  let store: PostgresTraceStore;
  const testSchema = "tenant_test_" + Date.now().toString(36);

  beforeAll(async () => {
    store = new PostgresTraceStore({
      connectionString: POSTGRES_URL!,
      tenantSchema: testSchema,
    });
    await store.initialize();
  });

  afterAll(async () => {
    await store.dropSchema();
    await store.close();
  });

  it("should insert and retrieve a trace", async () => {
    const trace = makeFakeTrace();
    await store.insert([trace]);
    const result = await store.getTrace(trace.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(trace.id);
    expect(result!.agentName).toBe("test-agent");
    expect(result!.source?.serviceName).toBe("test-svc");
  });

  it("should query traces with filters", async () => {
    const trace1 = makeFakeTrace({ agentName: "agent-a", environment: "prod" });
    const trace2 = makeFakeTrace({ agentName: "agent-b", environment: "dev" });
    await store.insert([trace1, trace2]);

    const prodTraces = await store.queryTraces({ environment: "prod" });
    expect(prodTraces.some((t) => t.id === trace1.id)).toBe(true);
    expect(prodTraces.some((t) => t.id === trace2.id)).toBe(false);
  });

  it("should return trace count", async () => {
    const count = await store.getTraceCount();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("should return sources grouped by service", async () => {
    const sources = await store.getSources();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0].serviceName).toBe("test-svc");
    expect(sources[0].traceCount).toBeGreaterThanOrEqual(1);
  });

  it("should ignore duplicate trace IDs", async () => {
    const trace = makeFakeTrace();
    await store.insert([trace]);
    const countBefore = await store.getTraceCount();
    await store.insert([trace]);
    const countAfter = await store.getTraceCount();
    expect(countAfter).toBe(countBefore);
  });

  it("should filter by serviceName", async () => {
    const trace = makeFakeTrace({
      source: { serviceName: "unique-svc", exporterType: "lantern" },
    });
    await store.insert([trace]);
    const results = await store.queryTraces({ serviceName: "unique-svc" });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(trace.id);
  });

  it("should cap limit at 1000", async () => {
    const results = await store.queryTraces({ limit: 99999 });
    expect(results).toBeDefined();
  });
});
