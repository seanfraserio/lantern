import { describe, it, expect } from "vitest";
import {
  parseOpenAIRequest,
  parseOpenAIResponse,
  parseOpenAISSEChunks,
  buildOpenAIUrl,
  OPENAI_BASE_URL,
} from "../../providers/openai.js";

describe("parseOpenAIRequest", () => {
  it("extracts model, messages, and stream flag", () => {
    const result = parseOpenAIRequest({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hi!" },
      ],
      stream: true,
    });
    expect(result.model).toBe("gpt-4o");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("system");
    expect(result.stream).toBe(true);
  });

  it("defaults model to 'unknown' when missing", () => {
    const result = parseOpenAIRequest({});
    expect(result.model).toBe("unknown");
  });

  it("defaults messages to empty array when missing", () => {
    const result = parseOpenAIRequest({ model: "gpt-4" });
    expect(result.messages).toEqual([]);
  });

  it("stream is undefined when not set", () => {
    const result = parseOpenAIRequest({ model: "gpt-4", messages: [] });
    expect(result.stream).toBeUndefined();
  });
});

describe("parseOpenAIResponse", () => {
  it("extracts content from first choice", () => {
    const result = parseOpenAIResponse({
      model: "gpt-4o",
      choices: [
        {
          message: { role: "assistant", content: "Hello from GPT!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.model).toBe("gpt-4o");
    expect(result.outputContent).toBe("Hello from GPT!");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(result.stopReason).toBe("stop");
  });

  it("returns empty string for null content", () => {
    const result = parseOpenAIResponse({
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    expect(result.outputContent).toBe("");
    expect(result.stopReason).toBe("tool_calls");
  });

  it("returns safe defaults for empty response", () => {
    const result = parseOpenAIResponse({});
    expect(result.outputContent).toBe("");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.stopReason).toBeNull();
  });

  it("uses completion_tokens for outputTokens", () => {
    const result = parseOpenAIResponse({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });
    expect(result.outputTokens).toBe(10);
    expect(result.inputTokens).toBe(20);
  });
});

describe("parseOpenAISSEChunks", () => {
  it("extracts model from first chunk", () => {
    const chunks = [
      JSON.stringify({
        model: "gpt-4o",
        choices: [{ delta: { content: "Hello" }, finish_reason: null }],
      }),
    ];
    const result = parseOpenAISSEChunks(chunks);
    expect(result.model).toBe("gpt-4o");
  });

  it("concatenates delta content across chunks", () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { content: "Hello " }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: "world!" }, finish_reason: "stop" }] }),
    ];
    const result = parseOpenAISSEChunks(chunks);
    expect(result.outputContent).toBe("Hello world!");
    expect(result.stopReason).toBe("stop");
  });

  it("extracts token usage from final chunk", () => {
    const chunks = [
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      }),
    ];
    const result = parseOpenAISSEChunks(chunks);
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(10);
  });

  it("silently skips unparseable chunks", () => {
    const chunks = ["not json", "[DONE]", "  "];
    expect(() => parseOpenAISSEChunks(chunks)).not.toThrow();
  });

  it("handles empty chunks array with safe defaults", () => {
    const result = parseOpenAISSEChunks([]);
    expect(result.model).toBe("unknown");
    expect(result.outputContent).toBe("");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("handles full streaming sequence", () => {
    const chunks = [
      JSON.stringify({ id: "1", model: "gpt-4o-mini", choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      JSON.stringify({ id: "2", model: "gpt-4o-mini", choices: [{ delta: { content: "Paris " }, finish_reason: null }] }),
      JSON.stringify({ id: "3", model: "gpt-4o-mini", choices: [{ delta: { content: "is the capital." }, finish_reason: "stop" }] }),
      JSON.stringify({ usage: { prompt_tokens: 15, completion_tokens: 8 }, choices: [] }),
    ];
    const result = parseOpenAISSEChunks(chunks);
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.outputContent).toBe("Paris is the capital.");
    expect(result.stopReason).toBe("stop");
    expect(result.inputTokens).toBe(15);
    expect(result.outputTokens).toBe(8);
  });
});

describe("buildOpenAIUrl", () => {
  it("strips /openai prefix and prepends base URL", () => {
    expect(buildOpenAIUrl("/openai/v1/chat/completions")).toBe(
      `${OPENAI_BASE_URL}/v1/chat/completions`
    );
  });

  it("handles embeddings endpoint", () => {
    expect(buildOpenAIUrl("/openai/v1/embeddings")).toBe(
      `${OPENAI_BASE_URL}/v1/embeddings`
    );
  });

  it("OPENAI_BASE_URL points to api.openai.com", () => {
    expect(OPENAI_BASE_URL).toBe("https://api.openai.com");
  });
});
