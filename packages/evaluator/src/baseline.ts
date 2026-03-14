import type { Baseline, EvalScore } from "@lantern-ai/sdk";
import { randomUUID } from "node:crypto";

/**
 * Manages evaluation baselines for regression detection.
 * Stores baseline stats (mean, stddev) for each scorer.
 */
export class BaselineManager {
  private baselines: Map<string, Baseline> = new Map();

  /**
   * Create a baseline from a set of scores.
   */
  createBaseline(scorerName: string, scores: EvalScore[]): Baseline {
    const values = scores
      .filter((s) => s.scorer === scorerName)
      .map((s) => s.score);

    if (values.length === 0) {
      throw new Error(`No scores found for scorer "${scorerName}"`);
    }

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    const baseline: Baseline = {
      id: randomUUID(),
      scorerName,
      meanScore: mean,
      stdDev,
      sampleCount: values.length,
      createdAt: new Date().toISOString(),
    };

    this.baselines.set(scorerName, baseline);
    return baseline;
  }

  /**
   * Get baseline for a scorer.
   */
  getBaseline(scorerName: string): Baseline | undefined {
    return this.baselines.get(scorerName);
  }

  /**
   * Check if a score represents a regression from baseline.
   * Uses 2 standard deviations as the significance threshold.
   */
  checkRegression(scorerName: string, currentScore: number): {
    isRegression: boolean;
    delta: number;
    baseline: number;
  } | null {
    const baseline = this.baselines.get(scorerName);
    if (!baseline) return null;

    const delta = currentScore - baseline.meanScore;
    const isRegression = delta < -(2 * baseline.stdDev);

    return { isRegression, delta, baseline: baseline.meanScore };
  }
}
