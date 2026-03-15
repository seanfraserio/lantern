/**
 * Core proxy logic for the Lantern LLM Proxy.
 *
 * Handles:
 * 1. Path-based routing: /anthropic/* -> api.anthropic.com, /openai/* -> api.openai.com
 * 2. Header-based routing: X-Lantern-Provider header
 * 3. Non-streaming: buffer response, parse, build trace, fire-and-forget to ingest
 * 4. Streaming (SSE): pipe through to client, collect chunks in background, trace after stream ends
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  parseAnthropicRequest,
  parseAnthropicResponse,
  parseAnthropicSSEChunks,
  buildAnthropicUrl,
} from "./providers/anthropic.js";
import {
  parseOpenAIRequest,
  parseOpenAIResponse,
  parseOpenAISSEChunks,
  buildOpenAIUrl,
} from "./providers/openai.js";
import { buildTrace } from "./trace-builder.js";
import type { Readable } from "node:stream";

type Provider = "anthropic" | "openai";

interface ProxyContext {
  ingestEndpoint: string;
}

/**
 * Determine the provider from the URL path or X-Lantern-Provider header.
 */
function resolveProvider(path: string, headers: Record<string, string | string[] | undefined>): Provider | null {
  if (path.startsWith("/anthropic/")) return "anthropic";
  if (path.startsWith("/openai/")) return "openai";

  const headerVal = headers["x-lantern-provider"];
  const providerHeader = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (providerHeader === "anthropic" || providerHeader === "openai") return providerHeader;

  return null;
}

/**
 * Build the target URL for the upstream LLM API.
 */
function buildTargetUrl(provider: Provider, path: string): string {
  if (provider === "anthropic") return buildAnthropicUrl(path);
  return buildOpenAIUrl(path);
}

/**
 * Parse the request body based on provider format.
 */
function parseRequest(provider: Provider, body: unknown) {
  if (provider === "anthropic") return parseAnthropicRequest(body);
  return parseOpenAIRequest(body);
}

/**
 * Parse a non-streaming response body based on provider format.
 */
function parseResponse(provider: Provider, body: unknown) {
  if (provider === "anthropic") return parseAnthropicResponse(body);
  return parseOpenAIResponse(body);
}

/**
 * Parse accumulated SSE chunks based on provider format.
 */
function parseSSEChunks(provider: Provider, chunks: string[]) {
  if (provider === "anthropic") return parseAnthropicSSEChunks(chunks);
  return parseOpenAISSEChunks(chunks);
}

/**
 * Build upstream headers from the incoming request.
 * Strips all X-Lantern-* headers so they don't leak to the upstream API.
 */
function buildUpstreamHeaders(incomingHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
  const upstream: Record<string, string> = {};

  for (const [key, value] of Object.entries(incomingHeaders)) {
    // Skip Lantern-specific headers
    if (key.toLowerCase().startsWith("x-lantern-")) continue;
    // Skip hop-by-hop headers
    if (key.toLowerCase() === "host") continue;
    if (key.toLowerCase() === "connection") continue;
    if (key.toLowerCase() === "transfer-encoding") continue;
    // Skip content-length since we re-serialize the body
    if (key.toLowerCase() === "content-length") continue;

    if (value !== undefined) {
      upstream[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }

  return upstream;
}

/**
 * Send a trace to the Lantern ingest endpoint (fire-and-forget).
 */
function sendTrace(
  ingestEndpoint: string,
  trace: ReturnType<typeof buildTrace>,
  lanternApiKey: string | undefined,
  logger: FastifyRequest["log"],
): void {
  const url = `${ingestEndpoint}/v1/traces`;
  const payload = JSON.stringify({ traces: [trace] });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (lanternApiKey) {
    headers["Authorization"] = `Bearer ${lanternApiKey}`;
  }

  fetch(url, {
    method: "POST",
    headers,
    body: payload,
  }).catch((err) => {
    logger.warn({ err, traceId: trace.id }, "Failed to send trace to ingest");
  });
}

/**
 * Extract SSE data payloads from a text buffer.
 * Each SSE line looks like: "data: {...json...}\n"
 * Returns the JSON strings (without the "data: " prefix).
 */
function extractSSEData(text: string): string[] {
  const results: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data && data !== "[DONE]") {
        results.push(data);
      }
    }
  }
  return results;
}

/**
 * Handle a non-streaming proxy request.
 */
async function handleNonStreaming(
  provider: Provider,
  targetUrl: string,
  upstreamHeaders: Record<string, string>,
  requestBody: unknown,
  parsedRequest: ReturnType<typeof parseRequest>,
  lanternApiKey: string | undefined,
  serviceName: string | undefined,
  ctx: ProxyContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const startTime = performance.now();

  const upstreamResponse = await fetch(targetUrl, {
    method: "POST",
    headers: {
      ...upstreamHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const responseBody = await upstreamResponse.text();
  const durationMs = Math.round(performance.now() - startTime);

  // Forward the response status and headers to the client
  reply.status(upstreamResponse.status);
  for (const [key, value] of upstreamResponse.headers.entries()) {
    // Skip hop-by-hop headers
    if (key.toLowerCase() === "transfer-encoding") continue;
    if (key.toLowerCase() === "connection") continue;
    reply.header(key, value);
  }

  // Parse response and build trace (only for successful responses)
  if (upstreamResponse.ok) {
    try {
      const parsedResponseBody = JSON.parse(responseBody);
      const parsedResponse = parseResponse(provider, parsedResponseBody);

      const trace = buildTrace({
        provider,
        model: parsedResponse.model ?? parsedRequest.model,
        inputMessages: parsedRequest.messages,
        outputContent: parsedResponse.outputContent ?? "",
        inputTokens: parsedResponse.inputTokens ?? 0,
        outputTokens: parsedResponse.outputTokens ?? 0,
        durationMs,
        stopReason: parsedResponse.stopReason,
        serviceName,
      });

      sendTrace(ctx.ingestEndpoint, trace, lanternApiKey, request.log);
    } catch (err) {
      request.log.warn({ err }, "Failed to parse upstream response for tracing");
    }
  } else {
    // Trace errors too
    const trace = buildTrace({
      provider,
      model: parsedRequest.model,
      inputMessages: parsedRequest.messages,
      outputContent: "",
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      error: `HTTP ${upstreamResponse.status}: ${responseBody.slice(0, 500)}`,
      serviceName,
    });
    sendTrace(ctx.ingestEndpoint, trace, lanternApiKey, request.log);
  }

  reply.send(responseBody);
}

/**
 * Handle a streaming (SSE) proxy request.
 * Pipes the SSE response through to the client while collecting chunks
 * in the background. After the stream ends, builds and sends the trace.
 */
async function handleStreaming(
  provider: Provider,
  targetUrl: string,
  upstreamHeaders: Record<string, string>,
  requestBody: unknown,
  parsedRequest: ReturnType<typeof parseRequest>,
  lanternApiKey: string | undefined,
  serviceName: string | undefined,
  ctx: ProxyContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const startTime = performance.now();

  const upstreamResponse = await fetch(targetUrl, {
    method: "POST",
    headers: {
      ...upstreamHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    // Not a streaming response or error -- fall back to non-streaming handling
    const responseBody = await upstreamResponse.text();
    const durationMs = Math.round(performance.now() - startTime);

    reply.status(upstreamResponse.status);
    for (const [key, value] of upstreamResponse.headers.entries()) {
      if (key.toLowerCase() === "transfer-encoding") continue;
      if (key.toLowerCase() === "connection") continue;
      reply.header(key, value);
    }

    const trace = buildTrace({
      provider,
      model: parsedRequest.model,
      inputMessages: parsedRequest.messages,
      outputContent: "",
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      error: `HTTP ${upstreamResponse.status}: ${responseBody.slice(0, 500)}`,
      serviceName,
    });
    sendTrace(ctx.ingestEndpoint, trace, lanternApiKey, request.log);

    reply.send(responseBody);
    return;
  }

  // Forward SSE headers to the client
  reply.status(upstreamResponse.status);
  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (key.toLowerCase() === "transfer-encoding") continue;
    if (key.toLowerCase() === "connection") continue;
    reply.header(key, value);
  }

  // Pipe the stream through to the client while collecting SSE data
  const collectedChunks: string[] = [];
  const decoder = new TextDecoder();
  const reader = (upstreamResponse.body as ReadableStream<Uint8Array>).getReader();
  const { Readable } = await import("node:stream");

  const passthrough = new Readable({
    read() {},
  });

  // Send the passthrough stream as the reply
  reply.send(passthrough);

  // Read chunks from the upstream and push to both the client and our collector
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Push to the client
        passthrough.push(value);

        // Collect for trace building
        const text = decoder.decode(value, { stream: true });
        const dataChunks = extractSSEData(text);
        collectedChunks.push(...dataChunks);
      }
    } catch (err) {
      request.log.warn({ err }, "Error reading upstream SSE stream");
    } finally {
      // Signal end of stream to the client
      passthrough.push(null);

      // Build and send trace after stream completes
      const durationMs = Math.round(performance.now() - startTime);
      const parsedSSE = parseSSEChunks(provider, collectedChunks);

      const trace = buildTrace({
        provider,
        model: parsedSSE.model ?? parsedRequest.model,
        inputMessages: parsedRequest.messages,
        outputContent: parsedSSE.outputContent ?? "",
        inputTokens: parsedSSE.inputTokens ?? 0,
        outputTokens: parsedSSE.outputTokens ?? 0,
        durationMs,
        stopReason: parsedSSE.stopReason,
        serviceName,
      });

      sendTrace(ctx.ingestEndpoint, trace, lanternApiKey, request.log);
    }
  })();
}

/**
 * Register all proxy routes on the Fastify instance.
 */
export function registerProxyRoutes(app: FastifyInstance, ctx: ProxyContext): void {
  // Catch-all route for proxy requests.
  // Matches both path-based (/anthropic/*, /openai/*) and header-based routing.
  app.all("/*", async (request, reply) => {
    const path = request.url;
    const headers = request.headers as Record<string, string | string[] | undefined>;

    // Resolve provider
    const provider = resolveProvider(path, headers);
    if (!provider) {
      return reply.status(400).send({
        error: "Could not determine LLM provider. Use path prefix (/anthropic/ or /openai/) or X-Lantern-Provider header.",
      });
    }

    // Extract Lantern-specific headers
    const lanternApiKeyHeader = headers["x-lantern-api-key"];
    const lanternApiKey = Array.isArray(lanternApiKeyHeader) ? lanternApiKeyHeader[0] : lanternApiKeyHeader;

    const serviceNameHeader = headers["x-lantern-service"];
    const serviceName = Array.isArray(serviceNameHeader) ? serviceNameHeader[0] : serviceNameHeader;

    // Build the target URL
    const targetUrl = buildTargetUrl(provider, path);

    // Build upstream headers (strips X-Lantern-* headers)
    const upstreamHeaders = buildUpstreamHeaders(headers);

    // Parse the request body
    const requestBody = request.body;
    const parsedRequest = parseRequest(provider, requestBody);

    // Determine if this is a streaming request
    const isStreaming = parsedRequest.stream === true;

    if (isStreaming) {
      return handleStreaming(
        provider,
        targetUrl,
        upstreamHeaders,
        requestBody,
        parsedRequest,
        lanternApiKey,
        serviceName,
        ctx,
        request,
        reply,
      );
    } else {
      return handleNonStreaming(
        provider,
        targetUrl,
        upstreamHeaders,
        requestBody,
        parsedRequest,
        lanternApiKey,
        serviceName,
        ctx,
        request,
        reply,
      );
    }
  });
}
