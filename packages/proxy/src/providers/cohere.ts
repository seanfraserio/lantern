/**
 * Cohere-specific request/response parsing for the LLM proxy.
 *
 * Handles the Cohere Chat API format:
 * - Request: { model, messages, stream?, ... }
 * - Response: { text, meta: { billedUnits: { inputTokens, outputTokens } }, finish_reason }
 * - SSE: data: { text, ... } ... data: [DONE]
 *
 * Key differences from OpenAI:
 * - Response content is at top-level `text` (not choices[0].message.content)
 * - Token counts are nested at meta.billedUnits.inputTokens/outputTokens
 */

import type { ProviderCapture } from "../types.js";

export const COHERE_BASE_URL = "https://api.cohere.com";

export type CohereCapture = ProviderCapture;

export function parseCohereRequest(body: unknown): {
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

export function parseCohereResponse(body: unknown): Partial<CohereCapture> {
  const b = body as Record<string, unknown>;
  const meta = b.meta as { billedUnits?: { inputTokens?: number; outputTokens?: number } } | undefined;

  return {
    model: (b.model as string) ?? undefined,
    outputContent: (b.text as string) ?? "",
    inputTokens: meta?.billedUnits?.inputTokens ?? 0,
    outputTokens: meta?.billedUnits?.outputTokens ?? 0,
    stopReason: (b.finish_reason as string) ?? null,
  };
}

/**
 * Parse accumulated SSE chunks from a Cohere streaming response.
 *
 * Cohere SSE events:
 * - data: { text, model, ... } — text generation chunks
 * - data: { meta: { billedUnits: { inputTokens, outputTokens } }, finish_reason } — final event
 * - data: [DONE]
 */
export function parseCohereSSEChunks(chunks: string[]): Partial<CohereCapture> {
  let model = "unknown";
  let outputContent = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;

  for (const chunk of chunks) {
    try {
      const parsed = JSON.parse(chunk) as Record<string, unknown>;

      if (parsed.model) model = parsed.model as string;

      // Text content from streaming chunks
      if (parsed.text) {
        outputContent += parsed.text as string;
      }

      // Finish reason
      if (parsed.finish_reason) {
        stopReason = parsed.finish_reason as string;
      }

      // Token usage from final event
      const meta = parsed.meta as { billedUnits?: { inputTokens?: number; outputTokens?: number } } | undefined;
      if (meta?.billedUnits) {
        if (meta.billedUnits.inputTokens) inputTokens = meta.billedUnits.inputTokens;
        if (meta.billedUnits.outputTokens) outputTokens = meta.billedUnits.outputTokens;
      }
    } catch {
      // Skip unparseable chunks (e.g. "[DONE]")
    }
  }

  return { model, outputContent, inputTokens, outputTokens, stopReason };
}

/**
 * Build the target URL for a Cohere API request.
 * Strips the /cohere prefix from the path.
 * Validates that the resulting path is safe (no traversal, must start with /v1/ or /v2/).
 */
export function buildCohereUrl(path: string): string {
  // /cohere/v1/chat -> /v1/chat
  const stripped = path.replace(/^\/cohere/, "");
  if (stripped.includes("..") || (!stripped.startsWith("/v1/") && !stripped.startsWith("/v2/"))) {
    throw new Error(`Invalid API path: ${stripped}`);
  }
  return `${COHERE_BASE_URL}${stripped}`;
}
