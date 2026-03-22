import type { Scorer, EvalScore, Trace } from "@lantern-ai/sdk";
import type { JudgeLLM } from "../judge.js";
import { parseJudgeResponse } from "../judge.js";

export const HALLUCINATION_PROMPT = `You are an evaluation judge assessing whether an AI assistant's response contains hallucinations — claims or facts not supported by the provided input context.

INPUT CONTEXT:
{{input}}

ASSISTANT OUTPUT:
{{output}}

Analyze the output and determine if it contains any claims not supported by the input context. Respond ONLY with JSON:
{"score": <0.0-1.0>, "label": "<no_hallucination|minor_hallucination|major_hallucination>", "reasoning": "<brief explanation>"}

Scoring guide:
- 1.0 = No hallucination — all claims are supported by the input
- 0.7-0.9 = Minor hallucination — small unsupported details that don't change the meaning
- 0.3-0.6 = Moderate hallucination — some significant unsupported claims
- 0.0-0.2 = Major hallucination — mostly fabricated or unsupported content`;

/**
 * LLM-as-Judge scorer for hallucination detection.
 * Scores 0-1 where 1.0 means no hallucination detected.
 */
export class HallucinationScorer implements Scorer {
  name = "hallucination";
  private judge: JudgeLLM;
  private promptTemplate: string;

  constructor(judge: JudgeLLM, promptTemplate?: string) {
    this.judge = judge;
    this.promptTemplate = promptTemplate ?? HALLUCINATION_PROMPT;
  }

  async score(trace: Trace): Promise<EvalScore> {
    const inputs: string[] = [];
    const outputs: string[] = [];

    for (const span of trace.spans) {
      if (span.type === "llm_call") {
        if (span.input.messages) {
          for (const msg of span.input.messages) {
            inputs.push(`${msg.role}: ${msg.content}`);
          }
        }
        if (span.output?.content) {
          outputs.push(span.output.content);
        }
      }
    }

    if (inputs.length === 0 || outputs.length === 0) {
      return { scorer: this.name, score: 0, label: "no_data", detail: "No input/output spans found" };
    }

    const prompt = this.promptTemplate
      .replace("{{input}}", inputs.join("\n"))
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
