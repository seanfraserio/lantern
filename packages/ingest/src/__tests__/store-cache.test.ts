import { describe, it, expect, vi } from "vitest";
import { StoreCache } from "../server.js";

function store() {
  return { close: vi.fn(async () => {}) };
}

describe("StoreCache lifetime", () => {
  it("keeps the cache bounded when an idle eviction overlaps another insert", async () => {
    const cache = new StoreCache<ReturnType<typeof store>>(1);
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => { finishClose = resolve; });
    const first = store();
    first.close.mockImplementation(() => closing);
    const initial = await cache.insert("A", first, 1);
    await initial.release();

    const pendingB = cache.insert("B", store(), 2);
    expect(first.close).toHaveBeenCalledOnce();
    const leaseC = await cache.insert("C", store(), 3);
    finishClose();
    const leaseB = await pendingB;

    expect(cache.size).toBe(1);
    await leaseB.release();
    await leaseC.release();
  });
  it("closes an idle least-recently-used store on eviction", async () => {
    const cache = new StoreCache<ReturnType<typeof store>>(1);
    const first = store();
    const lease = await cache.insert("a", first, 1);
    expect(lease.store).toBe(first);
    await lease.release();

    const second = store();
    await cache.insert("b", second, 2);

    expect(first.close).toHaveBeenCalledOnce();
    expect(cache.size).toBe(1);
  });

  it("does not close a store that still has an in-flight acquire", async () => {
    const cache = new StoreCache<ReturnType<typeof store>>(1);
    const first = store();
    const held = await cache.insert("a", first, 1);
    expect(held.store).toBe(first);

    const second = store();
    await cache.insert("b", second, 2);

    expect(first.close).not.toHaveBeenCalled();
    expect(cache.acquire("a")).toBeUndefined();

    await held.release();
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("keeps the store open until every in-flight holder releases it", async () => {
    const cache = new StoreCache<ReturnType<typeof store>>(1);
    const first = store();
    const inserted = await cache.insert("a", first, 1);
    const acquired = cache.acquireLease("a", 2);
    expect(acquired?.store).toBe(first);

    await cache.insert("b", store(), 3);
    await inserted.release();
    expect(first.close).not.toHaveBeenCalled();

    await acquired!.release();
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("closes the old generation when its lease is released after the key is reinserted", async () => {
    const cache = new StoreCache<ReturnType<typeof store>>(1);
    const a1 = store();
    const lease = await cache.insert("A", a1, 1);

    const b = store();
    await cache.insert("B", b, 2);

    const a2 = store();
    await cache.insert("A", a2, 3);
    expect(cache.acquire("A")).toBe(a2);

    await lease.release();

    expect(a1.close).toHaveBeenCalledOnce();
    expect(a2.close).not.toHaveBeenCalled();
    expect(cache.acquire("A")).toBe(a2);
  });

  it("does not overwrite an unresolved same-key generation when that key is evicted again", async () => {
    const cache = new StoreCache<ReturnType<typeof store>>(1);
    const a1 = store();
    const lease1 = await cache.insert("A", a1, 1);
    await cache.insert("B", store(), 2);

    const a2 = store();
    const lease2 = await cache.insert("A", a2, 3);
    await cache.insert("C", store(), 4);

    await lease1.release();
    expect(a1.close).toHaveBeenCalledOnce();
    expect(a2.close).not.toHaveBeenCalled();

    await lease2.release();
    expect(a2.close).toHaveBeenCalledOnce();
  });

  it("creates one store for concurrent first misses and closes the unused duplicate", async () => {
    const cache = new StoreCache<ReturnType<typeof store>>(2);
    const created: Array<ReturnType<typeof store>> = [];
    let releaseCreate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });

    const create = vi.fn(async () => {
      await gate;
      const next = store();
      created.push(next);
      return next;
    });

    const first = cache.getOrCreate("A", create, 1);
    const second = cache.getOrCreate("A", create, 1);
    releaseCreate!();
    const [left, right] = await Promise.all([first, second]);

    expect(create).toHaveBeenCalledOnce();
    expect(left.store).toBe(right.store);
    expect(created.filter((item) => item !== left.store)).toHaveLength(0);

    await left.release();
    expect(left.store.close).not.toHaveBeenCalled();
    await right.release();
    expect(cache.acquire("A")).toBe(left.store);
  });

  it("counts a ref for every concurrent lease of the same created store", async () => {
    const cache = new StoreCache<ReturnType<typeof store>>(1);
    let closed = 0;
    let creates = 0;
    const shared = store();
    shared.close.mockImplementation(async () => {
      closed += 1;
    });

    const [lease1, lease2] = await Promise.all([
      cache.getOrCreate(
        "A",
        async () => {
          creates += 1;
          return shared;
        },
        1,
      ),
      cache.getOrCreate(
        "A",
        async () => {
          creates += 1;
          return shared;
        },
        1,
      ),
    ]);

    await cache.insert("B", store(), 2);
    await lease1.release();

    expect(creates).toBe(1);
    expect(closed).toBe(0);

    await lease1.release();
    expect(closed).toBe(0);

    await lease2.release();
    expect(closed).toBe(1);
    await lease2.release();
    expect(closed).toBe(1);

    const reinserted = store();
    const next = await cache.insert("A", reinserted, 3);
    expect(next.store).toBe(reinserted);
    expect(closed).toBe(1);
    expect(reinserted.close).not.toHaveBeenCalled();
    await next.release();
  });

  it("does not emit an unhandled rejection when store creation fails", async () => {
    const cache = new StoreCache<ReturnType<typeof store>>(1);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const failure = new Error("db unavailable");
    const first = cache.getOrCreate("X", async () => {
      throw failure;
    });
    const second = cache.getOrCreate("X", async () => {
      throw new Error("should share the in-flight failure");
    });

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);

    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    process.off("unhandledRejection", onUnhandled);

    const recovered = store();
    const lease = await cache.getOrCreate("X", async () => recovered);
    expect(lease.store).toBe(recovered);
    expect(cache.acquire("X")).toBe(recovered);
    await lease.release();
  });
});
