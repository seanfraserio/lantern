import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerProxyRoutes } from "../proxy.js";

const INGEST_ENDPOINT = "http://ingest.test";

function makeAnthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    model: "claude-sonnet-4-5-20251001",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

function makeOpenAIResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
    model: "gpt-4o",
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    ...overrides,
  };
}

function makeResponseObj(body: unknown, status = 200) {
  const json = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    text: vi.fn().mockResolvedValue(json),
    body: null, // non-streaming
  };
}

describe("registerProxyRoutes — route matching", () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    app = Fastify({ logger: false });
    registerProxyRoutes(app, { ingestEndpoint: INGEST_ENDPOINT });
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("routes /anthropic/* to api.anthropic.com", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("anthropic.com")) return makeResponseObj(makeAnthropicResponse());
      return makeResponseObj({ accepted: 1 }); // ingest call
    });

    const res = await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      payload: {
        model: "claude-sonnet-4-5-20251001",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 100,
      },
    });

    expect(res.statusCode).toBe(200);
    const upstreamUrl = fetchMock.mock.calls[0][0] as string;
    expect(upstreamUrl).toContain("api.anthropic.com");
    expect(upstreamUrl).toContain("/v1/messages");
  });

  it("routes /openai/* to api.openai.com", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("openai.com")) return makeResponseObj(makeOpenAIResponse());
      return makeResponseObj({ accepted: 1 });
    });

    const res = await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const upstreamUrl = fetchMock.mock.calls[0][0] as string;
    expect(upstreamUrl).toContain("api.openai.com");
    expect(upstreamUrl).toContain("/v1/chat/completions");
  });

  it("routes via X-Lantern-Provider: openai header", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("openai.com")) return makeResponseObj(makeOpenAIResponse());
      return makeResponseObj({ accepted: 1 });
    });

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-lantern-provider": "openai" },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    });

    const upstreamUrl = fetchMock.mock.calls[0][0] as string;
    expect(upstreamUrl).toContain("api.openai.com");
  });

  it("routes via X-Lantern-Provider: anthropic header", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("anthropic.com")) return makeResponseObj(makeAnthropicResponse());
      return makeResponseObj({ accepted: 1 });
    });

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-lantern-provider": "anthropic" },
      payload: {
        model: "claude-sonnet-4-5-20251001",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 50,
      },
    });

    const upstreamUrl = fetchMock.mock.calls[0][0] as string;
    expect(upstreamUrl).toContain("api.anthropic.com");
  });

  it("returns 400 when provider cannot be determined", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/unknown/endpoint",
      payload: { model: "gpt-4", messages: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/provider/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("registerProxyRoutes — header stripping", () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    app = Fastify({ logger: false });
    registerProxyRoutes(app, { ingestEndpoint: INGEST_ENDPOINT });
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("strips all X-Lantern-* headers before forwarding to upstream", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("openai.com")) return makeResponseObj(makeOpenAIResponse());
      return makeResponseObj({ accepted: 1 });
    });

    await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: {
        "x-lantern-api-key": "lntn_secret",
        "x-lantern-service": "my-service",
        "x-lantern-custom-header": "should-be-gone",
        "authorization": "Bearer openai-key",
        "content-type": "application/json",
      },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    });

    // First call is to upstream openai.com
    const upstreamHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(upstreamHeaders["x-lantern-api-key"]).toBeUndefined();
    expect(upstreamHeaders["x-lantern-service"]).toBeUndefined();
    expect(upstreamHeaders["x-lantern-custom-header"]).toBeUndefined();
    // Real auth header should be forwarded
    expect(upstreamHeaders["authorization"]).toBe("Bearer openai-key");
  });

  it("strips host, connection, and transfer-encoding headers from upstream requests", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("openai.com")) return makeResponseObj(makeOpenAIResponse());
      return makeResponseObj({ accepted: 1 });
    });

    await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: {
        "authorization": "Bearer openai-key",
        "content-type": "application/json",
      },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    });

    const upstreamHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(upstreamHeaders["host"]).toBeUndefined();
    expect(upstreamHeaders["connection"]).toBeUndefined();
    expect(upstreamHeaders["transfer-encoding"]).toBeUndefined();
  });

  it("forwards non-Lantern headers to upstream", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("anthropic.com")) return makeResponseObj(makeAnthropicResponse());
      return makeResponseObj({ accepted: 1 });
    });

    await app.inject({
      method: "POST",
      url: "/anthropic/v1/messages",
      headers: {
        "x-api-key": "anthropic-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      payload: {
        model: "claude-sonnet-4-5-20251001",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 50,
      },
    });

    const upstreamHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(upstreamHeaders["x-api-key"]).toBe("anthropic-key");
    expect(upstreamHeaders["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("registerProxyRoutes — trace forwarding", () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    app = Fastify({ logger: false });
    registerProxyRoutes(app, { ingestEndpoint: INGEST_ENDPOINT });
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("sends trace to ingest endpoint after successful upstream call", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("openai.com")) return makeResponseObj(makeOpenAIResponse());
      return makeResponseObj({ accepted: 1 });
    });

    await app.inject({
      method: "POST",
      url: "/openai/v1/chat/completions",
      headers: { "authorization": "Bearer openai-key" },
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    });

    // Allow fire-and-forget to run
    await new Promise((r) => setTimeout(r, 20));

    // Second fetch call should be the ingest call
    const ingestCalls = fetchMock.mock.calls.filter(
      (call) => (call[0] as string).includes("ingest.test")
    );
    expect(ingestCalls.length).toBeGreaterThanOrEqual(1);
    const ingestBody = JSON.parse(ingestCalls[0][1].body as string);
    expect(ingestBody.traces).toHaveLength(1);
  });
});
