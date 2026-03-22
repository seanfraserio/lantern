/**
 * Mistral-specific request/response parsing for the LLM proxy.
 *
 * Handles the Mistral Chat Completions API format:
 * - Request: { model, messages, stream?, ... }
 * - Response: { choices: [{ message: { content } }], usage: { promptTokens, completionTokens } }
 * - SSE: data: { choices: [{ delta: { content } }] } ... data: [DONE]
 *
 * Key difference from OpenAI: Mistral uses camelCase for token counts
 * (promptTokens/completionTokens) instead of snake_case.
 */

export const MISTRAL_BASE_URL = "https://api.mistral.ai";

export interface MistralCapture {
  model: string;
  inputMessages: Array<{ role: string; content: string }>;
  outputContent: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export function parseMistralRequest(body: unknown): {
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

export function parseMistralResponse(body: unknown): Partial<MistralCapture> {
  const b = body as Record<string, unknown>;
  const choices = b.choices as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined;
  const usage = b.usage as { promptTokens?: number; completionTokens?: number } | undefined;

  const firstChoice = choices?.[0];
  return {
    model: (b.model as string) ?? undefined,
    outputContent: firstChoice?.message?.content ?? "",
    inputTokens: usage?.promptTokens ?? 0,
    outputTokens: usage?.completionTokens ?? 0,
    stopReason: firstChoice?.finish_reason ?? null,
  };
}

/**
 * Parse accumulated SSE chunks from a Mistral streaming response.
 *
 * Mistral SSE events follow the same structure as OpenAI but with camelCase token fields:
 * - data: { choices: [{ delta: { content } }], model }
 * - data: { usage: { promptTokens, completionTokens } }
 * - data: [DONE]
 */
export function parseMistralSSEChunks(chunks: string[]): Partial<MistralCapture> {
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

      const usage = parsed.usage as { promptTokens?: number; completionTokens?: number } | undefined;
      if (usage) {
        if (usage.promptTokens) inputTokens = usage.promptTokens;
        if (usage.completionTokens) outputTokens = usage.completionTokens;
      }
    } catch {
      // Skip unparseable chunks (e.g. "[DONE]")
    }
  }

  return { model, outputContent, inputTokens, outputTokens, stopReason };
}

/**
 * Build the target URL for a Mistral API request.
 * Strips the /mistral prefix from the path.
 * Validates that the resulting path is safe (no traversal, must start with /v1/).
 */
export function buildMistralUrl(path: string): string {
  // /mistral/v1/chat/completions -> /v1/chat/completions
  const stripped = path.replace(/^\/mistral/, "");
  if (stripped.includes("..") || !stripped.startsWith("/v1/")) {
    throw new Error(`Invalid API path: ${stripped}`);
  }
  return `${MISTRAL_BASE_URL}${stripped}`;
}
