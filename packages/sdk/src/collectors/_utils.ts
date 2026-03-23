import type { LanternTracer } from "../tracer.js";
import type { SpanType, SpanOutput } from "../types.js";

// ─── Token Normalization ───

const INPUT_TOKEN_FIELDS = ["input_tokens", "prompt_tokens", "promptTokens", "promptTokenCount"];
const OUTPUT_TOKEN_FIELDS = ["output_tokens", "completion_tokens", "completionTokens", "candidatesTokenCount"];

function findField(obj: Record<string, unknown>, fields: string[]): number {
  for (const f of fields) {
    if (typeof obj[f] === "number") return obj[f] as number;
  }
  return 0;
}

export function normalizeTokens(raw: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: findField(raw, INPUT_TOKEN_FIELDS),
    outputTokens: findField(raw, OUTPUT_TOKEN_FIELDS),
  };
}

// ─── Pricing ───

interface PricePer1K {
  input: number;
  output: number;
}

const DEFAULT_PRICING: PricePer1K = { input: 0.001, output: 0.002 };

/**
 * Pricing in USD per 1K tokens (NOT per 1M).
 * Provider pricing pages typically quote per-1M — divide by 1000 before adding here.
 * Example: Claude Sonnet at $3/1M input → 0.003 per 1K.
 * Keys can be exact model IDs or provider:model for provider-specific pricing.
 * Last verified: 2026-03-21.
 */
const MODEL_PRICING: Record<string, PricePer1K> = {
  // Claude
  "claude-opus-4-6": { input: 0.015, output: 0.075 },
  "claude-sonnet-4-6": { input: 0.003, output: 0.015 },
  "claude-haiku-4-5": { input: 0.0008, output: 0.004 },
  // Legacy Claude IDs (keep for existing traces)
  "claude-sonnet-4-5-20251001": { input: 0.003, output: 0.015 },
  "claude-haiku-4-5-20251001": { input: 0.0008, output: 0.004 },
  "claude-opus-4-5-20251001": { input: 0.015, output: 0.075 },
  // GPT
  "gpt-4o": { input: 0.005, output: 0.015 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-4.1": { input: 0.002, output: 0.008 },
  "gpt-4.1-mini": { input: 0.0004, output: 0.0016 },
  "gpt-4.1-nano": { input: 0.0001, output: 0.0004 },
  "o3": { input: 0.01, output: 0.04 },
  "o4-mini": { input: 0.001, output: 0.004 },
  // Gemini
  "gemini-2.0-flash": { input: 0.0001, output: 0.0004 },
  "gemini-2.5-pro": { input: 0.00125, output: 0.01 },
  "gemini-2.5-flash": { input: 0.00015, output: 0.0035 },
  // Mistral
  "mistral-large-latest": { input: 0.002, output: 0.006 },
  "mistral-small-latest": { input: 0.0002, output: 0.0006 },
  "codestral-latest": { input: 0.0003, output: 0.0009 },
  // Cohere
  "command-r-plus": { input: 0.003, output: 0.015 },
  "command-r": { input: 0.0005, output: 0.0015 },
  // Llama (via Groq or others)
  "llama-3.1-70b": { input: 0.00059, output: 0.00079 },
  "llama-3.1-8b": { input: 0.00005, output: 0.00008 },
  "llama-4-scout": { input: 0.00015, output: 0.0006 },
  "llama-4-maverick": { input: 0.0005, output: 0.0015 },
  // DeepSeek
  "deepseek-chat": { input: 0.00014, output: 0.00028 },
  "deepseek-reasoner": { input: 0.00055, output: 0.00219 },
  // Groq-specific model IDs
  "groq:llama-3.1-70b-versatile": { input: 0.00059, output: 0.00079 },
  "groq:llama-3.1-8b-instant": { input: 0.00005, output: 0.00008 },
  "groq:mixtral-8x7b-32768": { input: 0.00024, output: 0.00024 },
};

/**
 * Look up pricing for a model. Tries exact match first, then substring match.
 * If provider is given, tries provider:model first.
 */
export function getPricing(model: string, provider?: string): PricePer1K {
  // Try provider-scoped exact match
  if (provider) {
    const scoped = MODEL_PRICING[`${provider}:${model}`];
    if (scoped) return scoped;
  }

  // Try exact match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Try substring match (e.g., "gpt-4o-2024-08-06" matches "gpt-4o")
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (!key.includes(":") && model.startsWith(key)) return price;
  }

  return DEFAULT_PRICING;
}

// ─── Message Normalization ───

export function normalizeMessages(messages: unknown[]): Array<{ role: string; content: string }> {
  return messages.map((m) => {
    const msg = m as Record<string, unknown>;
    const role = String(msg.role ?? "unknown");
    const content = msg.content;

    if (typeof content === "string") return { role, content };

    if (Array.isArray(content)) {
      const text = content
        .map((block: unknown) => {
          const b = block as Record<string, unknown>;
          if (b.text && typeof b.text === "string") return b.text;
          return JSON.stringify(b);
        })
        .join("");
      return { role, content: text };
    }

    return { role, content: content != null ? String(content) : "" };
  });
}

// ─── Span Input Builder ───

export function buildSpanInput(params: Record<string, unknown>): string {
  return JSON.stringify(params, null, 0);
}

// ─── Trace Lifecycle Wrapper ───

export interface WrapOpts {
  tracer: LanternTracer;
  traceId?: string;
  agentName?: string;
  spanType: SpanType;
  model?: string;
  provider?: string;
  buildInput: (params: unknown) => string;
  extractTokens: (response: unknown) => { inputTokens: number; outputTokens: number };
  extractOutput: (response: unknown) => string;
}

export async function wrapWithTrace<T>(opts: WrapOpts, fn: () => Promise<T>): Promise<T> {
  let traceId = opts.traceId;
  let ownTrace = false;
  if (!traceId) {
    const trace = opts.tracer.startTrace({
      agentName: opts.agentName ?? "lantern-agent",
      metadata: opts.provider ? { provider: opts.provider } : undefined,
    });
    traceId = trace.id;
    ownTrace = true;
  }

  let inputStr: string;
  try {
    inputStr = opts.buildInput(null);
  } catch {
    inputStr = "{}";
  }

  const input = (() => {
    try {
      return JSON.parse(inputStr);
    } catch {
      return { prompt: inputStr };
    }
  })();

  const span = opts.tracer.startSpan(traceId, {
    type: opts.spanType,
    input,
    model: opts.model,
  });

  try {
    const result = await fn();

    const tokens = opts.extractTokens(result);
    const outputContent = opts.extractOutput(result);

    const output: SpanOutput = { content: outputContent };

    opts.tracer.endSpan(span.id, output, {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
    });

    if (ownTrace) {
      opts.tracer.endTrace(traceId, "success");
    }

    return result;
  } catch (error) {
    opts.tracer.endSpan(span.id, {}, {
      error: error instanceof Error ? error.message : String(error),
    });

    if (ownTrace) {
      opts.tracer.endTrace(traceId, "error");
    }

    throw error;
  }
}
