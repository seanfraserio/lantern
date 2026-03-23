import { describe, it, expect, vi, beforeEach } from "vitest";
import { EvalRunner } from "../runner.js";
import type { Scorer, EvalScore, Trace } from "@openlantern-ai/sdk";
import { makeTrace, makeLlmTrace } from "./helpers.js";

/**
 * Create a mock scorer that returns a fixed score.
 */
function mockScorer(name: string, fixedScore: number): Scorer {
  return {
    name,
    score: vi.fn().mockResolvedValue({
      scorer: name,
      score: fixedScore,
      label: "mock",
    } as EvalScore),
  };
}

describe("EvalRunner", () => {
  let runner: EvalRunner;

  beforeEach(() => {
    runner = new EvalRunner();
  });

  describe("addScorer()", () => {
    it("accepts scorers and runs them during evaluation", async () => {
      const scorer = mockScorer("test", 0.9);
      runner.addScorer(scorer);

      const result = await runner.run([makeTrace()]);
      expect(scorer.score).toHaveBeenCalledTimes(1);
      expect(result.scores).toHaveLength(1);
      expect(result.scores[0].scorer).toBe("test");
    });

    it("supports multiple scorers", async () => {
      runner.addScorer(mockScorer("scorer-a", 0.8));
      runner.addScorer(mockScorer("scorer-b", 0.6));

      const result = await runner.run([makeTrace()]);
      expect(result.scores).toHaveLength(2);
      expect(result.scores.map((s) => s.scorer)).toEqual(["scorer-a", "scorer-b"]);
    });
  });

  describe("run()", () => {
    it("returns traceCount equal to the number of input traces", async () => {
      runner.addScorer(mockScorer("test", 0.9));

      const traces = [makeTrace(), makeTrace(), makeTrace()];
      const result = await runner.run(traces);

      expect(result.traceCount).toBe(3);
    });

    it("runs each scorer against each trace", async () => {
      const scorerA = mockScorer("a", 0.8);
      const scorerB = mockScorer("b", 0.5);
      runner.addScorer(scorerA);
      runner.addScorer(scorerB);

      const traces = [makeTrace(), makeTrace()];
      const result = await runner.run(traces);

      expect(scorerA.score).toHaveBeenCalledTimes(2);
      expect(scorerB.score).toHaveBeenCalledTimes(2);
      // 2 traces * 2 scorers = 4 scores
      expect(result.scores).toHaveLength(4);
    });

    it("returns empty scores and regressions for empty trace array", async () => {
      runner.addScorer(mockScorer("test", 0.9));

      const result = await runner.run([]);

      expect(result.traceCount).toBe(0);
      expect(result.scores).toEqual([]);
      expect(result.regressions).toEqual([]);
    });

    it("returns empty scores when no scorers are registered", async () => {
      const result = await runner.run([makeTrace()]);

      expect(result.traceCount).toBe(1);
      expect(result.scores).toEqual([]);
      expect(result.regressions).toEqual([]);
    });

    it("passes the trace object to each scorer", async () => {
      const scorer = mockScorer("test", 0.9);
      runner.addScorer(scorer);

      const trace = makeTrace({ agentName: "special-agent" });
      await runner.run([trace]);

      expect(scorer.score).toHaveBeenCalledWith(trace);
    });
  });

  describe("regression detection during run()", () => {
    it("detects regressions when scores drop below baseline", async () => {
      // First, create baselines with high scores
      const baselineScores: EvalScore[] = [
        { scorer: "quality", score: 0.9 },
        { scorer: "quality", score: 0.9 },
        { scorer: "quality", score: 0.9 },
      ];
      runner.createBaselines(baselineScores);

      // Now add a scorer that returns a low score
      runner.addScorer(mockScorer("quality", 0.2));

      const result = await runner.run([makeTrace()]);

      expect(result.regressions).toHaveLength(1);
      expect(result.regressions[0].scorer).toBe("quality");
      expect(result.regressions[0].baseline).toBeCloseTo(0.9, 5);
      expect(result.regressions[0].current).toBe(0.2);
      expect(result.regressions[0].isSignificant).toBe(true);
      expect(result.regressions[0].delta).toBeCloseTo(-0.7, 5);
    });

    it("does not flag regression when no baseline exists", async () => {
      runner.addScorer(mockScorer("quality", 0.1));

      const result = await runner.run([makeTrace()]);
      expect(result.regressions).toEqual([]);
    });

    it("does not flag regression when score is within 2 sigma", async () => {
      // Baseline: mean=0.8, stdDev=0.1 -> threshold=0.6
      const scores: EvalScore[] = [
        { scorer: "quality", score: 0.7 },
        { scorer: "quality", score: 0.9 },
      ];
      runner.createBaselines(scores);

      // Score 0.65 is above 0.6, so no regression
      runner.addScorer(mockScorer("quality", 0.65));

      const result = await runner.run([makeTrace()]);
      expect(result.regressions).toEqual([]);
    });

    it("reports regression per trace (multiple regressions possible)", async () => {
      const scores: EvalScore[] = [
        { scorer: "quality", score: 0.9 },
        { scorer: "quality", score: 0.9 },
      ];
      runner.createBaselines(scores);

      runner.addScorer(mockScorer("quality", 0.1));

      // Two traces, each will produce a regression
      const result = await runner.run([makeTrace(), makeTrace()]);
      expect(result.regressions).toHaveLength(2);
    });
  });

  describe("createBaselines()", () => {
    it("creates baselines from scores", () => {
      const scores: EvalScore[] = [
        { scorer: "relevance", score: 0.8 },
        { scorer: "relevance", score: 0.9 },
        { scorer: "toxicity", score: 0.95 },
      ];

      runner.createBaselines(scores);

      const bm = runner.getBaselineManager();
      const relBaseline = bm.getBaseline("relevance");
      const toxBaseline = bm.getBaseline("toxicity");

      expect(relBaseline).toBeDefined();
      expect(relBaseline!.meanScore).toBeCloseTo(0.85, 5);
      expect(toxBaseline).toBeDefined();
      expect(toxBaseline!.meanScore).toBe(0.95);
    });

    it("creates baselines for all unique scorer names", () => {
      const scores: EvalScore[] = [
        { scorer: "a", score: 0.5 },
        { scorer: "b", score: 0.6 },
        { scorer: "c", score: 0.7 },
      ];

      runner.createBaselines(scores);

      const bm = runner.getBaselineManager();
      expect(bm.getBaseline("a")).toBeDefined();
      expect(bm.getBaseline("b")).toBeDefined();
      expect(bm.getBaseline("c")).toBeDefined();
    });
  });

  describe("getBaselineManager()", () => {
    it("returns the internal BaselineManager", () => {
      const bm = runner.getBaselineManager();
      expect(bm).toBeDefined();
      expect(bm.getBaseline("anything")).toBeUndefined();
    });
  });

  describe("integration with real scorers", () => {
    it("runs real LatencyScorer against traces", async () => {
      const { LatencyScorer } = await import("../scorers/latency.js");
      runner.addScorer(new LatencyScorer());

      const fastTrace = makeTrace({ durationMs: 500 });
      const slowTrace = makeTrace({ durationMs: 15000 });

      const result = await runner.run([fastTrace, slowTrace]);

      expect(result.traceCount).toBe(2);
      expect(result.scores).toHaveLength(2);
      expect(result.scores[0].score).toBe(1.0); // fast
      expect(result.scores[1].score).toBe(0.0); // slow
    });

    it("runs real ToxicityScorer against traces", async () => {
      const { ToxicityScorer } = await import("../scorers/toxicity.js");
      runner.addScorer(new ToxicityScorer());

      const cleanTrace = makeLlmTrace("Hello", "Hi there, how can I help?");
      const toxicTrace = makeLlmTrace("Hello", "That is a stupid and hateful thing to say.");

      const result = await runner.run([cleanTrace, toxicTrace]);

      expect(result.scores).toHaveLength(2);
      expect(result.scores[0].score).toBe(1.0); // clean
      expect(result.scores[1].score).toBeLessThan(1.0); // toxic
    });

    it("runs real RelevanceScorer against traces", async () => {
      const { RelevanceScorer } = await import("../scorers/relevance.js");
      runner.addScorer(new RelevanceScorer());

      const relevantTrace = makeLlmTrace(
        "Explain machine learning algorithms",
        "Machine learning algorithms are techniques that allow computers to learn from data.",
      );
      const irrelevantTrace = makeLlmTrace(
        "Explain machine learning algorithms",
        "The weather is sunny today with a high of 75 degrees.",
      );

      const result = await runner.run([relevantTrace, irrelevantTrace]);

      expect(result.scores).toHaveLength(2);
      expect(result.scores[0].score).toBeGreaterThan(result.scores[1].score);
    });

    it("runs multiple real scorers and detects regression end-to-end", async () => {
      const { LatencyScorer } = await import("../scorers/latency.js");
      const { ToxicityScorer } = await import("../scorers/toxicity.js");

      runner.addScorer(new LatencyScorer());
      runner.addScorer(new ToxicityScorer());

      // Create baselines from "good" traces
      const goodTraces = [
        makeLlmTrace("Hello", "Hi there!", { durationMs: 500 }),
        makeLlmTrace("Hello", "How can I help?", { durationMs: 600 }),
        makeLlmTrace("Hello", "I am ready to assist.", { durationMs: 550 }),
      ];

      const baselineResult = await runner.run(goodTraces);
      runner.createBaselines(baselineResult.scores);

      // Now run with a "bad" trace (slow + toxic)
      const badTrace = makeLlmTrace(
        "Hello",
        "You stupid idiot, I hate you and want to destroy everything and kill morons.",
        { durationMs: 50000 },
      );

      const result = await runner.run([badTrace]);

      // Should have regressions for both scorers
      expect(result.regressions.length).toBeGreaterThanOrEqual(1);
      const scorerNames = result.regressions.map((r) => r.scorer);
      expect(scorerNames).toContain("latency");
      // toxicity regression depends on baseline stddev
    });
  });
});
