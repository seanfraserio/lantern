import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Trace } from "../../types.js";

// ─── Mock @google-cloud/pubsub ───
// Must be hoisted before the dynamic import of the module under test.

const mockPublishMessage = vi.fn();
const mockFlush = vi.fn();
const mockClose = vi.fn();
const mockTopic = vi.fn().mockReturnValue({
  publishMessage: mockPublishMessage,
  flush: mockFlush,
});

vi.mock("@google-cloud/pubsub", () => ({
  PubSub: vi.fn().mockImplementation(() => ({
    topic: mockTopic,
    close: mockClose,
  })),
}));

// Import AFTER the mock is set up.
const { PubSubExporter } = await import("../../exporters/pubsub.js");

// ─── Helpers ───

function makeTrace(overrides?: Partial<Trace>): Trace {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    agentName: "test-agent",
    environment: "production",
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

// ─── Tests ───

describe("PubSubExporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishMessage.mockResolvedValue("msg-id-123");
    mockFlush.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  // ── exporterType ──

  it("has exporterType of 'pubsub'", () => {
    const exporter = new PubSubExporter({ topicName: "lantern-traces" });
    expect(exporter.exporterType).toBe("pubsub");
  });

  // ── JSON serialization ──

  it("publishes traces serialized as JSON batch", async () => {
    const exporter = new PubSubExporter({ topicName: "lantern-traces" });
    const traces = [makeTrace(), makeTrace()];
    await exporter.export(traces);

    expect(mockPublishMessage).toHaveBeenCalledTimes(1);
    const call = mockPublishMessage.mock.calls[0][0];
    const payload = JSON.parse(call.data.toString("utf8"));
    expect(payload.traces).toHaveLength(2);
    expect(payload.traces[0].id).toBe(traces[0].id);
    expect(payload.traces[1].id).toBe(traces[1].id);
  });

  // ── Ordering key ──

  it("sets orderingKey to agentName of first trace", async () => {
    const exporter = new PubSubExporter({ topicName: "lantern-traces" });
    const traces = [
      makeTrace({ agentName: "my-agent" }),
      makeTrace({ agentName: "other-agent" }),
    ];
    await exporter.export(traces);

    const call = mockPublishMessage.mock.calls[0][0];
    expect(call.orderingKey).toBe("my-agent");
  });

  it("sets orderingKey to undefined when traces array is empty", async () => {
    const exporter = new PubSubExporter({ topicName: "lantern-traces" });
    await exporter.export([]);

    const call = mockPublishMessage.mock.calls[0][0];
    expect(call.orderingKey).toBeUndefined();
  });

  // ── Attributes ──

  it("includes agentName, environment, and traceCount in attributes", async () => {
    const exporter = new PubSubExporter({ topicName: "lantern-traces" });
    const traces = [
      makeTrace({ agentName: "billing-agent", environment: "staging" }),
      makeTrace({ agentName: "billing-agent", environment: "staging" }),
    ];
    await exporter.export(traces);

    const { attributes } = mockPublishMessage.mock.calls[0][0];
    expect(attributes.agentName).toBe("billing-agent");
    expect(attributes.environment).toBe("staging");
    expect(attributes.traceCount).toBe("2");
  });

  it("includes tenantId in attributes when provided", async () => {
    const exporter = new PubSubExporter({
      topicName: "lantern-traces",
      tenantId: "tenant-abc",
    });
    await exporter.export([makeTrace()]);

    const { attributes } = mockPublishMessage.mock.calls[0][0];
    expect(attributes.tenantId).toBe("tenant-abc");
  });

  it("omits tenantId from attributes when not provided", async () => {
    const exporter = new PubSubExporter({ topicName: "lantern-traces" });
    await exporter.export([makeTrace()]);

    const { attributes } = mockPublishMessage.mock.calls[0][0];
    expect(attributes.tenantId).toBeUndefined();
  });

  // ── Topic resolution ──

  it("resolves the topic by name from the config", async () => {
    const exporter = new PubSubExporter({ topicName: "my-custom-topic" });
    await exporter.export([makeTrace()]);

    expect(mockTopic).toHaveBeenCalledWith("my-custom-topic");
  });

  // ── Shutdown ──

  it("calls flush then close on shutdown", async () => {
    const exporter = new PubSubExporter({ topicName: "lantern-traces" });
    await exporter.shutdown();

    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);

    // flush must be called before close
    const flushOrder = mockFlush.mock.invocationCallOrder[0];
    const closeOrder = mockClose.mock.invocationCallOrder[0];
    expect(flushOrder).toBeLessThan(closeOrder);
  });

  // ── Error propagation ──

  it("throws when publishMessage rejects", async () => {
    mockPublishMessage.mockRejectedValue(new Error("Pub/Sub unavailable"));

    const exporter = new PubSubExporter({ topicName: "lantern-traces" });
    await expect(exporter.export([makeTrace()])).rejects.toThrow("Pub/Sub unavailable");
  });
});
