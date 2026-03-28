import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ITraceStore, Scorer } from "@openlantern-ai/sdk";
import type { Trace } from "@openlantern-ai/sdk";
import { createEvalWorker } from "../worker.js";
import { makeTrace } from "./helpers.js";

function makeMockStore(trace: Trace | null): ITraceStore {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    getTrace: vi.fn().mockResolvedValue(trace),
    queryTraces: vi.fn().mockResolvedValue([]),
    getTraceCount: vi.fn().mockResolvedValue(0),
    getSources: vi.fn().mockResolvedValue([]),
  };
}

function makeMockScorer(name: string, score: number): Scorer {
  return {
    name,
    score: vi.fn().mockResolvedValue({ scorer: name, score, label: "mock" }),
  };
}

describe("createEvalWorker", () => {
  describe("GET /health", () => {
    it("returns { status: 'ok' }", async () => {
      const store = makeMockStore(null);
      const app = await createEvalWorker({ store, scorers: [] });

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    });
  });

  describe("POST /evaluate", () => {
    it("returns 200 with scores on success", async () => {
      const trace = makeTrace({ id: "t1", agentName: "test-agent" });
      const store = makeMockStore(trace);
      const scorer = makeMockScorer("relevance", 0.9);
      const app = await createEvalWorker({ store, scorers: [scorer] });

      const response = await app.inject({
        method: "POST",
        url: "/evaluate",
        payload: { traceId: "t1", agentName: "test-agent" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.traceId).toBe("t1");
      expect(body.scores).toHaveLength(1);
      expect(body.scores[0].scorer).toBe("relevance");
      expect(body.scores[0].score).toBe(0.9);
    });

    it("returns 404 when trace not found", async () => {
      const store = makeMockStore(null);
      const app = await createEvalWorker({ store, scorers: [] });

      const response = await app.inject({
        method: "POST",
        url: "/evaluate",
        payload: { traceId: "missing-id", agentName: "test-agent" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Trace not found" });
    });

    it("updates trace scores in store (verifies store.insert called with scores)", async () => {
      const trace = makeTrace({ id: "t1", agentName: "test-agent" });
      const store = makeMockStore(trace);
      const scorer = makeMockScorer("quality", 0.75);
      const app = await createEvalWorker({ store, scorers: [scorer] });

      await app.inject({
        method: "POST",
        url: "/evaluate",
        payload: { traceId: "t1", agentName: "test-agent" },
      });

      expect(store.insert).toHaveBeenCalledTimes(1);
      const insertedTraces = (store.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as Trace[];
      expect(insertedTraces).toHaveLength(1);
      expect(insertedTraces[0].scores).toHaveLength(1);
      expect(insertedTraces[0].scores![0].scorer).toBe("quality");
      expect(insertedTraces[0].scores![0].score).toBe(0.75);
    });

    it("handles scorer failure gracefully — adds error score and continues", async () => {
      const trace = makeTrace({ id: "t1", agentName: "test-agent" });
      const store = makeMockStore(trace);
      const failingScorer: Scorer = {
        name: "broken",
        score: vi.fn().mockRejectedValue(new Error("Scorer exploded")),
      };
      const passingScorer = makeMockScorer("passing", 0.8);
      const app = await createEvalWorker({ store, scorers: [failingScorer, passingScorer] });

      const response = await app.inject({
        method: "POST",
        url: "/evaluate",
        payload: { traceId: "t1", agentName: "test-agent" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.scores).toHaveLength(2);

      const errorScore = body.scores.find((s: { scorer: string }) => s.scorer === "broken");
      expect(errorScore).toBeDefined();
      expect(errorScore.label).toBe("error");
      expect(errorScore.reasoning).toContain("Scorer failed: Scorer exploded");

      const passScore = body.scores.find((s: { scorer: string }) => s.scorer === "passing");
      expect(passScore).toBeDefined();
      expect(passScore.score).toBe(0.8);
    });

    it("passes tenantSchema in the body without error", async () => {
      const trace = makeTrace({ id: "t1", agentName: "test-agent" });
      const store = makeMockStore(trace);
      const app = await createEvalWorker({ store, scorers: [] });

      const response = await app.inject({
        method: "POST",
        url: "/evaluate",
        payload: { traceId: "t1", agentName: "test-agent", tenantSchema: "tenant_abc" },
      });

      expect(response.statusCode).toBe(200);
    });

    it("fetches the trace from store using the provided traceId", async () => {
      const trace = makeTrace({ id: "t1" });
      const store = makeMockStore(trace);
      const app = await createEvalWorker({ store, scorers: [] });

      await app.inject({
        method: "POST",
        url: "/evaluate",
        payload: { traceId: "t1", agentName: "test-agent" },
      });

      expect(store.getTrace).toHaveBeenCalledWith("t1");
    });
  });
});
