export type ProviderName = "anthropic" | "openai" | "google" | "ollama" | "bedrock" | "mistral" | "cohere";

/**
 * Shared type for captured LLM request/response data across all providers.
 *
 * Each provider parser (Anthropic, OpenAI, Mistral, Cohere) returns
 * `Partial<ProviderCapture>` from its response/SSE parsing functions.
 */
export interface ProviderCapture {
  model: string;
  inputMessages: Array<{ role: string; content: string }>;
  outputContent: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}
