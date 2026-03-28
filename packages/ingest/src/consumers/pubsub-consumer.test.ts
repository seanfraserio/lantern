import { describe, it, expect, vi, beforeEach } from "vitest";
import { PubSubTraceConsumer } from "./pubsub-consumer.js";
import type { ITraceStore, Trace } from "@openlantern-ai/sdk";

function makeMockStore(): ITraceStore {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    getTrace: vi.fn().mockResolvedValue(null),
    queryTraces: vi.fn().mockResolvedValue([]),
    getTraceCount: vi.fn().mockResolvedValue(0),
    getSources: vi.fn().mockResolvedValue([]),
  };
}

function makeFakeTrace(overrides?: Partial<Trace>): Trace {
  return {
    id: "t1",
    sessionId: "s1",
    agentName: "test",
    environment: "test",
    startTime: Date.now(),
    status: "success",
    spans: [],
    metadata: {},
    totalInputTokens: 10,
    totalOutputTokens: 5,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

function makeMockMessage(data: unknown) {
  return {
    data: Buffer.from(JSON.stringify(data)),
    ack: vi.fn(),
    nack: vi.fn(),
    attributes: {},
  };
}

describe("PubSubTraceConsumer", () => {
  let store: ITraceStore;
  let consumer: PubSubTraceConsumer;

  beforeEach(() => {
    store = makeMockStore();
    consumer = new PubSubTraceConsumer({ store });
  });

  it("inserts traces and acks on success", async () => {
    const traces = [makeFakeTrace({ id: "t1" }), makeFakeTrace({ id: "t2" })];
    const msg = makeMockMessage({ traces });

    await consumer.handleMessage(msg as any);

    expect(store.insert).toHaveBeenCalledWith(traces);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nack).not.toHaveBeenCalled();
  });

  it("nacks on store insert failure (so Pub/Sub retries)", async () => {
    const traces = [makeFakeTrace()];
    const msg = makeMockMessage({ traces });

    (store.insert as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB down")
    );

    await consumer.handleMessage(msg as any);

    expect(store.insert).toHaveBeenCalledWith(traces);
    expect(msg.nack).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("nacks on invalid JSON", async () => {
    const msg = {
      data: Buffer.from("not valid json {{{"),
      ack: vi.fn(),
      nack: vi.fn(),
      attributes: {},
    };

    await consumer.handleMessage(msg as any);

    expect(msg.nack).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(store.insert).not.toHaveBeenCalled();
  });

  it("acks on empty traces array (valid payload, nothing to insert)", async () => {
    const msg = makeMockMessage({ traces: [] });

    await consumer.handleMessage(msg as any);

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nack).not.toHaveBeenCalled();
    expect(store.insert).not.toHaveBeenCalled();
  });

  it("calls onInsert callback after successful insert", async () => {
    const onInsert = vi.fn();
    consumer = new PubSubTraceConsumer({ store, onInsert });

    const traces = [makeFakeTrace({ id: "cb-trace" })];
    const msg = makeMockMessage({ traces });

    await consumer.handleMessage(msg as any);

    expect(onInsert).toHaveBeenCalledWith(traces);
    expect(msg.ack).toHaveBeenCalled();
  });

  it("does not call onInsert callback on store failure", async () => {
    const onInsert = vi.fn();
    consumer = new PubSubTraceConsumer({ store, onInsert });

    const traces = [makeFakeTrace()];
    const msg = makeMockMessage({ traces });

    (store.insert as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB down")
    );

    await consumer.handleMessage(msg as any);

    expect(onInsert).not.toHaveBeenCalled();
    expect(msg.nack).toHaveBeenCalled();
  });

  it("nacks when traces field is not an array", async () => {
    const msg = makeMockMessage({ traces: "not-an-array" });

    await consumer.handleMessage(msg as any);

    expect(msg.nack).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(store.insert).not.toHaveBeenCalled();
  });
});
