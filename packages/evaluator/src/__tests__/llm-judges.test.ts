import { describe, it, expect, vi } from "vitest";
import type { JudgeLLM } from "../judge.js";
import { parseJudgeResponse, anthropicJudge, openaiJudge } from "../judge.js";
import { HallucinationScorer } from "../scorers/hallucination.js";
import { AnswerRelevanceScorer } from "../scorers/answer-relevance.js";
import { ModerationScorer } from "../scorers/moderation.js";
import { FaithfulnessScorer } from "../scorers/faithfulness.js";
import { makeTrace, makeSpan, makeLlmTrace } from "./helpers.js";

// ─── Mock Judge ───

function mockJudge(response: Record<string, unknown>): JudgeLLM {
  return { generate: vi.fn().mockResolvedValue(JSON.stringify(response)) };
}

function failingJudge(error: string): JudgeLLM {
  return { generate: vi.fn().mockRejectedValue(new Error(error)) };
}

// ─── parseJudgeResponse ───

describe("parseJudgeResponse", () => {
  it("parses valid JSON", () => {
    const result = parseJudgeResponse('{"score": 0.85, "label": "good", "reasoning": "looks fine"}');
    expect(result.score).toBe(0.85);
    expect(result.label).toBe("good");
    expect(result.reasoning).toBe("looks fine");
  });

  it("extracts JSON from markdown code blocks", () => {
    const result = parseJudgeResponse('Here is my analysis:\n```json\n{"score": 0.7, "label": "ok", "reasoning": "decent"}\n```');
    expect(result.score).toBe(0.7);
  });

  it("clamps score to 0-1", () => {
    expect(parseJudgeResponse('{"score": 1.5, "label": "x", "reasoning": "y"}').score).toBe(1);
    expect(parseJudgeResponse('{"score": -0.5, "label": "x", "reasoning": "y"}').score).toBe(0);
  });

  it("returns parse_error for non-JSON", () => {
    const result = parseJudgeResponse("I cannot evaluate this");
    expect(result.label).toBe("parse_error");
    expect(result.score).toBe(0);
  });

  it("handles missing fields gracefully", () => {
    const result = parseJudgeResponse('{"score": 0.5}');
    expect(result.score).toBe(0.5);
    expect(result.label).toBe("unknown");
    expect(result.reasoning).toBe("");
  });
});

// ─── HallucinationScorer ───

describe("HallucinationScorer", () => {
  it("scores a trace with no hallucination", async () => {
    const judge = mockJudge({ score: 1.0, label: "no_hallucination", reasoning: "All claims supported" });
    const scorer = new HallucinationScorer(judge);
    const trace = makeLlmTrace("What is 2+2?", "2+2 equals 4.");

    const result = await scorer.score(trace);
    expect(result.scorer).toBe("hallucination");
    expect(result.score).toBe(1.0);
    expect(result.label).toBe("no_hallucination");
  });

  it("scores a trace with hallucination", async () => {
    const judge = mockJudge({ score: 0.2, label: "major_hallucination", reasoning: "Fabricated statistics" });
    const scorer = new HallucinationScorer(judge);
    const trace = makeLlmTrace("Tell me about X", "X was founded in 1823 and has 500 employees.");

    const result = await scorer.score(trace);
    expect(result.score).toBe(0.2);
    expect(result.label).toBe("major_hallucination");
  });

  it("returns no_data for empty traces", async () => {
    const judge = mockJudge({ score: 1.0, label: "ok", reasoning: "" });
    const scorer = new HallucinationScorer(judge);
    const trace = makeTrace({ spans: [] });

    const result = await scorer.score(trace);
    expect(result.label).toBe("no_data");
    expect((judge.generate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("handles judge errors gracefully", async () => {
    const judge = failingJudge("API timeout");
    const scorer = new HallucinationScorer(judge);
    const trace = makeLlmTrace("Hello", "Hi there");

    const result = await scorer.score(trace);
    expect(result.label).toBe("error");
    expect(result.detail).toContain("API timeout");
  });

  it("sends input and output to the judge", async () => {
    const judge = mockJudge({ score: 0.9, label: "ok", reasoning: "" });
    const scorer = new HallucinationScorer(judge);
    const trace = makeLlmTrace("What is TypeScript?", "TypeScript is a typed superset of JavaScript.");

    await scorer.score(trace);
    const prompt = (judge.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("What is TypeScript?");
    expect(prompt).toContain("TypeScript is a typed superset of JavaScript.");
  });
});

// ─── AnswerRelevanceScorer ───

describe("AnswerRelevanceScorer", () => {
  it("scores a relevant answer", async () => {
    const judge = mockJudge({ score: 0.95, label: "highly_relevant", reasoning: "Directly addresses the question" });
    const scorer = new AnswerRelevanceScorer(judge);
    const trace = makeLlmTrace("How do I install Node.js?", "Download Node.js from nodejs.org and run the installer.");

    const result = await scorer.score(trace);
    expect(result.scorer).toBe("answer_relevance");
    expect(result.score).toBe(0.95);
  });

  it("scores an irrelevant answer", async () => {
    const judge = mockJudge({ score: 0.1, label: "not_relevant", reasoning: "Response about cooking, not programming" });
    const scorer = new AnswerRelevanceScorer(judge);
    const trace = makeLlmTrace("How do I install Node.js?", "To make pasta, boil water for 10 minutes.");

    const result = await scorer.score(trace);
    expect(result.score).toBe(0.1);
    expect(result.label).toBe("not_relevant");
  });

  it("only extracts user messages for input", async () => {
    const judge = mockJudge({ score: 0.8, label: "relevant", reasoning: "" });
    const scorer = new AnswerRelevanceScorer(judge);

    const span = makeSpan({
      type: "llm_call",
      input: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "What is Lantern?" },
        ],
      },
      output: { content: "Lantern is an observability platform." },
    });
    const trace = makeTrace({ spans: [span] });

    await scorer.score(trace);
    const prompt = (judge.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("What is Lantern?");
    expect(prompt).not.toContain("You are helpful");
  });
});

// ─── ModerationScorer ───

describe("ModerationScorer", () => {
  it("scores safe content", async () => {
    const judge = mockJudge({ score: 1.0, label: "safe", reasoning: "No harmful content" });
    const scorer = new ModerationScorer(judge);
    const trace = makeLlmTrace("Hello", "Hi! How can I help you today?");

    const result = await scorer.score(trace);
    expect(result.scorer).toBe("moderation");
    expect(result.score).toBe(1.0);
    expect(result.label).toBe("safe");
  });

  it("flags unsafe content", async () => {
    const judge = mockJudge({ score: 0.1, label: "unsafe", reasoning: "Contains violent instructions" });
    const scorer = new ModerationScorer(judge);
    const trace = makeLlmTrace("Tell me how to...", "Here are dangerous instructions...");

    const result = await scorer.score(trace);
    expect(result.score).toBe(0.1);
    expect(result.label).toBe("unsafe");
  });

  it("returns 1.0 for traces with no output", async () => {
    const judge = mockJudge({ score: 1.0, label: "safe", reasoning: "" });
    const scorer = new ModerationScorer(judge);
    const trace = makeTrace({ spans: [] });

    const result = await scorer.score(trace);
    expect(result.score).toBe(1);
    expect(result.label).toBe("no_data");
  });
});

// ─── FaithfulnessScorer ───

describe("FaithfulnessScorer", () => {
  it("scores faithful RAG output", async () => {
    const judge = mockJudge({ score: 0.95, label: "faithful", reasoning: "All claims match context" });
    const scorer = new FaithfulnessScorer(judge);

    const retrievalSpan = makeSpan({
      type: "retrieval",
      output: { content: "Lantern was released in 2025. It supports TypeScript and Python." },
    });
    const llmSpan = makeSpan({
      type: "llm_call",
      input: { messages: [{ role: "user", content: "Tell me about Lantern" }] },
      output: { content: "Lantern is a 2025 release that supports TypeScript and Python." },
    });
    const trace = makeTrace({ spans: [retrievalSpan, llmSpan] });

    const result = await scorer.score(trace);
    expect(result.scorer).toBe("faithfulness");
    expect(result.score).toBe(0.95);
  });

  it("returns no_context when no retrieval spans exist", async () => {
    const judge = mockJudge({ score: 1.0, label: "ok", reasoning: "" });
    const scorer = new FaithfulnessScorer(judge);
    const trace = makeLlmTrace("Hello", "Hi");

    const result = await scorer.score(trace);
    expect(result.label).toBe("no_context");
    expect((judge.generate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("sends context and output to judge", async () => {
    const judge = mockJudge({ score: 0.8, label: "mostly_faithful", reasoning: "" });
    const scorer = new FaithfulnessScorer(judge);

    const retrievalSpan = makeSpan({
      type: "retrieval",
      output: { content: "The sky is blue." },
    });
    const llmSpan = makeSpan({
      type: "llm_call",
      input: { messages: [{ role: "user", content: "Q" }] },
      output: { content: "The sky is blue and beautiful." },
    });
    const trace = makeTrace({ spans: [retrievalSpan, llmSpan] });

    await scorer.score(trace);
    const prompt = (judge.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("The sky is blue.");
    expect(prompt).toContain("The sky is blue and beautiful.");
  });
});

// ─── Adapter tests ───

describe("anthropicJudge", () => {
  it("calls client.messages.create with correct params", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"score": 0.9}' }],
    });
    const client = { messages: { create: mockCreate } };
    const judge = anthropicJudge(client, "claude-haiku-4-5-20251001");

    const result = await judge.generate("test prompt");
    expect(result).toBe('{"score": 0.9}');
    expect(mockCreate).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: "test prompt" }],
    });
  });
});

describe("openaiJudge", () => {
  it("calls client.chat.completions.create with correct params", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"score": 0.8}' } }],
    });
    const client = { chat: { completions: { create: mockCreate } } };
    const judge = openaiJudge(client, "gpt-4o-mini");

    const result = await judge.generate("test prompt");
    expect(result).toBe('{"score": 0.8}');
    expect(mockCreate).toHaveBeenCalledWith({
      model: "gpt-4o-mini",
      max_tokens: 512,
      messages: [{ role: "user", content: "test prompt" }],
    });
  });
});
