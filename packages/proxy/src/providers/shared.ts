/**
 * Shared provider utilities extracted from the 4 identical implementations.
 *
 * - parseProviderRequest: identical across all providers
 * - createUrlBuilder: factory for the per-provider buildXxxUrl functions
 */

/**
 * Parse an LLM request body into the common shape used by all providers.
 * Extracts model, messages, and stream flag.
 *
 * This function was identical in anthropic.ts, openai.ts, mistral.ts, and cohere.ts.
 */
export function parseProviderRequest(body: unknown): {
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

interface UrlBuilderConfig {
  /** Path prefix to strip, e.g. "/anthropic" */
  pathPrefix: string;
  /** Base URL for the provider API, e.g. "https://api.anthropic.com" */
  baseUrl: string;
  /** Allowed path prefixes after stripping, e.g. ["/v1/"] or ["/v1/", "/v2/"] */
  allowedPrefixes: string[];
}

/**
 * Create a URL builder for a provider.
 * Strips the provider path prefix, validates the resulting path, and prepends the base URL.
 */
export function createUrlBuilder(config: UrlBuilderConfig): (path: string) => string {
  const prefixRegex = new RegExp(`^${config.pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

  return (path: string): string => {
    const stripped = path.replace(prefixRegex, "");
    if (stripped.includes("..") || !config.allowedPrefixes.some((p) => stripped.startsWith(p))) {
      throw new Error(`Invalid API path: ${stripped}`);
    }
    return `${config.baseUrl}${stripped}`;
  };
}
