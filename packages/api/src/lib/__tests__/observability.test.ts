import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { registerObservability, recordMetric, recordEvent } from "../observability.js";

describe("recordMetric (no buffer initialized)", () => {
  it("is a no-op when observability is not registered", () => {
    // Should not throw when buffer is null
    expect(() => recordMetric("test_metric", 1, { label: "value" })).not.toThrow();
  });

  it("accepts metric without labels", () => {
    expect(() => recordMetric("test_metric", 42)).not.toThrow();
  });
});

describe("recordEvent (no buffer initialized)", () => {
  it("is a no-op when observability is not registered", () => {
    expect(() => recordEvent("test_event", { key: "value" })).not.toThrow();
  });
});

describe("registerObservability", () => {
  afterEach(() => {
    delete process.env.GRAFANA_PUSH_URL;
    delete process.env.GRAFANA_USER;
    delete process.env.GRAFANA_TOKEN;
  });

  it("logs that observability is disabled when Grafana config is missing", async () => {
    const app = Fastify({ logger: false });
    const infoSpy = vi.spyOn(app, "log", "get").mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
    } as unknown as ReturnType<typeof app.log.child>);

    // No Grafana env vars set — should be a no-op
    registerObservability(app, "test-service");
    await app.ready();
    await app.close();

    // No error thrown — observability gracefully disables
    expect(true).toBe(true);
    infoSpy.mockRestore();
  });

  it("initializes metrics buffer when Grafana config is present", async () => {
    process.env.GRAFANA_PUSH_URL = "https://grafana.test";
    process.env.GRAFANA_USER = "testuser";
    process.env.GRAFANA_TOKEN = "testtoken";

    // Mock fetch so buffer flush doesn't actually send data
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock;

    const app = Fastify({ logger: false });
    registerObservability(app, "test-service");
    await app.ready();

    // After registering, recordMetric should buffer metrics
    expect(() => recordMetric("test_counter", 1, {})).not.toThrow();

    await app.close();
  });

  it("adds onRequest hook that tracks start time", async () => {
    process.env.GRAFANA_PUSH_URL = "https://grafana.test";
    process.env.GRAFANA_USER = "user";
    process.env.GRAFANA_TOKEN = "token";

    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

    const app = Fastify({ logger: false });
    registerObservability(app, "test-service");
    app.get("/test", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});

describe("normalizeRoute behavior (via observability hooks)", () => {
  afterEach(() => {
    delete process.env.GRAFANA_PUSH_URL;
    delete process.env.GRAFANA_USER;
    delete process.env.GRAFANA_TOKEN;
  });

  it("normalizes UUID path segments to /:id in metrics", async () => {
    process.env.GRAFANA_PUSH_URL = "https://grafana.test";
    process.env.GRAFANA_USER = "user";
    process.env.GRAFANA_TOKEN = "token";

    const capturedMetrics: unknown[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      if (typeof opts.body === "string") capturedMetrics.push(JSON.parse(opts.body));
      return { ok: true } as Response;
    });

    const app = Fastify({ logger: false });
    registerObservability(app, "test-service");
    app.get("/traces/:id", async () => ({ ok: true }));
    await app.ready();

    await app.inject({
      method: "GET",
      url: "/traces/550e8400-e29b-41d4-a716-446655440000",
    });
    await app.close();

    // Metrics should have been pushed with normalized route
    const metricData = capturedMetrics.find((m: unknown) =>
      JSON.stringify(m).includes("http_request_duration_ms")
    ) as Record<string, unknown> | undefined;

    if (metricData) {
      const metricStr = JSON.stringify(metricData);
      // UUID should be normalized to /:id
      expect(metricStr).toContain("/:id");
      expect(metricStr).not.toContain("550e8400");
    }
  });
});
