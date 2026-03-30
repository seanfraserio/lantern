/**
 * OpenAI-specific request/response parsing for the LLM proxy.
 *
 * Handles the OpenAI Chat Completions API format:
 * - Request: { model, messages, stream?, stream_options?, ... }
 * - Response: { choices: [{ message: { content } }], usage: { prompt_tokens, completion_tokens } }
 * - SSE: data: { choices: [{ delta: { content } }] } ... data: [DONE]
 */

import type { ProviderCapture } from "../types.js";
import { parseProviderRequest, createUrlBuilder } from "./shared.js";

export const OPENAI_BASE_URL = "https://api.openai.com";

export type OpenAICapture = ProviderCapture;

export const parseOpenAIRequest = parseProviderRequest;

export function parseOpenAIResponse(body: unknown): Partial<OpenAICapture> {
  const b = body as Record<string, unknown>;
  const choices = b.choices as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined;
  const usage = b.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;

  const firstChoice = choices?.[0];
  return {
    model: (b.model as string) ?? undefined,
    outputContent: firstChoice?.message?.content ?? "",
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    stopReason: firstChoice?.finish_reason ?? null,
  };
}

/**
 * Parse accumulated SSE chunks from an OpenAI streaming response.
 *
 * OpenAI SSE events:
 * - data: { choices: [{ delta: { content } }], model }
 * - data: { usage: { prompt_tokens, completion_tokens } }  (when stream_options.include_usage = true)
 * - data: [DONE]
 */
export function parseOpenAISSEChunks(chunks: string[]): Partial<OpenAICapture> {
  let model = "unknown";
  let outputContent = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;

  for (const chunk of chunks) {
    try {
      const parsed = JSON.parse(chunk) as Record<string, unknown>;

      if (parsed.model) model = parsed.model as string;

      const choices = parsed.choices as Array<{
        delta?: { content?: string };
        finish_reason?: string | null;
      }> | undefined;

      if (choices?.[0]) {
        const choice = choices[0];
        if (choice.delta?.content) outputContent += choice.delta.content;
        if (choice.finish_reason) stopReason = choice.finish_reason;
      }

      // Usage is included in the final chunk when stream_options.include_usage is set
      const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage) {
        if (usage.prompt_tokens) inputTokens = usage.prompt_tokens;
        if (usage.completion_tokens) outputTokens = usage.completion_tokens;
      }
    } catch {
      // Skip unparseable chunks (e.g. "[DONE]")
    }
  }

  return { model, outputContent, inputTokens, outputTokens, stopReason };
}

/**
 * Build the target URL for an OpenAI API request.
 * Strips the /openai prefix from the path.
 * Validates that the resulting path is safe (no traversal, must start with /v1/).
 */
export const buildOpenAIUrl = createUrlBuilder({
  pathPrefix: "/openai",
  baseUrl: OPENAI_BASE_URL,
  allowedPrefixes: ["/v1/"],
});
