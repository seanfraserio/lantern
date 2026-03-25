export interface PromptData {
  name: string;
  version: number;
  content: string;
  model?: string;
  variables: string[];
}

export class Prompt {
  readonly name!: string;
  readonly version!: number;
  readonly content!: string;
  readonly model?: string;
  readonly variables!: string[];

  constructor(data: PromptData) {
    Object.assign(this, data);
  }

  /**
   * Compile the prompt by replacing {{variable}} with provided values.
   * Throws if a required variable is missing.
   */
  compile(vars: Record<string, string> = {}): string {
    const missing = this.variables.filter(v => !(v in vars));
    if (missing.length > 0) {
      throw new Error(`Missing required prompt variables: ${missing.join(", ")}`);
    }
    return this.content.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? `{{${name}}}`);
  }
}

// Cache for prompt lookups
interface CachedPrompt {
  prompt: Prompt;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

export class PromptClient {
  private cache = new Map<string, CachedPrompt>();
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getPrompt(name: string): Promise<Prompt> {
    // Check cache
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.prompt;
    }

    // Fetch from ingest server
    const res = await fetch(`${this.baseUrl}/v1/prompts/${encodeURIComponent(name)}`);
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`Prompt '${name}' not found or has no active version`);
      }
      throw new Error(`Failed to fetch prompt '${name}': HTTP ${res.status}`);
    }

    const data = await res.json() as PromptData;
    const prompt = new Prompt(data);

    // Cache it
    this.cache.set(name, { prompt, expiresAt: Date.now() + CACHE_TTL_MS });

    return prompt;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
