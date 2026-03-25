import type { Scorer, EvalScore, Trace } from "@openlantern-ai/sdk";

/**
 * Scores how relevant the agent's output is to the input.
 * Uses a simple heuristic based on shared terms.
 * In production, replace with an LLM-based judge.
 */
export class RelevanceScorer implements Scorer {
  name = "relevance";

  async score(trace: Trace): Promise<EvalScore> {
    // Extract input and output text from spans
    const inputs: string[] = [];
    const outputs: string[] = [];

    for (const span of trace.spans) {
      if (span.type === "llm_call") {
        if (span.input.messages) {
          for (const msg of span.input.messages) {
            if (msg.role === "user") inputs.push(msg.content);
          }
        }
        if (span.output?.content) {
          outputs.push(span.output.content);
        }
      }
    }

    if (inputs.length === 0 || outputs.length === 0) {
      return { scorer: this.name, score: 0, label: "no_data", reasoning: "No input/output spans found" };
    }

    // Simple term overlap heuristic
    const inputTerms = new Set(
      inputs.join(" ").toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    );
    const outputText = outputs.join(" ").toLowerCase();

    let matchCount = 0;
    for (const term of inputTerms) {
      if (outputText.includes(term)) matchCount++;
    }

    const score = inputTerms.size > 0 ? matchCount / inputTerms.size : 0;

    let label: string;
    if (score >= 0.8) label = "highly_relevant";
    else if (score >= 0.5) label = "relevant";
    else if (score >= 0.2) label = "partially_relevant";
    else label = "not_relevant";

    return { scorer: this.name, score, label };
  }
}
