import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prompt, PromptClient } from "../prompts.js";
import type { PromptData } from "../prompts.js";

describe("Prompt", () => {
  const baseData: PromptData = {
    name: "greeting",
    version: 1,
    content: "Hello {{name}}, welcome to {{place}}!",
    model: "gpt-4o",
    variables: ["name", "place"],
  };

  describe("compile", () => {
    it("replaces all {{variables}} with provided values", () => {
      const prompt = new Prompt(baseData);
      const result = prompt.compile({ name: "Alice", place: "Wonderland" });
      expect(result).toBe("Hello Alice, welcome to Wonderland!");
    });

    it("throws on missing required variable", () => {
      const prompt = new Prompt(baseData);
      expect(() => prompt.compile({ name: "Alice" })).toThrow(
        "Missing required prompt variables: place"
      );
    });

    it("lists all missing variables in error message", () => {
      const prompt = new Prompt(baseData);
      expect(() => prompt.compile({})).toThrow(
        "Missing required prompt variables: name, place"
      );
    });

    it("handles prompt with no variables (empty vars object ok)", () => {
      const prompt = new Prompt({
        name: "static",
        version: 1,
        content: "This is a static prompt.",
        variables: [],
      });
      const result = prompt.compile();
      expect(result).toBe("This is a static prompt.");
    });

    it("handles multiple occurrences of same variable", () => {
      const prompt = new Prompt({
        name: "repeat",
        version: 1,
        content: "{{name}} said hello, and {{name}} waved.",
        variables: ["name"],
      });
      const result = prompt.compile({ name: "Bob" });
      expect(result).toBe("Bob said hello, and Bob waved.");
    });

    it("preserves non-variable curly braces (e.g., JSON in prompts)", () => {
      const prompt = new Prompt({
        name: "json-prompt",
        version: 1,
        content: 'Return JSON: {"key": "value"} for {{name}}',
        variables: ["name"],
      });
      const result = prompt.compile({ name: "Alice" });
      expect(result).toBe('Return JSON: {"key": "value"} for Alice');
    });
  });

  describe("constructor", () => {
    it("assigns all fields from PromptData", () => {
      const prompt = new Prompt(baseData);
      expect(prompt.name).toBe("greeting");
      expect(prompt.version).toBe(1);
      expect(prompt.content).toBe("Hello {{name}}, welcome to {{place}}!");
      expect(prompt.model).toBe("gpt-4o");
      expect(prompt.variables).toEqual(["name", "place"]);
    });

    it("allows model to be undefined", () => {
      const prompt = new Prompt({
        name: "no-model",
        version: 2,
        content: "test",
        variables: [],
      });
      expect(prompt.model).toBeUndefined();
    });
  });
});

describe("PromptClient", () => {
  const mockPromptData: PromptData = {
    name: "test-prompt",
    version: 3,
    content: "Hello {{user}}!",
    model: "claude-3-opus",
    variables: ["user"],
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches from correct URL", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockPromptData,
    });

    const client = new PromptClient("https://ingest.example.com");
    await client.getPrompt("test-prompt");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ingest.example.com/v1/prompts/test-prompt"
    );
  });

  it("strips trailing slash from base URL", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockPromptData,
    });

    const client = new PromptClient("https://ingest.example.com/");
    await client.getPrompt("test-prompt");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ingest.example.com/v1/prompts/test-prompt"
    );
  });

  it("encodes prompt name in URL", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockPromptData,
    });

    const client = new PromptClient("https://ingest.example.com");
    await client.getPrompt("my prompt/name");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ingest.example.com/v1/prompts/my%20prompt%2Fname"
    );
  });

  it("returns Prompt instance with compile method", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockPromptData,
    });

    const client = new PromptClient("https://ingest.example.com");
    const prompt = await client.getPrompt("test-prompt");

    expect(prompt).toBeInstanceOf(Prompt);
    expect(prompt.name).toBe("test-prompt");
    expect(prompt.compile({ user: "Alice" })).toBe("Hello Alice!");
  });

  it("caches result (second call does not fetch)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockPromptData,
    });

    const client = new PromptClient("https://ingest.example.com");
    const first = await client.getPrompt("test-prompt");
    const second = await client.getPrompt("test-prompt");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("re-fetches after TTL expires", async () => {
    vi.useFakeTimers();

    const updatedData: PromptData = {
      ...mockPromptData,
      version: 4,
      content: "Updated {{user}}!",
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPromptData,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => updatedData,
      });

    const client = new PromptClient("https://ingest.example.com");

    const first = await client.getPrompt("test-prompt");
    expect(first.version).toBe(3);

    // Advance past the 60s TTL
    vi.advanceTimersByTime(61_000);

    const second = await client.getPrompt("test-prompt");
    expect(second.version).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("throws on 404", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const client = new PromptClient("https://ingest.example.com");
    await expect(client.getPrompt("nonexistent")).rejects.toThrow(
      "Prompt 'nonexistent' not found or has no active version"
    );
  });

  it("throws on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const client = new PromptClient("https://ingest.example.com");
    await expect(client.getPrompt("test-prompt")).rejects.toThrow(
      "Failed to fetch prompt 'test-prompt': HTTP 500"
    );
  });

  it("clearCache() forces re-fetch", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPromptData,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...mockPromptData, version: 5 }),
      });

    const client = new PromptClient("https://ingest.example.com");

    const first = await client.getPrompt("test-prompt");
    expect(first.version).toBe(3);

    client.clearCache();

    const second = await client.getPrompt("test-prompt");
    expect(second.version).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
