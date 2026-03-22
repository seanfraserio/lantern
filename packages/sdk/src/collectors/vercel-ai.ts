import type { LanternTracer } from "../tracer.js";
import type { SpanOutput } from "../types.js";

/**
 * Shape of the Vercel AI SDK functions we wrap.
 * We use structural types so we don't need the actual `ai` package as a dependency.
 */
interface VercelMessage {
  role: string;
  content: string;
}

interface VercelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface VercelToolCall {
  toolName: string;
  args: unknown;
}

interface VercelToolResult {
  toolName: string;
  result: unknown;
}

interface VercelGenerateTextParams {
  model: any;
  messages?: VercelMessage[];
  prompt?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: Record<string, any>;
  [key: string]: unknown;
}

interface VercelGenerateTextResult {
  text: string;
  usage: VercelUsage;
  finishReason: string;
  toolCalls?: VercelToolCall[];
  toolResults?: VercelToolResult[];
  [key: string]: unknown;
}

interface VercelGenerateTextFn {
  (params: VercelGenerateTextParams): Promise<VercelGenerateTextResult>;
}

interface VercelStreamTextResult {
  textStream: AsyncIterable<string>;
  usage: Promise<VercelUsage>;
  finishReason: Promise<string>;
  toolCalls?: Promise<VercelToolCall[]>;
  [key: string]: unknown;
}

/**
 * Extract a model name string from Vercel AI SDK model objects.
 * The model can be a string or an object with modelId/modelName.
 */
function extractModelName(model: unknown): string | undefined {
  if (typeof model === "string") return model;
  if (model && typeof model === "object") {
    const m = model as Record<string, unknown>;
    if (typeof m.modelId === "string") return m.modelId;
    if (typeof m.modelName === "string") return m.modelName;
  }
  return undefined;
}

/**
 * Build span input from Vercel AI SDK params.
 * Vercel supports both `messages` array and `prompt` string.
 */
function buildSpanInput(params: VercelGenerateTextParams) {
  if (params.messages) {
    const messages = params.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    // Prepend system message if provided
    if (params.system) {
      messages.unshift({ role: "system", content: params.system });
    }
    return { messages };
  }

  if (params.prompt) {
    const messages = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    messages.push({ role: "user", content: params.prompt });
    return { messages };
  }

  return { messages: [] };
}

/**
 * Wrap the Vercel AI SDK `generateText()` function to automatically trace calls.
 * Creates llm_call spans with full input/output/token data.
 *
 * Usage:
 * ```typescript
 * import { generateText } from "ai";
 * import { LanternTracer, wrapGenerateText } from "@lantern-ai/sdk";
 *
 * const tracedGenerateText = wrapGenerateText(generateText, tracer);
 * const result = await tracedGenerateText({ model: openai("gpt-4"), prompt: "Hello" });
 * ```
 */
export function wrapGenerateText(
  generateTextFn: VercelGenerateTextFn,
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string }
): VercelGenerateTextFn {
  return async (params: VercelGenerateTextParams): Promise<VercelGenerateTextResult> => {
    // Get or create a trace
    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({
        agentName: opts?.agentName ?? "vercel-ai-agent",
      });
      traceId = trace.id;
      ownTrace = true;
    }

    const modelName = extractModelName(params.model);

    // Create the LLM call span
    const span = tracer.startSpan(traceId, {
      type: "llm_call",
      input: buildSpanInput(params),
      model: modelName,
    });

    try {
      const result = await generateTextFn(params);

      // Extract tool calls
      const toolCalls = result.toolCalls?.map((tc) => ({
        name: tc.toolName,
        input: tc.args,
      })) ?? [];

      const output: SpanOutput = {
        content: result.text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        stopReason: result.finishReason ?? undefined,
      };

      tracer.endSpan(span.id, output, {
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
      });

      // Create child spans for tool calls
      for (const tc of result.toolCalls ?? []) {
        const toolSpan = tracer.startSpan(traceId, {
          type: "tool_call",
          parentSpanId: span.id,
          input: { args: tc.args },
          toolName: tc.toolName,
        });

        // Find matching tool result
        const toolResult = result.toolResults?.find((tr) => tr.toolName === tc.toolName);
        tracer.endSpan(toolSpan.id, {
          content: toolResult ? JSON.stringify(toolResult.result) : "Tool call initiated",
        });
      }

      if (ownTrace) {
        tracer.endTrace(traceId, "success");
      }

      return result;
    } catch (error) {
      tracer.endSpan(span.id, {}, {
        error: error instanceof Error ? error.message : String(error),
      });

      if (ownTrace) {
        tracer.endTrace(traceId, "error");
      }

      throw error;
    }
  };
}

/**
 * Wrap the Vercel AI SDK `streamText()` function to automatically trace calls.
 * Returns the stream as-is but accumulates text chunks to record the full output
 * when the stream completes.
 *
 * Usage:
 * ```typescript
 * import { streamText } from "ai";
 * import { LanternTracer, wrapStreamText } from "@lantern-ai/sdk";
 *
 * const tracedStreamText = wrapStreamText(streamText, tracer);
 * const result = tracedStreamText({ model: openai("gpt-4"), prompt: "Hello" });
 * for await (const chunk of result.textStream) { process.stdout.write(chunk); }
 * ```
 */
export function wrapStreamText(
  streamTextFn: (params: VercelGenerateTextParams) => VercelStreamTextResult,
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string }
): (params: VercelGenerateTextParams) => VercelStreamTextResult {
  return (params: VercelGenerateTextParams): VercelStreamTextResult => {
    // Get or create a trace
    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({
        agentName: opts?.agentName ?? "vercel-ai-agent",
      });
      traceId = trace.id;
      ownTrace = true;
    }

    const modelName = extractModelName(params.model);

    // Create the LLM call span
    const span = tracer.startSpan(traceId, {
      type: "llm_call",
      input: buildSpanInput(params),
      model: modelName,
    });

    // Call the original function
    const result = streamTextFn(params) as VercelStreamTextResult;

    // Wrap the textStream to accumulate chunks and end the span on completion
    const originalStream = result.textStream;
    const capturedTraceId = traceId;
    const capturedOwnTrace = ownTrace;

    const wrappedStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        const iterator = originalStream[Symbol.asyncIterator]();
        const chunks: string[] = [];

        return {
          async next(): Promise<IteratorResult<string>> {
            try {
              const { value, done } = await iterator.next();

              if (done) {
                // Stream complete — end span with accumulated text
                const fullText = chunks.join("");

                // Try to get usage from the result's usage promise
                let usage: VercelUsage | undefined;
                let finishReason: string | undefined;
                try {
                  if (result.usage) usage = await result.usage;
                  if (result.finishReason) finishReason = await result.finishReason;
                } catch {
                  // Usage/finishReason may not be available
                }

                const output: SpanOutput = {
                  content: fullText,
                  stopReason: finishReason,
                };

                tracer.endSpan(span.id, output, {
                  inputTokens: usage?.promptTokens,
                  outputTokens: usage?.completionTokens,
                });

                if (capturedOwnTrace) {
                  tracer.endTrace(capturedTraceId, "success");
                }

                return { value: undefined as any, done: true };
              }

              chunks.push(value);
              return { value, done: false };
            } catch (error) {
              tracer.endSpan(span.id, {}, {
                error: error instanceof Error ? error.message : String(error),
              });

              if (capturedOwnTrace) {
                tracer.endTrace(capturedTraceId, "error");
              }

              throw error;
            }
          },
        };
      },
    };

    // Return the result with the wrapped stream
    return {
      ...result,
      textStream: wrappedStream,
    };
  };
}
