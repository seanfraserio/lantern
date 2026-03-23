import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { TenantResolver } from "../../middleware/tenant.js";

type MockPool = {
  query: ReturnType<typeof vi.fn>;
};

function makePool(rows: unknown[]): MockPool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

const TEST_API_KEY = "test-api-key-12345";
const TEST_KEY_HASH = createHash("sha256").update(TEST_API_KEY).digest("hex");

describe("TenantResolver", () => {
  describe("resolve — cache miss (DB lookup)", () => {
    it("resolves a valid API key and returns tenant info", async () => {
      const pool = makePool([{ tenant_id: "tenant-001", slug: "acme" }]);
      const resolver = new TenantResolver(pool as never);

      const result = await resolver.resolve(TEST_API_KEY);

      expect(result).not.toBeNull();
      expect(result!.tenantId).toBe("tenant-001");
      expect(result!.tenantSlug).toBe("acme");
      expect(result!.resolvedAt).toBeGreaterThan(0);
    });

    it("returns null for an unknown API key", async () => {
      const pool = makePool([]); // no rows
      const resolver = new TenantResolver(pool as never);

      const result = await resolver.resolve("unknown-key");
      expect(result).toBeNull();
    });

    it("queries DB with the sha256 hash of the API key", async () => {
      const pool = makePool([]);
      const resolver = new TenantResolver(pool as never);

      await resolver.resolve(TEST_API_KEY);

      const [, params] = pool.query.mock.calls[0] as [string, string[]];
      expect(params[0]).toBe(TEST_KEY_HASH);
    });
  });

  describe("resolve — cache hit", () => {
    it("returns cached result without additional DB calls", async () => {
      const pool = makePool([{ tenant_id: "tenant-001", slug: "acme" }]);
      const resolver = new TenantResolver(pool as never, { cacheTtlMs: 60_000 });

      await resolver.resolve(TEST_API_KEY);
      // Wait for fire-and-forget update
      await new Promise((r) => setTimeout(r, 10));

      const dbCallsAfterFirst = pool.query.mock.calls.length;

      const cached = await resolver.resolve(TEST_API_KEY);
      expect(cached!.tenantId).toBe("tenant-001");
      expect(pool.query.mock.calls.length).toBe(dbCallsAfterFirst); // no new DB calls
    });

    it("re-queries DB after cache TTL expires", async () => {
      const pool = makePool([{ tenant_id: "tenant-001", slug: "acme" }]);
      const resolver = new TenantResolver(pool as never, { cacheTtlMs: 1 }); // 1ms TTL

      await resolver.resolve(TEST_API_KEY);
      await new Promise((r) => setTimeout(r, 10)); // wait for TTL to expire

      const dbCallsBefore = pool.query.mock.calls.length;
      await resolver.resolve(TEST_API_KEY);

      // Should have made at least one more lookup query
      expect(pool.query.mock.calls.length).toBeGreaterThan(dbCallsBefore);
    });
  });

  describe("cache eviction", () => {
    it("evicts oldest entry when maxCacheSize is reached", async () => {
      const pool = makePool([{ tenant_id: "tenant-evict", slug: "evict" }]);
      const resolver = new TenantResolver(pool as never, {
        maxCacheSize: 1,
        cacheTtlMs: 60_000,
      });

      const key1 = "first-key-abcdef";
      const key2 = "second-key-ghijkl";

      // Fill cache with key1
      await resolver.resolve(key1);
      await new Promise((r) => setTimeout(r, 10));

      const dbCallsAfterKey1 = pool.query.mock.calls.length;

      // key2 evicts key1
      await resolver.resolve(key2);
      await new Promise((r) => setTimeout(r, 10));

      // Resolving key1 again should hit DB (evicted from cache)
      await resolver.resolve(key1);
      expect(pool.query.mock.calls.length).toBeGreaterThan(dbCallsAfterKey1 + 1);
    });
  });

  describe("fire-and-forget last_used_at update", () => {
    it("issues an UPDATE query after successful resolution", async () => {
      let queryCount = 0;
      const pool: MockPool = {
        query: vi.fn().mockImplementation(() => {
          queryCount++;
          return Promise.resolve({ rows: [{ tenant_id: "t1", slug: "tenant1" }] });
        }),
      };
      const resolver = new TenantResolver(pool as never);

      await resolver.resolve(TEST_API_KEY);
      // Give fire-and-forget update time to complete
      await new Promise((r) => setTimeout(r, 20));

      // At least 2 calls: SELECT for lookup + UPDATE for last_used_at
      expect(queryCount).toBeGreaterThanOrEqual(2);
    });

    it("does not issue UPDATE for unknown keys (null result)", async () => {
      const pool = makePool([]); // no rows = no tenant found
      const resolver = new TenantResolver(pool as never);

      await resolver.resolve("unknown-key");
      await new Promise((r) => setTimeout(r, 20));

      // Only the SELECT lookup, no UPDATE
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });
});
