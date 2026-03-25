/**
 * Anthropic-specific request/response parsing for the LLM proxy.
 *
 * Handles the Anthropic Messages API format:
 * - Request: { model, messages, system?, stream?, max_tokens, ... }
 * - Response: { content: [{ type, text }], usage: { input_tokens, output_tokens }, stop_reason }
 * - SSE events: message_start, content_block_start, content_block_delta, message_delta, message_stop
 */

import type { ProviderCapture } from "../types.js";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export type AnthropicCapture = ProviderCapture;

export function parseAnthropicRequest(body: unknown): {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
} {
  const b = body as Record<string, unknown>;
  return {
    model: (b.model as string) ?? "unknown",
    messages: (b.messages as Array<{ role: string; content: string }>) ?? [],
    stream: b.stream as boolean | undefined,
  };
}

export function parseAnthropicResponse(body: unknown): Partial<AnthropicCapture> {
  const b = body as Record<string, unknown>;
  const content = b.content as Array<{ type: string; text?: string }> | undefined;
  const usage = b.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    model: (b.model as string) ?? undefined,
    outputContent: content?.map((c) => c.text ?? "").join("") ?? "",
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    stopReason: (b.stop_reason as string) ?? null,
  };
}

/**
 * Parse accumulated SSE chunks from an Anthropic streaming response.
 *
 * Anthropic SSE events:
 * - message_start: contains the initial message object with model, usage.input_tokens
 * - content_block_delta: contains delta.text
 * - message_delta: contains stop_reason and usage.output_tokens
 * - message_stop: signals stream end
 */
export function parseAnthropicSSEChunks(chunks: string[]): Partial<AnthropicCapture> {
  let model = "unknown";
  let outputContent = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;

  for (const chunk of chunks) {
    try {
      const parsed = JSON.parse(chunk) as Record<string, unknown>;
      const type = parsed.type as string;

      if (type === "message_start") {
        const message = parsed.message as Record<string, unknown> | undefined;
        if (message) {
          model = (message.model as string) ?? model;
          const usage = message.usage as { input_tokens?: number } | undefined;
          if (usage?.input_tokens) inputTokens = usage.input_tokens;
        }
      } else if (type === "content_block_delta") {
        const delta = parsed.delta as { type?: string; text?: string } | undefined;
        if (delta?.text) outputContent += delta.text;
      } else if (type === "message_delta") {
        const delta = parsed.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        const usage = parsed.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens) outputTokens = usage.output_tokens;
      }
    } catch {
      // Skip unparseable chunks
    }
  }

  return { model, outputContent, inputTokens, outputTokens, stopReason };
}

/**
 * Build the target URL for an Anthropic API request.
 * Strips the /anthropic prefix from the path.
 * Validates that the resulting path is safe (no traversal, must start with /v1/).
 */
export function buildAnthropicUrl(path: string): string {
  // /anthropic/v1/messages -> /v1/messages
  const stripped = path.replace(/^\/anthropic/, "");
  if (stripped.includes("..") || !stripped.startsWith("/v1/")) {
    throw new Error(`Invalid API path: ${stripped}`);
  }
  return `${ANTHROPIC_BASE_URL}${stripped}`;
}
