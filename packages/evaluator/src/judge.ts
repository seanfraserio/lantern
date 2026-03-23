/**
 * JudgeLLM — minimal interface for LLM-as-Judge evaluation.
 *
 * Any LLM client can be adapted to this interface. Two built-in adapters
 * are provided for Anthropic and OpenAI. Users can also pass a custom
 * implementation: `{ generate: async (prompt) => myLLM.complete(prompt) }`.
 */
export interface JudgeLLM {
  generate(prompt: string): Promise<string>;
}

/**
 * Parse a JSON response from the judge LLM.
 * Returns the parsed object, or a fallback score if parsing fails.
 */
export function parseJudgeResponse(raw: string): { score: number; label: string; reasoning: string } {
  // Try to extract JSON from the response (LLMs sometimes wrap in markdown)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { score: 0, label: "parse_error", reasoning: "Could not extract JSON from judge response" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const score = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0;
    const label = typeof parsed.label === "string" ? parsed.label : "unknown";
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
    return { score, label, reasoning };
  } catch {
    return { score: 0, label: "parse_error", reasoning: "Invalid JSON in judge response" };
  }
}

// ─── Built-in Adapters ───

/**
 * Structural type for Anthropic client — no import needed.
 */
interface AnthropicLike {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

/**
 * Structural type for OpenAI client — no import needed.
 */
interface OpenAILike {
  chat: {
    completions: {
      create(params: {
        model: string;
        max_tokens?: number;
        messages: Array<{ role: string; content: string }>;
      }): Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

/**
 * Create a JudgeLLM from an Anthropic client.
 * @param client - Anthropic SDK instance
 * @param model - Model to use (default: claude-haiku-4-5-20251001)
 */
export function anthropicJudge(client: AnthropicLike, model = "claude-haiku-4-5-20251001"): JudgeLLM {
  return {
    async generate(prompt: string): Promise<string> {
      const response = await client.messages.create({
        model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });
      return response.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    },
  };
}

/**
 * Create a JudgeLLM from an OpenAI client.
 * @param client - OpenAI SDK instance
 * @param model - Model to use (default: gpt-4o-mini)
 */
export function openaiJudge(client: OpenAILike, model = "gpt-4o-mini"): JudgeLLM {
  return {
    async generate(prompt: string): Promise<string> {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });
      return response.choices[0]?.message?.content ?? "";
    },
  };
}
