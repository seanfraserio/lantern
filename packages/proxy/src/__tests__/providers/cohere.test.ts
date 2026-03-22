import { describe, it, expect } from "vitest";
import {
  parseCohereRequest,
  parseCohereResponse,
  parseCohereSSEChunks,
  buildCohereUrl,
  COHERE_BASE_URL,
} from "../../providers/cohere.js";

describe("parseCohereRequest", () => {
  it("extracts model, messages, and stream flag", () => {
    const result = parseCohereRequest({
      model: "command-r-plus",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hi!" },
      ],
      stream: true,
    });
    expect(result.model).toBe("command-r-plus");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("system");
    expect(result.stream).toBe(true);
  });

  it("defaults model to 'unknown' when missing", () => {
    const result = parseCohereRequest({});
    expect(result.model).toBe("unknown");
  });

  it("defaults messages to empty array when missing", () => {
    const result = parseCohereRequest({ model: "command-r" });
    expect(result.messages).toEqual([]);
  });

  it("stream is undefined when not set", () => {
    const result = parseCohereRequest({ model: "command-r-plus", messages: [] });
    expect(result.stream).toBeUndefined();
  });
});

describe("parseCohereResponse", () => {
  it("extracts text content and billedUnits token counts", () => {
    const result = parseCohereResponse({
      model: "command-r-plus",
      text: "Hello from Cohere!",
      finish_reason: "COMPLETE",
      meta: {
        billedUnits: { inputTokens: 15, outputTokens: 6 },
      },
    });
    expect(result.model).toBe("command-r-plus");
    expect(result.outputContent).toBe("Hello from Cohere!");
    expect(result.inputTokens).toBe(15);
    expect(result.outputTokens).toBe(6);
    expect(result.stopReason).toBe("COMPLETE");
  });

  it("returns empty string when text is missing", () => {
    const result = parseCohereResponse({
      finish_reason: "MAX_TOKENS",
      meta: { billedUnits: { inputTokens: 10, outputTokens: 0 } },
    });
    expect(result.outputContent).toBe("");
    expect(result.stopReason).toBe("MAX_TOKENS");
  });

  it("returns safe defaults for empty response", () => {
    const result = parseCohereResponse({});
    expect(result.outputContent).toBe("");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.stopReason).toBeNull();
  });

  it("handles response with meta but no billedUnits", () => {
    const result = parseCohereResponse({
      text: "ok",
      meta: {},
    });
    expect(result.outputContent).toBe("ok");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("reads token counts from meta.billedUnits", () => {
    const result = parseCohereResponse({
      text: "ok",
      finish_reason: "COMPLETE",
      meta: { billedUnits: { inputTokens: 25, outputTokens: 12 } },
    });
    expect(result.inputTokens).toBe(25);
    expect(result.outputTokens).toBe(12);
  });
});

describe("parseCohereSSEChunks", () => {
  it("extracts model from chunk", () => {
    const chunks = [
      JSON.stringify({
        model: "command-r-plus",
        text: "Hello",
      }),
    ];
    const result = parseCohereSSEChunks(chunks);
    expect(result.model).toBe("command-r-plus");
  });

  it("concatenates text content across chunks", () => {
    const chunks = [
      JSON.stringify({ text: "Hello " }),
      JSON.stringify({ text: "world!", finish_reason: "COMPLETE" }),
    ];
    const result = parseCohereSSEChunks(chunks);
    expect(result.outputContent).toBe("Hello world!");
    expect(result.stopReason).toBe("COMPLETE");
  });

  it("extracts billedUnits token usage from final chunk", () => {
    const chunks = [
      JSON.stringify({
        meta: { billedUnits: { inputTokens: 20, outputTokens: 10 } },
      }),
    ];
    const result = parseCohereSSEChunks(chunks);
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(10);
  });

  it("silently skips unparseable chunks", () => {
    const chunks = ["not json", "[DONE]", "  "];
    expect(() => parseCohereSSEChunks(chunks)).not.toThrow();
  });

  it("handles empty chunks array with safe defaults", () => {
    const result = parseCohereSSEChunks([]);
    expect(result.model).toBe("unknown");
    expect(result.outputContent).toBe("");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("handles full streaming sequence", () => {
    const chunks = [
      JSON.stringify({ model: "command-r", text: "The " }),
      JSON.stringify({ model: "command-r", text: "capital is Paris." }),
      JSON.stringify({ finish_reason: "COMPLETE", meta: { billedUnits: { inputTokens: 15, outputTokens: 8 } } }),
    ];
    const result = parseCohereSSEChunks(chunks);
    expect(result.model).toBe("command-r");
    expect(result.outputContent).toBe("The capital is Paris.");
    expect(result.stopReason).toBe("COMPLETE");
    expect(result.inputTokens).toBe(15);
    expect(result.outputTokens).toBe(8);
  });
});

describe("buildCohereUrl", () => {
  it("strips /cohere prefix and prepends base URL", () => {
    expect(buildCohereUrl("/cohere/v1/chat")).toBe(
      `${COHERE_BASE_URL}/v1/chat`
    );
  });

  it("handles v2 endpoints", () => {
    expect(buildCohereUrl("/cohere/v2/chat")).toBe(
      `${COHERE_BASE_URL}/v2/chat`
    );
  });

  it("handles embeddings endpoint", () => {
    expect(buildCohereUrl("/cohere/v1/embed")).toBe(
      `${COHERE_BASE_URL}/v1/embed`
    );
  });

  it("rejects paths with traversal sequences", () => {
    expect(() => buildCohereUrl("/cohere/v1/../../../etc/passwd")).toThrow("Invalid API path");
  });

  it("rejects paths that do not start with /v1/ or /v2/", () => {
    expect(() => buildCohereUrl("/cohere/admin/keys")).toThrow("Invalid API path");
  });

  it("COHERE_BASE_URL points to api.cohere.com", () => {
    expect(COHERE_BASE_URL).toBe("https://api.cohere.com");
  });
});
