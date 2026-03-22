import type { Scorer, EvalScore, Trace } from "@openlantern-ai/sdk";
import type { JudgeLLM } from "../judge.js";
import { parseJudgeResponse } from "../judge.js";

export const FAITHFULNESS_PROMPT = `You are an evaluation judge assessing whether an AI assistant's response is faithful to the retrieved context. This is critical for RAG (Retrieval-Augmented Generation) systems.

RETRIEVED CONTEXT:
{{context}}

ASSISTANT RESPONSE:
{{output}}

Analyze whether every claim in the response is supported by the retrieved context. The response should not introduce information beyond what the context provides. Respond ONLY with JSON:
{"score": <0.0-1.0>, "label": "<faithful|mostly_faithful|partially_faithful|unfaithful>", "reasoning": "<brief explanation>"}

Scoring guide:
- 0.9-1.0 = Faithful — all claims supported by context
- 0.6-0.8 = Mostly faithful — minor additions beyond context but core is accurate
- 0.3-0.5 = Partially faithful — significant claims not in context
- 0.0-0.2 = Unfaithful — response contradicts or ignores context`;

/**
 * LLM-as-Judge scorer for faithfulness to retrieved context (RAG evaluation).
 * Scores 0-1 where 1.0 means the response is completely faithful to the context.
 *
 * Extracts context from `retrieval` spans and output from `llm_call` spans.
 */
export class FaithfulnessScorer implements Scorer {
  name = "faithfulness";
  private judge: JudgeLLM;
  private promptTemplate: string;

  constructor(judge: JudgeLLM, promptTemplate?: string) {
    this.judge = judge;
    this.promptTemplate = promptTemplate ?? FAITHFULNESS_PROMPT;
  }

  async score(trace: Trace): Promise<EvalScore> {
    const contexts: string[] = [];
    const outputs: string[] = [];

    for (const span of trace.spans) {
      // Retrieval spans contain the context documents
      if (span.type === "retrieval") {
        if (span.output?.content) {
          contexts.push(span.output.content);
        } else if (span.toolResult && typeof span.toolResult === "string") {
          contexts.push(span.toolResult);
        }
      }
      // LLM call spans contain the generated output
      if (span.type === "llm_call" && span.output?.content) {
        outputs.push(span.output.content);
      }
    }

    if (contexts.length === 0) {
      return { scorer: this.name, score: 0, label: "no_context", detail: "No retrieval spans found — faithfulness requires RAG context" };
    }
    if (outputs.length === 0) {
      return { scorer: this.name, score: 0, label: "no_data", detail: "No LLM output spans found" };
    }

    const prompt = this.promptTemplate
      .replace("{{context}}", contexts.join("\n---\n"))
      .replace("{{output}}", outputs.join("\n"));

    try {
      const raw = await this.judge.generate(prompt);
      const { score, label, reasoning } = parseJudgeResponse(raw);
      return { scorer: this.name, score, label, detail: reasoning };
    } catch (error) {
      return { scorer: this.name, score: 0, label: "error", detail: `Judge failed: ${error}` };
    }
  }
}
