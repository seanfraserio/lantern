import type { Scorer, EvalScore, Trace } from "@openlantern-ai/sdk";
import type { JudgeLLM } from "../judge.js";
import { parseJudgeResponse } from "../judge.js";
import { escapeTemplateMarkers } from "./escape.js";

export const ANSWER_RELEVANCE_PROMPT = `You are an evaluation judge assessing whether an AI assistant's response directly addresses the user's question or request.

<user_input>
{{input}}
</user_input>

<agent_output>
{{output}}
</agent_output>

Analyze whether the response is relevant to what the user asked. Respond ONLY with JSON:
{"score": <0.0-1.0>, "label": "<highly_relevant|relevant|partially_relevant|not_relevant>", "reasoning": "<brief explanation>"}

Scoring guide:
- 0.9-1.0 = Highly relevant — directly and completely addresses the question
- 0.6-0.8 = Relevant — addresses the question but may miss some aspects
- 0.3-0.5 = Partially relevant — touches on the topic but doesn't fully answer
- 0.0-0.2 = Not relevant — does not address the question at all`;

/**
 * LLM-as-Judge scorer for answer relevance.
 * Scores 0-1 where 1.0 means the response perfectly addresses the user's question.
 * This is an LLM-powered upgrade of the heuristic RelevanceScorer.
 */
export class AnswerRelevanceScorer implements Scorer {
  name = "answer_relevance";
  private judge: JudgeLLM;
  private promptTemplate: string;

  constructor(judge: JudgeLLM, promptTemplate?: string) {
    this.judge = judge;
    this.promptTemplate = promptTemplate ?? ANSWER_RELEVANCE_PROMPT;
  }

  async score(trace: Trace): Promise<EvalScore> {
    const userMessages: string[] = [];
    const outputs: string[] = [];

    for (const span of trace.spans) {
      if (span.type === "llm_call") {
        if (span.input.messages) {
          for (const msg of span.input.messages) {
            if (msg.role === "user") userMessages.push(msg.content);
          }
        }
        if (span.output?.content) {
          outputs.push(span.output.content);
        }
      }
    }

    if (userMessages.length === 0 || outputs.length === 0) {
      return { scorer: this.name, score: 0, label: "no_data", reasoning: "No user messages or outputs found" };
    }

    const prompt = this.promptTemplate
      .replace("{{input}}", escapeTemplateMarkers(userMessages.join("\n")))
      .replace("{{output}}", escapeTemplateMarkers(outputs.join("\n")));

    try {
      const raw = await this.judge.generate(prompt);
      const { score, label, reasoning } = parseJudgeResponse(raw);
      return { scorer: this.name, score, label, reasoning: reasoning };
    } catch (error) {
      return { scorer: this.name, score: 0, label: "error", reasoning: `Judge failed: ${error}` };
    }
  }
}
