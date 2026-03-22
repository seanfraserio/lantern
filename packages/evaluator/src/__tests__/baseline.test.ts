import { describe, it, expect } from "vitest";
import { BaselineManager } from "../baseline.js";
import type { EvalScore } from "@lantern-ai/sdk";

function makeScores(
  scorerName: string,
  values: number[],
): EvalScore[] {
  return values.map((score) => ({
    scorer: scorerName,
    score,
    label: "test",
  }));
}

describe("BaselineManager", () => {
  describe("createBaseline()", () => {
    it("creates a baseline with correct mean and stdDev", () => {
      const manager = new BaselineManager();
      const scores = makeScores("relevance", [0.8, 0.9, 0.7, 0.85, 0.75]);

      const baseline = manager.createBaseline("relevance", scores);

      // Mean: (0.8 + 0.9 + 0.7 + 0.85 + 0.75) / 5 = 4.0 / 5 = 0.8
      expect(baseline.meanScore).toBeCloseTo(0.8, 5);
      expect(baseline.scorerName).toBe("relevance");
      expect(baseline.sampleCount).toBe(5);
      expect(baseline.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(baseline.createdAt).toBeDefined();
    });

    it("computes population standard deviation", () => {
      const manager = new BaselineManager();
      // Values: [2, 4, 4, 4, 5, 5, 7, 9]
      // Mean: 40/8 = 5
      // Variance: ((3^2 + 1^2 + 1^2 + 1^2 + 0 + 0 + 4 + 16) / 8) = (9+1+1+1+0+0+4+16)/8 = 32/8 = 4
      // StdDev: 2
      const scores = makeScores("test", [2, 4, 4, 4, 5, 5, 7, 9]);

      const baseline = manager.createBaseline("test", scores);

      expect(baseline.meanScore).toBe(5);
      expect(baseline.stdDev).toBe(2);
    });

    it("computes stdDev of 0 for uniform scores", () => {
      const manager = new BaselineManager();
      const scores = makeScores("test", [0.5, 0.5, 0.5, 0.5]);

      const baseline = manager.createBaseline("test", scores);

      expect(baseline.meanScore).toBe(0.5);
      expect(baseline.stdDev).toBe(0);
    });

    it("works with a single score", () => {
      const manager = new BaselineManager();
      const scores = makeScores("test", [0.9]);

      const baseline = manager.createBaseline("test", scores);

      expect(baseline.meanScore).toBe(0.9);
      expect(baseline.stdDev).toBe(0);
      expect(baseline.sampleCount).toBe(1);
    });

    it("filters scores by scorer name", () => {
      const manager = new BaselineManager();
      const scores: EvalScore[] = [
        { scorer: "relevance", score: 0.8 },
        { scorer: "toxicity", score: 0.95 },
        { scorer: "relevance", score: 0.6 },
        { scorer: "toxicity", score: 0.9 },
      ];

      const baseline = manager.createBaseline("relevance", scores);

      expect(baseline.meanScore).toBeCloseTo(0.7, 5);
      expect(baseline.sampleCount).toBe(2);
    });

    it("throws when no scores match the scorer name", () => {
      const manager = new BaselineManager();
      const scores = makeScores("relevance", [0.8]);

      expect(() => manager.createBaseline("nonexistent", scores)).toThrow(
        'No scores found for scorer "nonexistent"',
      );
    });

    it("throws for empty scores array", () => {
      const manager = new BaselineManager();

      expect(() => manager.createBaseline("test", [])).toThrow(
        'No scores found for scorer "test"',
      );
    });

    it("overwrites previous baseline for the same scorer", () => {
      const manager = new BaselineManager();

      manager.createBaseline("test", makeScores("test", [0.5, 0.5]));
      expect(manager.getBaseline("test")?.meanScore).toBe(0.5);

      manager.createBaseline("test", makeScores("test", [0.9, 0.9]));
      expect(manager.getBaseline("test")?.meanScore).toBe(0.9);
    });
  });

  describe("getBaseline()", () => {
    it("returns undefined for unknown scorer", () => {
      const manager = new BaselineManager();
      expect(manager.getBaseline("unknown")).toBeUndefined();
    });

    it("returns the stored baseline", () => {
      const manager = new BaselineManager();
      const created = manager.createBaseline("test", makeScores("test", [0.7, 0.8]));

      const retrieved = manager.getBaseline("test");
      expect(retrieved).toEqual(created);
    });
  });

  describe("checkRegression()", () => {
    it("returns null when no baseline exists", () => {
      const manager = new BaselineManager();
      const result = manager.checkRegression("unknown", 0.5);
      expect(result).toBeNull();
    });

    it("detects no regression when score is above mean", () => {
      const manager = new BaselineManager();
      // Mean = 0.8, StdDev = 0
      manager.createBaseline("test", makeScores("test", [0.8, 0.8, 0.8]));

      const result = manager.checkRegression("test", 0.9);
      expect(result).not.toBeNull();
      expect(result!.isRegression).toBe(false);
      expect(result!.delta).toBeCloseTo(0.1, 5);
      expect(result!.baseline).toBeCloseTo(0.8, 5);
    });

    it("detects no regression when score equals mean", () => {
      const manager = new BaselineManager();
      manager.createBaseline("test", makeScores("test", [0.8, 0.8, 0.8]));

      const result = manager.checkRegression("test", 0.8);
      expect(result!.isRegression).toBe(false);
      expect(result!.delta).toBeCloseTo(0, 10);
    });

    it("detects no regression when score is slightly below mean but within 2 sigma", () => {
      const manager = new BaselineManager();
      // Mean = 0.8, StdDev = 0.1
      // Values: [0.7, 0.9] -> mean = 0.8, variance = 0.01, stddev = 0.1
      manager.createBaseline("test", makeScores("test", [0.7, 0.9]));

      const baseline = manager.getBaseline("test")!;
      expect(baseline.meanScore).toBeCloseTo(0.8, 5);
      expect(baseline.stdDev).toBeCloseTo(0.1, 5);

      // 2*sigma = 0.2, so threshold is mean - 0.2 = 0.6
      // Score 0.65 is above 0.6, so no regression
      const result = manager.checkRegression("test", 0.65);
      expect(result!.isRegression).toBe(false);
    });

    it("detects regression when score drops below mean - 2*sigma", () => {
      const manager = new BaselineManager();
      // Mean = 0.8, StdDev = 0.1 -> threshold = 0.6
      manager.createBaseline("test", makeScores("test", [0.7, 0.9]));

      // Score 0.5 is below 0.6 -> regression
      const result = manager.checkRegression("test", 0.5);
      expect(result!.isRegression).toBe(true);
      expect(result!.delta).toBeCloseTo(-0.3, 5);
      expect(result!.baseline).toBeCloseTo(0.8, 5);
    });

    it("detects regression at exactly mean - 2*sigma - epsilon", () => {
      const manager = new BaselineManager();
      // Mean = 0.8, StdDev = 0.1 -> threshold = 0.6
      manager.createBaseline("test", makeScores("test", [0.7, 0.9]));

      // Score 0.599 is just below 0.6 -> regression
      const result = manager.checkRegression("test", 0.599);
      expect(result!.isRegression).toBe(true);
    });

    it("does NOT detect regression at exactly mean - 2*sigma", () => {
      const manager = new BaselineManager();
      // Mean = 0.8, StdDev = 0.1 -> threshold = 0.6
      manager.createBaseline("test", makeScores("test", [0.7, 0.9]));

      // Score 0.6 -> delta = -0.2, threshold is delta < -0.2 (strict less than)
      // delta = -0.2, -(2 * 0.1) = -0.2, -0.2 < -0.2 is false
      const result = manager.checkRegression("test", 0.6);
      expect(result!.isRegression).toBe(false);
    });

    it("always detects regression with zero stdDev when score drops", () => {
      const manager = new BaselineManager();
      // StdDev = 0 -> threshold = mean - 0 = mean
      // Any score below mean triggers regression
      manager.createBaseline("test", makeScores("test", [0.8, 0.8, 0.8]));

      const result = manager.checkRegression("test", 0.79);
      // delta = -0.01, -(2*0) = 0, -0.01 < 0 -> true
      expect(result!.isRegression).toBe(true);
    });

    it("does not detect regression with zero stdDev when score equals mean", () => {
      const manager = new BaselineManager();
      manager.createBaseline("test", makeScores("test", [0.8, 0.8]));

      const result = manager.checkRegression("test", 0.8);
      expect(result!.isRegression).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles scores of all zeros", () => {
      const manager = new BaselineManager();
      const scores = makeScores("test", [0, 0, 0]);

      const baseline = manager.createBaseline("test", scores);
      expect(baseline.meanScore).toBe(0);
      expect(baseline.stdDev).toBe(0);

      // Zero score against zero baseline -> no regression
      const result = manager.checkRegression("test", 0);
      expect(result!.isRegression).toBe(false);
    });

    it("handles negative delta correctly", () => {
      const manager = new BaselineManager();
      manager.createBaseline("test", makeScores("test", [0.5, 0.5]));

      const result = manager.checkRegression("test", 0.1);
      expect(result!.delta).toBeCloseTo(-0.4, 5);
      expect(result!.isRegression).toBe(true);
    });

    it("handles very small scores", () => {
      const manager = new BaselineManager();
      const scores = makeScores("test", [0.001, 0.002, 0.003]);

      const baseline = manager.createBaseline("test", scores);
      expect(baseline.meanScore).toBeCloseTo(0.002, 5);
      expect(baseline.sampleCount).toBe(3);
    });

    it("handles very large number of scores", () => {
      const manager = new BaselineManager();
      const values = Array.from({ length: 1000 }, () => 0.8);
      const scores = makeScores("test", values);

      const baseline = manager.createBaseline("test", scores);
      expect(baseline.meanScore).toBeCloseTo(0.8, 5);
      expect(baseline.stdDev).toBeCloseTo(0, 10);
      expect(baseline.sampleCount).toBe(1000);
    });
  });
});
