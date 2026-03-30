/**
 * Core proxy logic for the Lantern LLM Proxy.
 *
 * Handles:
 * 1. Path-based routing: /anthropic/*, /openai/*, /mistral/*, /cohere/* -> respective APIs
 * 2. X-Lantern-Provider header as metadata override (not routing)
 * 3. Non-streaming: buffer response, parse, build trace, fire-and-forget to ingest
 * 4. Streaming (SSE): pipe through to client, collect chunks in background, trace after stream ends
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { parseProviderRequest } from "./providers/shared.js";
import {
  parseAnthropicResponse,
  parseAnthropicSSEChunks,
  buildAnthropicUrl,
} from "./providers/anthropic.js";
import {
  parseOpenAIResponse,
  parseOpenAISSEChunks,
  buildOpenAIUrl,
} from "./providers/openai.js";
import {
  parseMistralResponse,
  parseMistralSSEChunks,
  buildMistralUrl,
} from "./providers/mistral.js";
import {
  parseCohereResponse,
  parseCohereSSEChunks,
  buildCohereUrl,
} from "./providers/cohere.js";
import { buildTrace } from "./trace-builder.js";
import type { ProviderName } from "./types.js";

/**
 * Subset of ProviderName that the Lantern proxy currently handles at runtime.
 * The full ProviderName union is broader for data compatibility across the trilogy.
 */
type SupportedProvider = Extract<ProviderName, "anthropic" | "openai" | "mistral" | "cohere">;

interface ProxyContext {
  ingestEndpoint: string;
}

/**
 * Determine the provider from the URL path or X-Lantern-Provider header.
 */
function resolveProvider(path: string): SupportedProvider | null {
  if (path.startsWith("/anthropic/")) return "anthropic";
  if (path.startsWith("/openai/")) return "openai";
  if (path.startsWith("/mistral/")) return "mistral";
  if (path.startsWith("/cohere/")) return "cohere";

  return null;
}

/**
 * Build the target URL for the upstream LLM API.
 */
function buildTargetUrl(provider: SupportedProvider, path: string): string {
  if (provider === "anthropic") return buildAnthropicUrl(path);
  if (provider === "mistral") return buildMistralUrl(path);
  if (provider === "cohere") return buildCohereUrl(path);
  return buildOpenAIUrl(path);
}

/**
 * Parse the request body. All providers use the same request format.
 */
function parseRequest(_provider: SupportedProvider, body: unknown) {
  return parseProviderRequest(body);
}

/**
 * Parse a non-streaming response body based on provider format.
 */
function parseResponse(provider: SupportedProvider, body: unknown) {
  if (provider === "anthropic") return parseAnthropicResponse(body);
  if (provider === "mistral") return parseMistralResponse(body);
  if (provider === "cohere") return parseCohereResponse(body);
  return parseOpenAIResponse(body);
}

/**
 * Parse accumulated SSE chunks based on provider format.
 */
function parseSSEChunks(provider: SupportedProvider, chunks: string[]) {
  if (provider === "anthropic") return parseAnthropicSSEChunks(chunks);
  if (provider === "mistral") return parseMistralSSEChunks(chunks);
  if (provider === "cohere") return parseCohereSSEChunks(chunks);
  return parseOpenAISSEChunks(chunks);
}

const STRIP_RESPONSE_HEADERS = new Set([
  "x-api-key",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "set-cookie",
  "server",
]);

const HOP_BY_HOP_HEADERS = new Set(["transfer-encoding", "connection"]);

/**
 * Allowlist of request headers to forward to upstream LLM APIs.
 * Only these headers are forwarded — everything else is stripped.
 */
const ALLOWED_REQUEST_HEADERS = new Set([
  "authorization",
  "content-type",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "openai-organization",
  "openai-project",
]);

/**
 * Forward response headers from the upstream response to the client reply,
 * stripping hop-by-hop and sensitive headers.
 */
function forwardResponseHeaders(upstreamResponse: Response, reply: FastifyReply): void {
  for (const [key, value] of upstreamResponse.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (STRIP_RESPONSE_HEADERS.has(lower)) continue;
    reply.header(key, value);
  }
}

/**
 * Build upstream headers from the incoming request.
 * Uses an allowlist to only forward recognized, safe headers.
 */
function buildUpstreamHeaders(incomingHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
  const upstream: Record<string, string> = {};

  for (const [key, value] of Object.entries(incomingHeaders)) {
    const lower = key.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(lower)) continue;

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
  provider: SupportedProvider,
  targetUrl: string,
  upstreamHeaders: Record<string, string>,
  requestBody: unknown,
  parsedRequest: ReturnType<typeof parseRequest>,
  lanternApiKey: string | undefined,
  serviceName: string | undefined,
  providerOverride: string | undefined,
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
  forwardResponseHeaders(upstreamResponse, reply);

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
        providerOverride,
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
      providerOverride,
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
  provider: SupportedProvider,
  targetUrl: string,
  upstreamHeaders: Record<string, string>,
  requestBody: unknown,
  parsedRequest: ReturnType<typeof parseRequest>,
  lanternApiKey: string | undefined,
  serviceName: string | undefined,
  providerOverride: string | undefined,
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
    forwardResponseHeaders(upstreamResponse, reply);

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
      providerOverride,
    });
    sendTrace(ctx.ingestEndpoint, trace, lanternApiKey, request.log);

    reply.send(responseBody);
    return;
  }

  // Forward SSE headers to the client
  reply.status(upstreamResponse.status);
  forwardResponseHeaders(upstreamResponse, reply);

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
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done ?? false;
        const value = result.value;
        if (done || !value) break;

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
        providerOverride,
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
  // Routes via path prefix: /anthropic/*, /openai/*, /mistral/*, /cohere/*.
  app.all("/*", async (request, reply) => {
    const path = request.url;
    const headers = request.headers as Record<string, string | string[] | undefined>;

    // Resolve provider
    const provider = resolveProvider(path);
    if (!provider) {
      return reply.status(400).send({
        error: "Could not determine LLM provider. Use path prefix: /anthropic/, /openai/, /mistral/, or /cohere/.",
      });
    }

    // Extract Lantern-specific headers
    const lanternApiKeyHeader = headers["x-lantern-api-key"];
    const lanternApiKey = Array.isArray(lanternApiKeyHeader) ? lanternApiKeyHeader[0] : lanternApiKeyHeader;

    const serviceNameHeader = headers["x-lantern-service"];
    const serviceName = Array.isArray(serviceNameHeader) ? serviceNameHeader[0] : serviceNameHeader;

    // X-Lantern-Provider is now metadata-only (provider override for trace)
    const providerOverrideHeader = headers["x-lantern-provider"];
    const providerOverride = Array.isArray(providerOverrideHeader) ? providerOverrideHeader[0] : providerOverrideHeader;

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
        providerOverride,
        ctx,
        request,
        reply,
      );
    }

    return handleNonStreaming(
      provider,
      targetUrl,
      upstreamHeaders,
      requestBody,
      parsedRequest,
      lanternApiKey,
      serviceName,
      providerOverride,
      ctx,
      request,
      reply,
    );
  });
}
