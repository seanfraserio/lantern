import type { Scorer, EvalScore, Trace } from "@lantern-ai/sdk";

/**
 * Scores trace latency. Lower latency = higher score.
 * Configurable thresholds for what constitutes "fast" vs "slow".
 */
export class LatencyScorer implements Scorer {
  name = "latency";
  private fastMs: number;
  private slowMs: number;

  constructor(opts?: { fastMs?: number; slowMs?: number }) {
    this.fastMs = opts?.fastMs ?? 1000;
    this.slowMs = opts?.slowMs ?? 10000;
  }

  async score(trace: Trace): Promise<EvalScore> {
    const durationMs = trace.durationMs;

    if (durationMs === undefined) {
      return { scorer: this.name, score: 0, label: "unknown", detail: "Trace has no duration" };
    }

    // Linear scale: fast = 1.0, slow = 0.0
    let score: number;
    if (durationMs <= this.fastMs) {
      score = 1.0;
    } else if (durationMs >= this.slowMs) {
      score = 0.0;
    } else {
      score = 1.0 - (durationMs - this.fastMs) / (this.slowMs - this.fastMs);
    }

    let label: string;
    if (score >= 0.8) label = "fast";
    else if (score >= 0.5) label = "acceptable";
    else if (score >= 0.2) label = "slow";
    else label = "very_slow";

    return {
      scorer: this.name,
      score,
      label,
      detail: `${durationMs}ms (thresholds: fast=${this.fastMs}ms, slow=${this.slowMs}ms)`,
    };
  }
}
