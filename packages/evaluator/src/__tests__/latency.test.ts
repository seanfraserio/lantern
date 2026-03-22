import { describe, it, expect } from "vitest";
import { LatencyScorer } from "../scorers/latency.js";
import { makeTrace } from "./helpers.js";

describe("LatencyScorer", () => {
  describe("with default thresholds (fast=1000ms, slow=10000ms)", () => {
    const scorer = new LatencyScorer();

    it("has the name 'latency'", () => {
      expect(scorer.name).toBe("latency");
    });

    it("scores 1.0 for traces at or below the fast threshold", async () => {
      const trace = makeTrace({ durationMs: 500 });
      const result = await scorer.score(trace);

      expect(result.scorer).toBe("latency");
      expect(result.score).toBe(1.0);
      expect(result.label).toBe("fast");
      expect(result.detail).toContain("500ms");
    });

    it("scores 1.0 for traces exactly at the fast threshold", async () => {
      const trace = makeTrace({ durationMs: 1000 });
      const result = await scorer.score(trace);

      expect(result.score).toBe(1.0);
      expect(result.label).toBe("fast");
    });

    it("scores 0.0 for traces at or above the slow threshold", async () => {
      const trace = makeTrace({ durationMs: 15000 });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0.0);
      expect(result.label).toBe("very_slow");
    });

    it("scores 0.0 exactly at the slow threshold", async () => {
      const trace = makeTrace({ durationMs: 10000 });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0.0);
      expect(result.label).toBe("very_slow");
    });

    it("scores linearly between fast and slow thresholds", async () => {
      // Midpoint: 5500ms -> (1.0 - (5500 - 1000) / (10000 - 1000)) = 1.0 - 4500/9000 = 0.5
      const trace = makeTrace({ durationMs: 5500 });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0.5);
      expect(result.label).toBe("acceptable");
    });

    it("scores 0.75 at 25% between thresholds", async () => {
      // 3250ms -> 1.0 - (3250 - 1000) / 9000 = 1.0 - 2250/9000 = 0.75
      const trace = makeTrace({ durationMs: 3250 });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0.75);
    });

    it("returns score 0 with label 'unknown' when durationMs is undefined", async () => {
      const trace = makeTrace({ durationMs: undefined });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0);
      expect(result.label).toBe("unknown");
      expect(result.detail).toBe("Trace has no duration");
    });
  });

  describe("label thresholds", () => {
    const scorer = new LatencyScorer();

    it("labels 'fast' for score >= 0.8", async () => {
      // score 0.8 -> durationMs = 1000 + 0.2 * 9000 = 2800
      const trace = makeTrace({ durationMs: 2800 });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0.8);
      expect(result.label).toBe("fast");
    });

    it("labels 'acceptable' for score >= 0.5 and < 0.8", async () => {
      const trace = makeTrace({ durationMs: 5500 });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0.5);
      expect(result.label).toBe("acceptable");
    });

    it("labels 'slow' for score >= 0.2 and < 0.5", async () => {
      // score 0.3 -> durationMs = 1000 + 0.7 * 9000 = 7300
      const trace = makeTrace({ durationMs: 7300 });
      const result = await scorer.score(trace);

      expect(result.score).toBeCloseTo(0.3, 5);
      expect(result.label).toBe("slow");
    });

    it("labels 'very_slow' for score < 0.2", async () => {
      // score 0.1 -> durationMs = 1000 + 0.9 * 9000 = 9100
      const trace = makeTrace({ durationMs: 9100 });
      const result = await scorer.score(trace);

      expect(result.score).toBeCloseTo(0.1, 5);
      expect(result.label).toBe("very_slow");
    });
  });

  describe("custom thresholds", () => {
    it("respects custom fastMs and slowMs", async () => {
      const scorer = new LatencyScorer({ fastMs: 500, slowMs: 2000 });

      // At 500ms -> 1.0
      const fast = await scorer.score(makeTrace({ durationMs: 500 }));
      expect(fast.score).toBe(1.0);

      // At 2000ms -> 0.0
      const slow = await scorer.score(makeTrace({ durationMs: 2000 }));
      expect(slow.score).toBe(0.0);

      // At 1250ms (midpoint) -> 0.5
      const mid = await scorer.score(makeTrace({ durationMs: 1250 }));
      expect(mid.score).toBe(0.5);
    });

    it("includes thresholds in detail message", async () => {
      const scorer = new LatencyScorer({ fastMs: 200, slowMs: 5000 });
      const result = await scorer.score(makeTrace({ durationMs: 1000 }));

      expect(result.detail).toContain("fast=200ms");
      expect(result.detail).toContain("slow=5000ms");
      expect(result.detail).toContain("1000ms");
    });

    it("allows only fastMs to be customized", async () => {
      const scorer = new LatencyScorer({ fastMs: 500 });
      const result = await scorer.score(makeTrace({ durationMs: 500 }));
      expect(result.score).toBe(1.0);
      expect(result.detail).toContain("slow=10000ms"); // default slow
    });

    it("allows only slowMs to be customized", async () => {
      const scorer = new LatencyScorer({ slowMs: 5000 });
      const result = await scorer.score(makeTrace({ durationMs: 5000 }));
      expect(result.score).toBe(0.0);
      expect(result.detail).toContain("fast=1000ms"); // default fast
    });
  });

  describe("edge cases", () => {
    it("scores 1.0 for zero millisecond duration", async () => {
      const scorer = new LatencyScorer();
      const trace = makeTrace({ durationMs: 0 });
      const result = await scorer.score(trace);

      expect(result.score).toBe(1.0);
      expect(result.label).toBe("fast");
    });

    it("scores 0.0 for extremely large duration", async () => {
      const scorer = new LatencyScorer();
      const trace = makeTrace({ durationMs: 999999 });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0.0);
      expect(result.label).toBe("very_slow");
    });
  });
});
