import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternExporter } from "../../exporters/lantern.js";
import type { Trace } from "../../types.js";

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

describe("LanternExporter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has exporterType of 'lantern'", () => {
    const exporter = new LanternExporter({ endpoint: "http://localhost:3001" });
    expect(exporter.exporterType).toBe("lantern");
  });

  it("sends POST to /v1/traces with correct Content-Type", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const exporter = new LanternExporter({ endpoint: "http://localhost:3001" });
    const trace = makeTrace();
    await exporter.export([trace]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/v1/traces",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      })
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0].id).toBe(trace.id);
  });

  it("includes Authorization header when apiKey is set", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const exporter = new LanternExporter({
      endpoint: "https://ingest.lantern.dev",
      apiKey: "lntn_secret_key",
    });
    await exporter.export([makeTrace()]);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer lntn_secret_key");
  });

  it("does not include Authorization header without apiKey", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const exporter = new LanternExporter({ endpoint: "http://localhost:3001" });
    await exporter.export([makeTrace()]);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("does nothing when traces array is empty", async () => {
    const exporter = new LanternExporter({ endpoint: "http://localhost:3001" });
    await exporter.export([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips trailing slash from endpoint", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const exporter = new LanternExporter({ endpoint: "http://localhost:3001/" });
    await exporter.export([makeTrace()]);

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3001/v1/traces");
  });

  it("batches multiple traces in a single POST request", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const exporter = new LanternExporter({ endpoint: "http://localhost:3001" });
    const traces = [makeTrace(), makeTrace(), makeTrace()];
    await exporter.export(traces);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.traces).toHaveLength(3);
  });

  it("throws on non-5xx error responses without retrying", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: vi.fn().mockResolvedValue("Invalid API key"),
    });

    const exporter = new LanternExporter({
      endpoint: "http://localhost:3001",
      maxRetries: 0,
    });
    await expect(exporter.export([makeTrace()])).rejects.toThrow("401");
  });

  it("throws on 400 Bad Request without retrying", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: vi.fn().mockResolvedValue("Validation error"),
    });

    const exporter = new LanternExporter({
      endpoint: "http://localhost:3001",
      maxRetries: 0,
    });
    await expect(exporter.export([makeTrace()])).rejects.toThrow("400");
  });

  it("shutdown resolves without error", async () => {
    const exporter = new LanternExporter({ endpoint: "http://localhost:3001" });
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });
});
