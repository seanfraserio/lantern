import type { Trace, Scorer, EvalScore, EvalRunResult, Regression } from "@openlantern-ai/sdk";
import { BaselineManager } from "./baseline.js";

/**
 * Runs evaluation scorers against a set of traces.
 */
export class EvalRunner {
  private scorers: Scorer[] = [];
  private baselineManager: BaselineManager;

  constructor() {
    this.baselineManager = new BaselineManager();
  }

  /**
   * Register a scorer.
   */
  addScorer(scorer: Scorer): void {
    this.scorers.push(scorer);
  }

  /**
   * Run all registered scorers against a set of traces.
   */
  async run(traces: Trace[]): Promise<EvalRunResult> {
    const allScores: EvalScore[] = [];
    const regressions: Regression[] = [];

    for (const trace of traces) {
      for (const scorer of this.scorers) {
        const score = await scorer.score(trace);
        allScores.push(score);

        // Check for regression
        const check = this.baselineManager.checkRegression(scorer.name, score.score);
        if (check?.isRegression) {
          regressions.push({
            scorer: scorer.name,
            baseline: check.baseline,
            current: score.score,
            delta: check.delta,
            isSignificant: true,
          });
        }
      }
    }

    return {
      traceCount: traces.length,
      scores: allScores,
      regressions,
    };
  }

  /**
   * Snapshot current scores as a baseline for future comparison.
   */
  createBaselines(scores: EvalScore[]): void {
    const scorerNames = new Set(scores.map((s) => s.scorer));
    for (const name of scorerNames) {
      this.baselineManager.createBaseline(name, scores);
    }
  }

  getBaselineManager(): BaselineManager {
    return this.baselineManager;
  }
}
