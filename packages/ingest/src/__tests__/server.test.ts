import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { createServer, StoreCache } from "../server.js";
import type { ITraceStore, Trace, SourceSummary, TraceQueryFilter } from "@openlantern-ai/sdk";

type MockStore = ITraceStore & { traces: Map<string, Trace>; close: () => Promise<void> };

/**
 * Injected listen seam. Tests must not bind 0.0.0.0 or other nonlocal addresses.
 * Production still calls app.listen unless a caller supplies listen.
 */
const listen = vi.fn(async () => {});

function makeMockStore(): MockStore {
  const traces = new Map<string, Trace>();
  return {
    traces,
    insert: vi.fn(async (newTraces: Trace[]) => {
      for (const t of newTraces) traces.set(t.id, t);
    }),
    getTrace: vi.fn(async (id: string) => traces.get(id) ?? null),
    queryTraces: vi.fn(async (_filter: TraceQueryFilter) => Array.from(traces.values())),
    getTraceCount: vi.fn(async () => traces.size),
    getSources: vi.fn(async (): Promise<SourceSummary[]> => []),
    updateScores: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function makeValidTrace(): Trace {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    agentName: "test",
    environment: "dev",
    startTime: Date.now(),
    status: "success",
    spans: [],
    metadata: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
  };
}

describe("createServer - single-tenant mode authentication", () => {
  let app: FastifyInstance | undefined;
  let store: ReturnType<typeof makeMockStore>;

  beforeEach(() => {
    store = makeMockStore();
    listen.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("starts without API key on localhost (127.0.0.1) with warning", async () => {
    const result = await createServer({
      port: 0,
      host: "127.0.0.1",
      store,
      apiKey: undefined,
      listen,
    });
    app = result.app;

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("WARNING: No API key configured")
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("SECURITY ERROR")
    );
    expect(listen).toHaveBeenCalledWith({ port: 0, host: "127.0.0.1" });
  });

  it("starts without API key on localhost (::1) with warning", async () => {
    const result = await createServer({
      port: 0,
      host: "::1",
      store,
      apiKey: undefined,
      listen,
    });
    app = result.app;

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("WARNING: No API key configured")
    );
    expect(listen).toHaveBeenCalledOnce();
  });

  it("starts without API key on localhost (localhost) with warning", async () => {
    const result = await createServer({
      port: 0,
      host: "localhost",
      store,
      apiKey: undefined,
      listen,
    });
    app = result.app;

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("WARNING: No API key configured")
    );
    expect(listen).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated nonlocal bind before listening", async () => {
    await expect(
      createServer({
        port: 0,
        host: "0.0.0.0",
        store,
        apiKey: undefined,
        listen,
      })
    ).rejects.toThrow(/API key/i);

    expect(listen).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SECURITY ERROR")
    );
  });

  it("rejects other unauthenticated nonlocal hosts before listening", async () => {
    await expect(
      createServer({
        port: 0,
        host: "10.0.0.8",
        store,
        apiKey: undefined,
        listen,
      })
    ).rejects.toThrow(/API key/i);

    expect(listen).not.toHaveBeenCalled();
  });

  it("does not reject keyed nonlocal startup and does not listen until auth is accepted", async () => {
    const result = await createServer({
      port: 0,
      host: "0.0.0.0",
      store,
      apiKey: "test-api-key-123",
      listen,
    });
    app = result.app;

    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("SECURITY ERROR")
    );
    expect(listen).toHaveBeenCalledWith({ port: 0, host: "0.0.0.0" });
  });

  it("requires authentication when API key is provided", async () => {
    const result = await createServer({
      port: 0,
      host: "127.0.0.1",
      store,
      apiKey: "test-api-key-123",
      listen,
    });
    app = result.app;

    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      payload: { traces: [makeValidTrace()] },
    });

    expect(res.statusCode).toBe(401);
  });

  it("accepts requests with correct API key", async () => {
    const result = await createServer({
      port: 0,
      host: "127.0.0.1",
      store,
      apiKey: "test-api-key-123",
      listen,
    });
    app = result.app;

    const res = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { authorization: "Bearer test-api-key-123" },
      payload: { traces: [makeValidTrace()] },
    });

    expect(res.statusCode).toBe(201);
  });

  it("does not start an unauthenticated nonlocal server when insecure development is not opted in", async () => {
    await expect(
      createServer({
        port: 0,
        host: "0.0.0.0",
        store,
        allowInsecure: false,
        listen,
      })
    ).rejects.toThrow(/API key/i);
    expect(listen).not.toHaveBeenCalled();
  });

  it("allows unauthenticated nonlocal startup only with an explicit insecure opt-in", async () => {
    const result = await createServer({
      port: 0,
      host: "0.0.0.0",
      store,
      allowInsecure: true,
      listen,
    });
    app = result.app;

    expect(listen).toHaveBeenCalledWith({ port: 0, host: "0.0.0.0" });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("LANTERN_ALLOW_INSECURE")
    );
  });

  it("rejects multi-tenant startup when no database URL is configured", async () => {
    await expect(
      createServer({
        port: 0,
        host: "0.0.0.0",
        store,
        multiTenant: true,
        databaseUrl: "",
        listen,
      })
    ).rejects.toThrow(/multi-tenant/i);

    expect(listen).not.toHaveBeenCalled();
  });
});

describe("createServer - multi-tenant store lease", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("releases the exact request lease once on finish and again on a later generation", async () => {
    const closed: string[] = [];
    const created: string[] = [];
    let generation = 0;
    const cache = new StoreCache<MockStore>(1);

    const result = await createServer({
      port: 0,
      host: "127.0.0.1",
      store: makeMockStore(),
      multiTenant: true,
      databaseUrl: "postgres://unused",
      listen,
      storeCache: cache,
      resolveTenant: async () => ({ tenantId: "tenant-1", tenantSlug: "acme" }),
      usagePool: { query: async () => ({ rows: [{ plan: "free", trace_count: 0 }] }) },
      createTenantStore: async (slug) => {
        generation += 1;
        const id = `${slug}-${generation}`;
        created.push(id);
        return {
          ...makeMockStore(),
          close: vi.fn(async () => {
            closed.push(id);
          }),
        };
      },
    });
    app = result.app;

    const first = await app.inject({
      method: "GET",
      url: "/v1/traces",
      headers: { authorization: "Bearer tenant-key" },
    });
    expect(first.statusCode).not.toBe(401);
    await new Promise((resolve) => setImmediate(resolve));

    expect(created).toEqual(["acme-1"]);
    expect(closed).toEqual([]);

    await cache.insert("other", {
      ...makeMockStore(),
      close: vi.fn(async () => {}),
    }, 2);
    expect(closed).toEqual(["acme-1"]);

    const second = await app.inject({
      method: "GET",
      url: "/v1/traces",
      headers: { authorization: "Bearer tenant-key" },
    });
    expect(second.statusCode).not.toBe(401);
    await new Promise((resolve) => setImmediate(resolve));

    expect(created).toEqual(["acme-1", "acme-2"]);
    expect(closed).toEqual(["acme-1"]);
    expect(cache.acquire("acme")).toBeDefined();
  });

  it("keeps the lease until a real HTTP response finishes, not when the request message closes", async () => {
    const events: string[] = [];
    const cache = new StoreCache<MockStore>(1);
    let releaseInsert: (() => void) | undefined;
    const insertStarted = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let finishInsert: (() => void) | undefined;
    const insertGate = new Promise<void>((resolve) => {
      finishInsert = resolve;
    });
    let req: http.ClientRequest | undefined;

    const result = await createServer({
      port: 0,
      host: "127.0.0.1",
      store: makeMockStore(),
      multiTenant: true,
      databaseUrl: "postgres://unused",
      listen,
      storeCache: cache,
      resolveTenant: async () => ({ tenantId: "tenant-1", tenantSlug: "acme" }),
      usagePool: { query: async () => ({ rows: [{ plan: "free", trace_count: 0 }] }) },
      createTenantStore: async () => {
        const tenantStore = makeMockStore();
        tenantStore.insert = vi.fn(async () => {
          releaseInsert!();
          await insertGate;
          events.push("insert-finished");
        });
        tenantStore.close = vi.fn(async () => {
          events.push("store-closed");
        });
        return tenantStore;
      },
    });
    app = result.app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");

    try {
      const responsePromise = new Promise<{ status: number }>((resolve, reject) => {
        req = http.request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/v1/traces",
            method: "POST",
            headers: {
              authorization: "Bearer tenant-key",
              "content-type": "application/json",
              connection: "close",
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ traces: [makeValidTrace()] }));
      });

      await insertStarted;
      // Request body has completed and IncomingMessage has closed, but the
      // handler is still using the store. Eviction must not close it yet.
      await cache.insert("other", {
        ...makeMockStore(),
        close: vi.fn(async () => {}),
      });
      expect(events).toEqual([]);

      finishInsert!();
      const response = await responsePromise;
      expect(response.status).toBe(201);
      await new Promise((resolve) => setImmediate(resolve));
      expect(events).toEqual(["insert-finished", "store-closed"]);
      expect(cache.size).toBe(1);
    } finally {
      finishInsert!();
      req?.destroy();
      await app.close();
      app = undefined;
    }
  });
});
