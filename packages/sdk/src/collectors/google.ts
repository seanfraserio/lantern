import type { LanternTracer } from "../tracer.js";
import type { SpanOutput } from "../types.js";

/**
 * Shape of the Google Generative AI model we wrap.
 * We use a structural type so we don't need the actual Google SDK as a dependency.
 */
interface GoogleContent {
  role: string;
  parts: Array<{ text: string }>;
}

interface GoogleCandidate {
  content: { role: string; parts: Array<{ text: string }> };
  finishReason?: string;
}

interface GoogleUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface GoogleGenerateContentResponse {
  text(): string;
  candidates?: GoogleCandidate[];
  usageMetadata?: GoogleUsageMetadata;
  functionCalls?(): Array<{ name: string; args: Record<string, unknown> }>;
}

interface GoogleGenerateContentRequest {
  contents: GoogleContent[];
  [key: string]: unknown;
}

interface GoogleGenerativeModel {
  generateContent(
    request: GoogleGenerateContentRequest
  ): Promise<{ response: GoogleGenerateContentResponse }>;
}

/**
 * Wrap a Google Generative AI model to automatically trace all generateContent() calls.
 * Creates llm_call spans with full input/output/token data.
 *
 * Usage:
 * ```typescript
 * import { GoogleGenerativeAI } from "@google/generative-ai";
 * import { LanternTracer, wrapGoogleGenerativeModel } from "@lantern-ai/sdk";
 *
 * const genAI = new GoogleGenerativeAI(apiKey);
 * const model = wrapGoogleGenerativeModel(
 *   genAI.getGenerativeModel({ model: "gemini-pro" }),
 *   tracer
 * );
 * // All model.generateContent() calls are now traced
 * ```
 */
export function wrapGoogleGenerativeModel<T extends GoogleGenerativeModel>(
  model: T,
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string; modelName?: string }
): T {
  const originalGenerateContent = model.generateContent.bind(model);

  const wrappedGenerateContent = async (
    request: GoogleGenerateContentRequest
  ): Promise<{ response: GoogleGenerateContentResponse }> => {
    // Get or create a trace
    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({
        agentName: opts?.agentName ?? "google-agent",
      });
      traceId = trace.id;
      ownTrace = true;
    }

    // Create the LLM call span
    const messages = request.contents.map((c) => ({
      role: c.role,
      content: c.parts.map((p) => p.text).join(""),
    }));

    const span = tracer.startSpan(traceId, {
      type: "llm_call",
      input: { messages },
      model: opts?.modelName,
    });

    try {
      const result = await originalGenerateContent(request);
      const response = result.response;

      // Extract text content from response
      const textContent = response.text();

      // Extract finish reason from first candidate
      const finishReason = response.candidates?.[0]?.finishReason;

      // Check for function calls
      let functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      try {
        const calls = response.functionCalls?.();
        if (calls && calls.length > 0) {
          functionCalls = calls;
        }
      } catch {
        // functionCalls() may throw if there are no function calls
      }

      const output: SpanOutput = {
        content: textContent,
        toolCalls: functionCalls.length > 0
          ? functionCalls.map((fc) => ({ name: fc.name, input: fc.args }))
          : undefined,
        stopReason: finishReason ?? undefined,
      };

      tracer.endSpan(span.id, output, {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      });

      // Create child spans for function calls
      for (const fc of functionCalls) {
        const toolSpan = tracer.startSpan(traceId, {
          type: "tool_call",
          parentSpanId: span.id,
          input: { args: fc.args },
          toolName: fc.name,
        });

        // Tool call spans are started but not ended here —
        // the actual tool execution happens outside this wrapper.
        // The user can end them manually or they'll be captured
        // by MCP instrumentation.
        tracer.endSpan(toolSpan.id, { content: "Tool call initiated" });
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

  // Replace the generateContent method with the wrapped version
  Object.assign(model, { generateContent: wrappedGenerateContent });

  return model;
}
