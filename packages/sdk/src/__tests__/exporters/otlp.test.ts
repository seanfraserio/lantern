import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OtlpExporter } from "../../exporters/otlp.js";
import type { Trace, Span } from "../../types.js";

// ─── Helpers ───

function makeSpan(overrides?: Partial<Span>): Span {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    traceId: "11111111-2222-3333-4444-555555555555",
    type: "llm_call",
    startTime: 1700000000000,
    endTime: 1700000001000,
    durationMs: 1000,
    input: { prompt: "Hello" },
    model: "gpt-4o",
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.005,
    ...overrides,
  };
}

function makeTrace(overrides?: Partial<Trace>): Trace {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    agentName: "test-agent",
    environment: "test",
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    durationMs: 1000,
    status: "success",
    spans: [],
    metadata: {},
    totalInputTokens: 100,
    totalOutputTokens: 50,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

/** Parse the OTLP JSON body from the fetch mock. */
function parseBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

// ─── Tests ───

describe("OtlpExporter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Construction ──

  describe("construction", () => {
    it("has exporterType of 'otlp'", () => {
      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      expect(exporter.exporterType).toBe("otlp");
    });

    it("strips trailing slash from endpoint", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318/" });
      await exporter.export([makeTrace({ spans: [makeSpan()] })]);

      expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4318/v1/traces");
    });

    it("uses /v1/traces path", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "https://otel.example.com" });
      await exporter.export([makeTrace({ spans: [makeSpan()] })]);

      expect(fetchMock.mock.calls[0][0]).toBe("https://otel.example.com/v1/traces");
    });
  });

  // ── Headers ──

  describe("headers", () => {
    it("sends Content-Type application/json by default", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan()] })]);

      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("includes custom headers", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({
        endpoint: "http://localhost:4318",
        headers: {
          Authorization: "Basic abc123",
          "X-Custom": "value",
        },
      });
      await exporter.export([makeTrace({ spans: [makeSpan()] })]);

      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers.Authorization).toBe("Basic abc123");
      expect(headers["X-Custom"]).toBe("value");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("defaults to empty headers when none configured", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan()] })]);

      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      // Only Content-Type should be present
      expect(Object.keys(headers)).toEqual(["Content-Type"]);
    });
  });

  // ── buildExportRequest (tested via body inspection) ──

  describe("buildExportRequest — OTLP JSON structure", () => {
    it("produces valid resourceSpans envelope", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ agentName: "my-agent", spans: [makeSpan()] })]);

      const body = parseBody(fetchMock);
      expect(body).toHaveProperty("resourceSpans");
      expect(body.resourceSpans).toHaveLength(1);

      const rs = body.resourceSpans[0];
      // resource.attributes contains service.name
      expect(rs.resource.attributes).toEqual([
        { key: "service.name", value: { stringValue: "my-agent" } },
      ]);
    });

    it("includes scopeSpans with SDK name and version", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan()] })]);

      const body = parseBody(fetchMock);
      const scopeSpans = body.resourceSpans[0].scopeSpans;
      expect(scopeSpans).toHaveLength(1);
      expect(scopeSpans[0].scope.name).toBe("@lantern-ai/sdk");
      expect(typeof scopeSpans[0].scope.version).toBe("string");
      expect(scopeSpans[0].scope.version.length).toBeGreaterThan(0);
    });

    it("maps multiple traces to multiple resourceSpans", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([
        makeTrace({ agentName: "agent-a", spans: [makeSpan()] }),
        makeTrace({ agentName: "agent-b", spans: [makeSpan()] }),
      ]);

      const body = parseBody(fetchMock);
      expect(body.resourceSpans).toHaveLength(2);
      expect(body.resourceSpans[0].resource.attributes[0].value.stringValue).toBe("agent-a");
      expect(body.resourceSpans[1].resource.attributes[0].value.stringValue).toBe("agent-b");
    });
  });

  // ── convertSpan (tested via body inspection) ──

  describe("convertSpan — span conversion", () => {
    it("converts traceId and spanId from UUID to hex", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        traceId: "11111111-2222-3333-4444-555555555555",
      });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      // traceId: 32 hex chars (UUID dashes removed, first 32 chars)
      expect(otlpSpan.traceId).toBe("11111111222233334444555555555555");
      // spanId: 16 hex chars (UUID dashes removed, first 16 chars)
      expect(otlpSpan.spanId).toBe("aaaaaaaabbbbcccc");
    });

    it("converts parentSpanId when present", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({
        parentSpanId: "ffffffff-aaaa-bbbb-cccc-dddddddddddd",
      });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.parentSpanId).toBe("ffffffffaaaabbbb");
    });

    it("omits parentSpanId when not present", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ parentSpanId: undefined });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.parentSpanId).toBeUndefined();
    });

    it("sets span name to type for llm_call", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ type: "llm_call", toolName: undefined });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.name).toBe("llm_call");
    });

    it("appends toolName to span name when present", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ type: "tool_call", toolName: "web_search" });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.name).toBe("tool_call web_search");
    });

    it("converts times to nanosecond strings", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({
        startTime: 1700000000000,
        endTime: 1700000001000,
      });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      // startTime * 1_000_000 = 1700000000000000000
      expect(otlpSpan.startTimeUnixNano).toBe("1700000000000000000");
      expect(otlpSpan.endTimeUnixNano).toBe("1700000001000000000");
    });

    it("uses startTime as endTime when endTime is undefined", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({
        startTime: 1700000000000,
        endTime: undefined,
      });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.startTimeUnixNano).toBe("1700000000000000000");
      expect(otlpSpan.endTimeUnixNano).toBe("1700000000000000000");
    });

    it("includes model attribute as stringValue", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ model: "claude-3-opus" });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      const modelAttr = otlpSpan.attributes.find((a: { key: string }) => a.key === "model");
      expect(modelAttr).toEqual({ key: "model", value: { stringValue: "claude-3-opus" } });
    });

    it("includes token counts as intValues", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ inputTokens: 200, outputTokens: 100 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      const inputAttr = otlpSpan.attributes.find((a: { key: string }) => a.key === "inputTokens");
      const outputAttr = otlpSpan.attributes.find((a: { key: string }) => a.key === "outputTokens");
      expect(inputAttr).toEqual({ key: "inputTokens", value: { intValue: "200" } });
      expect(outputAttr).toEqual({ key: "outputTokens", value: { intValue: "100" } });
    });

    it("includes estimatedCostUsd as doubleValue", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ estimatedCostUsd: 0.0035 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      const costAttr = otlpSpan.attributes.find(
        (a: { key: string }) => a.key === "estimatedCostUsd"
      );
      expect(costAttr).toEqual({ key: "estimatedCostUsd", value: { doubleValue: 0.0035 } });
    });

    it("includes toolName attribute when present", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ toolName: "calculator" });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      const toolAttr = otlpSpan.attributes.find((a: { key: string }) => a.key === "toolName");
      expect(toolAttr).toEqual({ key: "toolName", value: { stringValue: "calculator" } });
    });

    it("omits undefined attributes", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({
        model: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        estimatedCostUsd: undefined,
        toolName: undefined,
      });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.attributes).toEqual([]);
    });

    it("sets status OK (code 1) for completed span without error", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ endTime: Date.now(), error: undefined });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.status).toEqual({ code: 1 });
    });

    it("sets status ERROR (code 2) with message for errored span", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ error: "Rate limit exceeded" });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.status).toEqual({ code: 2, message: "Rate limit exceeded" });
    });

    it("sets status UNSET (code 0) for span without endTime or error", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span = makeSpan({ endTime: undefined, error: undefined });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.status).toEqual({ code: 0 });
    });

    it("converts multiple spans within a single trace", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const span1 = makeSpan({ id: "aaaaaaaa-0001-0000-0000-000000000000", type: "llm_call" });
      const span2 = makeSpan({ id: "aaaaaaaa-0002-0000-0000-000000000000", type: "tool_call", toolName: "search" });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [span1, span2] })]);

      const spans = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans;
      expect(spans).toHaveLength(2);
      expect(spans[0].name).toBe("llm_call");
      expect(spans[1].name).toBe("tool_call search");
    });
  });

  // ── spanKind (tested via body inspection) ──

  describe("spanKind — type to OTLP kind mapping", () => {
    it("maps llm_call to CLIENT (3)", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan({ type: "llm_call" })] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.kind).toBe(3);
    });

    it("maps tool_call to CLIENT (3)", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan({ type: "tool_call" })] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.kind).toBe(3);
    });

    it("maps retrieval to CLIENT (3)", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan({ type: "retrieval" })] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.kind).toBe(3);
    });

    it("maps reasoning_step to INTERNAL (1)", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan({ type: "reasoning_step" })] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.kind).toBe(1);
    });

    it("maps custom to INTERNAL (1)", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan({ type: "custom" })] })]);

      const otlpSpan = parseBody(fetchMock).resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.kind).toBe(1);
    });
  });

  // ── export() behavior ──

  describe("export() — fetch behavior", () => {
    it("sends POST request", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan()] })]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("does nothing when traces array is empty", async () => {
      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends all traces in a single request", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      const traces = [
        makeTrace({ spans: [makeSpan()] }),
        makeTrace({ spans: [makeSpan()] }),
        makeTrace({ spans: [makeSpan()] }),
      ];
      await exporter.export(traces);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = parseBody(fetchMock);
      expect(body.resourceSpans).toHaveLength(3);
    });

    it("body is valid JSON", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await exporter.export([makeTrace({ spans: [makeSpan()] })]);

      const rawBody = fetchMock.mock.calls[0][1].body as string;
      expect(() => JSON.parse(rawBody)).not.toThrow();
    });
  });

  // ── Error handling ──

  describe("error handling", () => {
    it("throws on non-OK response with status code in message", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: vi.fn().mockResolvedValue("Invalid credentials"),
      });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await expect(exporter.export([makeTrace({ spans: [makeSpan()] })])).rejects.toThrow(
        "OTLP export failed: 401 Unauthorized - Invalid credentials"
      );
    });

    it("throws on 500 server error", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: vi.fn().mockResolvedValue(""),
      });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await expect(exporter.export([makeTrace({ spans: [makeSpan()] })])).rejects.toThrow(
        "OTLP export failed: 500 Internal Server Error"
      );
    });

    it("handles response.text() rejection gracefully", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: vi.fn().mockRejectedValue(new Error("stream error")),
      });

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await expect(exporter.export([makeTrace({ spans: [makeSpan()] })])).rejects.toThrow(
        "OTLP export failed: 502 Bad Gateway - "
      );
    });

    it("propagates fetch network errors", async () => {
      fetchMock.mockRejectedValue(new Error("Network unreachable"));

      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await expect(exporter.export([makeTrace({ spans: [makeSpan()] })])).rejects.toThrow(
        "Network unreachable"
      );
    });
  });

  // ── shutdown ──

  describe("shutdown", () => {
    it("resolves without error", async () => {
      const exporter = new OtlpExporter({ endpoint: "http://localhost:4318" });
      await expect(exporter.shutdown()).resolves.toBeUndefined();
    });
  });
});
