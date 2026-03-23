/**
 * Example: Register a custom evaluation scorer.
 */

import type { Scorer, EvalScore, Trace } from "@openlantern-ai/sdk";
import { EvalRunner, RelevanceScorer, LatencyScorer } from "@openlantern-ai/evaluator";

/**
 * Custom scorer: checks if the agent's response is concise.
 */
class ConcisenessScorer implements Scorer {
  name = "conciseness";

  async score(trace: Trace): Promise<EvalScore> {
    let totalOutputLength = 0;
    let outputCount = 0;

    for (const span of trace.spans) {
      if (span.output?.content) {
        totalOutputLength += span.output.content.length;
        outputCount++;
      }
    }

    if (outputCount === 0) {
      return { scorer: this.name, score: 1.0, label: "no_output" };
    }

    const avgLength = totalOutputLength / outputCount;

    // Score: shorter responses get higher scores (up to a point)
    let score: number;
    if (avgLength <= 200) score = 1.0;
    else if (avgLength <= 500) score = 0.8;
    else if (avgLength <= 1000) score = 0.5;
    else score = 0.2;

    return {
      scorer: this.name,
      score,
      label: score >= 0.8 ? "concise" : score >= 0.5 ? "moderate" : "verbose",
      detail: `Average output length: ${Math.round(avgLength)} chars`,
    };
  }
}

// Use the runner with built-in + custom scorers
const runner = new EvalRunner();
runner.addScorer(new RelevanceScorer());
runner.addScorer(new LatencyScorer());
runner.addScorer(new ConcisenessScorer());

// Demo with a mock trace
async function demo() {
  const mockTrace: Trace = {
    id: "demo-trace-1",
    sessionId: "demo-session",
    agentName: "demo-agent",
    environment: "dev",
    startTime: Date.now() - 2000,
    endTime: Date.now(),
    durationMs: 2000,
    status: "success",
    spans: [
      {
        id: "span-1",
        traceId: "demo-trace-1",
        type: "llm_call",
        startTime: Date.now() - 2000,
        endTime: Date.now(),
        durationMs: 2000,
        input: { messages: [{ role: "user", content: "What is TypeScript?" }] },
        output: { content: "TypeScript is a typed superset of JavaScript.", stopReason: "end_turn" },
        model: "claude-sonnet-4-5-20251001",
        inputTokens: 10,
        outputTokens: 12,
      },
    ],
    metadata: {},
    totalInputTokens: 10,
    totalOutputTokens: 12,
    estimatedCostUsd: 0.0002,
  };

  const result = await runner.run([mockTrace]);
  console.log("Eval Results:");
  for (const score of result.scores) {
    console.log(`  ${score.scorer}: ${score.score.toFixed(2)} (${score.label})`);
  }
}

demo().catch(console.error);

export { runner, ConcisenessScorer };
