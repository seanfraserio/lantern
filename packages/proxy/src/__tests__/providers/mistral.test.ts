import { describe, it, expect } from "vitest";
import {
  parseMistralRequest,
  parseMistralResponse,
  parseMistralSSEChunks,
  buildMistralUrl,
  MISTRAL_BASE_URL,
} from "../../providers/mistral.js";

describe("parseMistralRequest", () => {
  it("extracts model, messages, and stream flag", () => {
    const result = parseMistralRequest({
      model: "mistral-large-latest",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hi!" },
      ],
      stream: true,
    });
    expect(result.model).toBe("mistral-large-latest");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("system");
    expect(result.stream).toBe(true);
  });

  it("defaults model to 'unknown' when missing", () => {
    const result = parseMistralRequest({});
    expect(result.model).toBe("unknown");
  });

  it("defaults messages to empty array when missing", () => {
    const result = parseMistralRequest({ model: "mistral-small-latest" });
    expect(result.messages).toEqual([]);
  });

  it("stream is undefined when not set", () => {
    const result = parseMistralRequest({ model: "mistral-large-latest", messages: [] });
    expect(result.stream).toBeUndefined();
  });
});

describe("parseMistralResponse", () => {
  it("extracts content and camelCase token counts", () => {
    const result = parseMistralResponse({
      model: "mistral-large-latest",
      choices: [
        {
          message: { role: "assistant", content: "Hello from Mistral!" },
          finish_reason: "stop",
        },
      ],
      usage: { promptTokens: 12, completionTokens: 7 },
    });
    expect(result.model).toBe("mistral-large-latest");
    expect(result.outputContent).toBe("Hello from Mistral!");
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(7);
    expect(result.stopReason).toBe("stop");
  });

  it("returns empty string for null content", () => {
    const result = parseMistralResponse({
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "tool_calls" }],
      usage: { promptTokens: 10, completionTokens: 0 },
    });
    expect(result.outputContent).toBe("");
    expect(result.stopReason).toBe("tool_calls");
  });

  it("returns safe defaults for empty response", () => {
    const result = parseMistralResponse({});
    expect(result.outputContent).toBe("");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.stopReason).toBeNull();
  });

  it("uses completionTokens (camelCase) for outputTokens", () => {
    const result = parseMistralResponse({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { promptTokens: 20, completionTokens: 10 },
    });
    expect(result.outputTokens).toBe(10);
    expect(result.inputTokens).toBe(20);
  });
});

describe("parseMistralSSEChunks", () => {
  it("extracts model from first chunk", () => {
    const chunks = [
      JSON.stringify({
        model: "mistral-large-latest",
        choices: [{ delta: { content: "Hello" }, finish_reason: null }],
      }),
    ];
    const result = parseMistralSSEChunks(chunks);
    expect(result.model).toBe("mistral-large-latest");
  });

  it("concatenates delta content across chunks", () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { content: "Hello " }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: "world!" }, finish_reason: "stop" }] }),
    ];
    const result = parseMistralSSEChunks(chunks);
    expect(result.outputContent).toBe("Hello world!");
    expect(result.stopReason).toBe("stop");
  });

  it("extracts camelCase token usage from final chunk", () => {
    const chunks = [
      JSON.stringify({
        choices: [],
        usage: { promptTokens: 20, completionTokens: 10 },
      }),
    ];
    const result = parseMistralSSEChunks(chunks);
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(10);
  });

  it("silently skips unparseable chunks", () => {
    const chunks = ["not json", "[DONE]", "  "];
    expect(() => parseMistralSSEChunks(chunks)).not.toThrow();
  });

  it("handles empty chunks array with safe defaults", () => {
    const result = parseMistralSSEChunks([]);
    expect(result.model).toBe("unknown");
    expect(result.outputContent).toBe("");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("handles full streaming sequence", () => {
    const chunks = [
      JSON.stringify({ id: "1", model: "mistral-small-latest", choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      JSON.stringify({ id: "2", model: "mistral-small-latest", choices: [{ delta: { content: "Paris " }, finish_reason: null }] }),
      JSON.stringify({ id: "3", model: "mistral-small-latest", choices: [{ delta: { content: "is the capital." }, finish_reason: "stop" }] }),
      JSON.stringify({ usage: { promptTokens: 15, completionTokens: 8 }, choices: [] }),
    ];
    const result = parseMistralSSEChunks(chunks);
    expect(result.model).toBe("mistral-small-latest");
    expect(result.outputContent).toBe("Paris is the capital.");
    expect(result.stopReason).toBe("stop");
    expect(result.inputTokens).toBe(15);
    expect(result.outputTokens).toBe(8);
  });
});

describe("buildMistralUrl", () => {
  it("strips /mistral prefix and prepends base URL", () => {
    expect(buildMistralUrl("/mistral/v1/chat/completions")).toBe(
      `${MISTRAL_BASE_URL}/v1/chat/completions`
    );
  });

  it("handles embeddings endpoint", () => {
    expect(buildMistralUrl("/mistral/v1/embeddings")).toBe(
      `${MISTRAL_BASE_URL}/v1/embeddings`
    );
  });

  it("rejects paths with traversal sequences", () => {
    expect(() => buildMistralUrl("/mistral/v1/../../../etc/passwd")).toThrow("Invalid API path");
  });

  it("rejects paths that do not start with /v1/", () => {
    expect(() => buildMistralUrl("/mistral/admin/keys")).toThrow("Invalid API path");
  });

  it("MISTRAL_BASE_URL points to api.mistral.ai", () => {
    expect(MISTRAL_BASE_URL).toBe("https://api.mistral.ai");
  });
});
