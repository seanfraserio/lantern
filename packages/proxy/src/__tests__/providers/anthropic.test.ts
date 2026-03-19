import { describe, it, expect } from "vitest";
import {
  parseAnthropicRequest,
  parseAnthropicResponse,
  parseAnthropicSSEChunks,
  buildAnthropicUrl,
  ANTHROPIC_BASE_URL,
} from "../../providers/anthropic.js";

describe("parseAnthropicRequest", () => {
  it("extracts model, messages, and stream flag", () => {
    const result = parseAnthropicRequest({
      model: "claude-sonnet-4-5-20251001",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      stream: true,
    });
    expect(result.model).toBe("claude-sonnet-4-5-20251001");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hi");
    expect(result.stream).toBe(true);
  });

  it("defaults model to 'unknown' when missing", () => {
    const result = parseAnthropicRequest({});
    expect(result.model).toBe("unknown");
  });

  it("defaults messages to empty array when missing", () => {
    const result = parseAnthropicRequest({ model: "claude-sonnet" });
    expect(result.messages).toEqual([]);
  });

  it("stream is undefined when not set", () => {
    const result = parseAnthropicRequest({ model: "m", messages: [] });
    expect(result.stream).toBeUndefined();
  });

  it("stream is false when explicitly set to false", () => {
    const result = parseAnthropicRequest({ model: "m", messages: [], stream: false });
    expect(result.stream).toBe(false);
  });
});

describe("parseAnthropicResponse", () => {
  it("extracts and concatenates text content blocks", () => {
    const result = parseAnthropicResponse({
      model: "claude-sonnet-4-5-20251001",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world!" },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
      stop_reason: "end_turn",
    });
    expect(result.model).toBe("claude-sonnet-4-5-20251001");
    expect(result.outputContent).toBe("Hello world!");
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(10);
    expect(result.stopReason).toBe("end_turn");
  });

  it("handles non-text content blocks gracefully", () => {
    const result = parseAnthropicResponse({
      content: [
        { type: "text", text: "Searching..." },
        { type: "tool_use", id: "t1", name: "search" }, // no text field
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    expect(result.outputContent).toBe("Searching...");
  });

  it("returns defaults for empty/missing response", () => {
    const result = parseAnthropicResponse({});
    expect(result.outputContent).toBe("");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.stopReason).toBeNull();
  });

  it("returns null stopReason when stop_reason is absent", () => {
    const result = parseAnthropicResponse({
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(result.stopReason).toBeNull();
  });
});

describe("parseAnthropicSSEChunks", () => {
  it("extracts model and input_tokens from message_start", () => {
    const chunks = [
      JSON.stringify({
        type: "message_start",
        message: {
          model: "claude-haiku-4-5-20251001",
          usage: { input_tokens: 15 },
        },
      }),
    ];
    const result = parseAnthropicSSEChunks(chunks);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.inputTokens).toBe(15);
  });

  it("concatenates text from content_block_delta events", () => {
    const chunks = [
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "world!" } }),
    ];
    const result = parseAnthropicSSEChunks(chunks);
    expect(result.outputContent).toBe("Hello world!");
  });

  it("extracts stop_reason and output_tokens from message_delta", () => {
    const chunks = [
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 25 },
      }),
    ];
    const result = parseAnthropicSSEChunks(chunks);
    expect(result.stopReason).toBe("end_turn");
    expect(result.outputTokens).toBe(25);
  });

  it("silently skips unparseable chunks", () => {
    const chunks = ["not valid json", "[DONE]", "{}"];
    expect(() => parseAnthropicSSEChunks(chunks)).not.toThrow();
  });

  it("handles empty chunks array with safe defaults", () => {
    const result = parseAnthropicSSEChunks([]);
    expect(result.model).toBe("unknown");
    expect(result.outputContent).toBe("");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.stopReason).toBeNull();
  });

  it("handles a full stream sequence", () => {
    const chunks = [
      JSON.stringify({ type: "message_start", message: { model: "claude-opus-4-5-20251001", usage: { input_tokens: 50 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The answer " } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "is 42." } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const result = parseAnthropicSSEChunks(chunks);
    expect(result.model).toBe("claude-opus-4-5-20251001");
    expect(result.outputContent).toBe("The answer is 42.");
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(10);
    expect(result.stopReason).toBe("end_turn");
  });
});

describe("buildAnthropicUrl", () => {
  it("strips /anthropic prefix and prepends base URL", () => {
    expect(buildAnthropicUrl("/anthropic/v1/messages")).toBe(
      `${ANTHROPIC_BASE_URL}/v1/messages`
    );
  });

  it("handles paths with multiple segments", () => {
    expect(buildAnthropicUrl("/anthropic/v1/messages/count_tokens")).toBe(
      `${ANTHROPIC_BASE_URL}/v1/messages/count_tokens`
    );
  });

  it("rejects paths with traversal sequences", () => {
    expect(() => buildAnthropicUrl("/anthropic/v1/../../../etc/passwd")).toThrow("Invalid API path");
  });

  it("rejects paths that do not start with /v1/", () => {
    expect(() => buildAnthropicUrl("/anthropic/admin/keys")).toThrow("Invalid API path");
  });

  it("ANTHROPIC_BASE_URL points to api.anthropic.com", () => {
    expect(ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });
});
