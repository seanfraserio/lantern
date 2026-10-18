import { describe, it, expect, vi } from "vitest";
import { checkApproximateUsageLimit, PLAN_LIMITS } from "../server.js";
import type { UsageCacheEntry, UsageQueryPool } from "../server.js";

type UsageQueryMock = ReturnType<typeof vi.fn<UsageQueryPool["query"]>>;

function poolReturning(row: Record<string, unknown> | undefined): UsageQueryPool & { query: UsageQueryMock } {
  const query: UsageQueryPool["query"] = async () => ({ rows: row ? [row] : [] });
  return { query: vi.fn(query) };
}

describe("approximate multi-tenant usage gate", () => {
  it("rejects when the cached monthly count is already at the plan limit", async () => {
    const pool = poolReturning({ plan: "free", trace_count: PLAN_LIMITS.free });
    const cache = new Map<string, UsageCacheEntry>();

    const decision = await checkApproximateUsageLimit(pool, cache, "tenant-1", 1_000);

    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe(PLAN_LIMITS.free);
    expect(decision.count).toBe(PLAN_LIMITS.free);
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it("does not reserve accepted batches against the cached count", async () => {
    const pool = poolReturning({ plan: "free", trace_count: PLAN_LIMITS.free - 1 });
    const cache = new Map<string, UsageCacheEntry>();
    const now = 1_700_000_000_000;

    const first = await checkApproximateUsageLimit(pool, cache, "tenant-1", now);
    const second = await checkApproximateUsageLimit(pool, cache, "tenant-1", now + 1_000);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(second.count).toBe(PLAN_LIMITS.free - 1);
    expect(cache.get("tenant-1")?.count).toBe(PLAN_LIMITS.free - 1);
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it("refreshes from public.usage after the 60 second TTL and does not write usage", async () => {
    const pool = poolReturning({ plan: "team", trace_count: 50 });
    const cache = new Map<string, UsageCacheEntry>();
    const now = 1_700_000_000_000;

    await checkApproximateUsageLimit(pool, cache, "tenant-1", now);
    pool.query.mockResolvedValueOnce({ rows: [{ plan: "team", trace_count: 80 }] });
    const refreshed = await checkApproximateUsageLimit(pool, cache, "tenant-1", now + 60_000);

    expect(refreshed.count).toBe(80);
    expect(refreshed.plan).toBe("team");
    expect(refreshed.allowed).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(2);
    for (const call of pool.query.mock.calls) {
      expect(String(call[0])).toMatch(/^SELECT /);
      expect(String(call[0])).not.toMatch(/INSERT|UPDATE/i);
    }
  });

  it("treats a missing usage row as zero traces on the free plan", async () => {
    const pool = poolReturning(undefined);
    const decision = await checkApproximateUsageLimit(pool, new Map(), "missing", 1_000);

    expect(decision).toEqual({
      allowed: true,
      plan: "free",
      count: 0,
      limit: PLAN_LIMITS.free,
    });
  });
});
