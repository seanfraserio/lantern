import { describe, it, expect } from "vitest";
import { RelevanceScorer } from "../scorers/relevance.js";
import { makeTrace, makeSpan, makeLlmTrace } from "./helpers.js";

describe("RelevanceScorer", () => {
  const scorer = new RelevanceScorer();

  it("has the name 'relevance'", () => {
    expect(scorer.name).toBe("relevance");
  });

  describe("scoring with valid input/output", () => {
    it("scores highly when output contains most input terms", async () => {
      // Input terms > 3 chars: "tell", "about", "machine", "learning", "algorithms"
      // Output contains: "machine", "learning", "algorithms" — but not "tell" or "about"
      const trace = makeLlmTrace(
        "Tell me about machine learning algorithms",
        "Machine learning algorithms are a branch of artificial intelligence that enables systems to learn from data.",
      );

      const result = await scorer.score(trace);
      expect(result.scorer).toBe("relevance");
      expect(result.score).toBeGreaterThanOrEqual(0.5);
      expect(["highly_relevant", "relevant"]).toContain(result.label);
    });

    it("scores 1.0 when ALL input terms appear in output", async () => {
      // Input terms > 3 chars: "dogs", "cats" (only 2 terms; "and" is 3 chars, filtered out)
      // Output must contain both "dogs" and "cats"
      const trace = makeLlmTrace(
        "dogs and cats",
        "I love dogs and cats very much.",
      );

      const result = await scorer.score(trace);
      expect(result.score).toBe(1.0);
      expect(result.label).toBe("highly_relevant");
    });

    it("scores partially when output shares some terms with input", async () => {
      const trace = makeLlmTrace(
        "Explain quantum computing architecture design",
        "Quantum computing uses qubits instead of classical bits.",
      );

      const result = await scorer.score(trace);
      expect(result.scorer).toBe("relevance");
      // "quantum" and "computing" match (4+ chars), "architecture" and "design" do not
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(1.0);
    });

    it("scores 0 when output shares no terms with input", async () => {
      const trace = makeLlmTrace(
        "Explain quantum computing",
        "The weather today is sunny and warm.",
      );

      const result = await scorer.score(trace);
      expect(result.scorer).toBe("relevance");
      expect(result.score).toBe(0);
      expect(result.label).toBe("not_relevant");
    });

    it("labels 'highly_relevant' for score >= 0.8", async () => {
      // All significant input terms appear in output
      const trace = makeLlmTrace(
        "machine learning",
        "Machine learning is transforming industries.",
      );

      const result = await scorer.score(trace);
      expect(result.score).toBeGreaterThanOrEqual(0.8);
      expect(result.label).toBe("highly_relevant");
    });

    it("labels 'not_relevant' for score < 0.2", async () => {
      const trace = makeLlmTrace(
        "astrophysics telescopes galaxies nebulae",
        "Cooking pasta requires boiling water.",
      );

      const result = await scorer.score(trace);
      expect(result.score).toBeLessThan(0.2);
      expect(result.label).toBe("not_relevant");
    });
  });

  describe("filtering short words", () => {
    it("ignores words with 3 or fewer characters", async () => {
      // "the", "cat", "sat", "on", "a", "mat" are all <= 3 chars except nothing
      // Actually "the" = 3, so all words here are <= 3 chars
      const trace = makeLlmTrace("the cat sat on a mat", "dogs run far");

      const result = await scorer.score(trace);
      // No input terms survive the filter (all <= 3 chars), so score = 0
      expect(result.score).toBe(0);
      expect(result.label).toBe("not_relevant");
    });
  });

  describe("multiple spans", () => {
    it("aggregates input/output across multiple LLM call spans", async () => {
      const span1 = makeSpan({
        type: "llm_call",
        input: { messages: [{ role: "user", content: "Explain databases" }] },
        output: { content: "Databases store data." },
      });
      const span2 = makeSpan({
        type: "llm_call",
        input: { messages: [{ role: "user", content: "Explain indexes" }] },
        output: { content: "Indexes speed up database queries using indexes." },
      });

      const trace = makeTrace({ spans: [span1, span2] });
      const result = await scorer.score(trace);

      // "databases" and "indexes" both appear in combined outputs
      expect(result.score).toBeGreaterThan(0);
    });

    it("only reads user role messages, not system messages", async () => {
      const span = makeSpan({
        type: "llm_call",
        input: {
          messages: [
            { role: "system", content: "You are a helpful astronomy expert." },
            { role: "user", content: "Tell me about stars" },
          ],
        },
        output: { content: "Stars are luminous celestial objects." },
      });

      const trace = makeTrace({ spans: [span] });
      const result = await scorer.score(trace);

      // Only "stars" from user message is considered (and "tell" is 4 chars)
      // "stars" appears in output
      expect(result.score).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("returns score 0 with label 'no_data' for trace with no spans", async () => {
      const trace = makeTrace({ spans: [] });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0);
      expect(result.label).toBe("no_data");
      expect(result.detail).toBe("No input/output spans found");
    });

    it("returns score 0 when spans have no LLM calls", async () => {
      const trace = makeTrace({
        spans: [
          makeSpan({ type: "tool_call", input: { args: {} }, output: { content: "result" } }),
        ],
      });

      const result = await scorer.score(trace);
      expect(result.score).toBe(0);
      expect(result.label).toBe("no_data");
    });

    it("returns score 0 when LLM span has no output", async () => {
      const span = makeSpan({
        type: "llm_call",
        input: { messages: [{ role: "user", content: "Hello world" }] },
        // no output
      });

      const trace = makeTrace({ spans: [span] });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0);
      expect(result.label).toBe("no_data");
    });

    it("returns score 0 when LLM span has no input messages", async () => {
      const span = makeSpan({
        type: "llm_call",
        input: { prompt: "just a prompt" },
        output: { content: "some response" },
      });

      const trace = makeTrace({ spans: [span] });
      const result = await scorer.score(trace);

      expect(result.score).toBe(0);
      expect(result.label).toBe("no_data");
    });

    it("handles empty string input and output", async () => {
      const trace = makeLlmTrace("", "");
      const result = await scorer.score(trace);

      // Empty input produces no terms -> score 0
      expect(result.score).toBe(0);
    });
  });
});
