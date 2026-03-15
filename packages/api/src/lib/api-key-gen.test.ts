import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey } from "./api-key-gen.js";

describe("api-key-gen", () => {
  it("should generate a key with lnt_ prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(key.startsWith("lnt_")).toBe(true);
    expect(key.length).toBeGreaterThan(20);
    expect(prefix).toBe(key.slice(0, 12));
  });

  it("should produce a deterministic hash", () => {
    const { key } = generateApiKey();
    const hash1 = hashApiKey(key);
    const hash2 = hashApiKey(key);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it("should generate unique keys", () => {
    const keys = new Set(Array.from({ length: 10 }, () => generateApiKey().key));
    expect(keys.size).toBe(10);
  });
});
