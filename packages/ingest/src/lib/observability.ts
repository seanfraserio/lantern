import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

interface GrafanaConfig {
  endpoint: string;
  user: string;
  token: string;
}

interface MetricPoint {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
  attributes: Record<string, string | number | boolean>;
  timestamp: number;
}

function msToNs(ms: number): string {
  return `${ms}000000`;
}

function toAttr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/**
 * Normalizes route paths to reduce metric cardinality.
 * /traces/abc-123-def -> /traces/:id
 * /teams/456/members -> /teams/:id/members
 */
function normalizeRoute(path: string): string {
  return path.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\/[0-9a-f]{8,}|\/[a-z]{2,4}_[0-9a-zA-Z]{6,}|\/\d+/g,
    "/:id",
  );
}

class MetricsBuffer {
  private metrics: MetricPoint[] = [];
  private logs: LogEntry[] = [];
  private config: GrafanaConfig;
  private serviceName: string;
  private authHeader: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: GrafanaConfig, serviceName: string) {
    this.config = config;
    this.serviceName = serviceName;
    this.authHeader = `Basic ${Buffer.from(`${config.user}:${config.token}`).toString("base64")}`;
    // Flush every 15 seconds
    this.flushTimer = setInterval(() => this.flush().catch(console.error), 15_000);
    this.flushTimer.unref();
  }

  addMetric(point: MetricPoint): void {
    this.metrics.push(point);
    // Auto-flush at 200 points
    if (this.metrics.length >= 200) {
      this.flush().catch(console.error);
    }
  }

  addLog(entry: LogEntry): void {
    this.logs.push(entry);
  }

  async flush(): Promise<void> {
    const metricsToFlush = this.metrics.splice(0);
    const logsToFlush = this.logs.splice(0);
    const promises: Promise<void>[] = [];
    if (metricsToFlush.length > 0) promises.push(this.flushMetrics(metricsToFlush));
    if (logsToFlush.length > 0) promises.push(this.flushLogs(logsToFlush));
    if (promises.length > 0) await Promise.allSettled(promises);
  }

  private async flushMetrics(metrics: MetricPoint[]): Promise<void> {
    try {
      const metricMap = new Map<
        string,
        Array<{
          asDouble: number;
          timeUnixNano: string;
          attributes: Array<{ key: string; value: { stringValue: string } }>;
        }>
      >();
      for (const point of metrics) {
        if (!metricMap.has(point.name)) metricMap.set(point.name, []);
        metricMap.get(point.name)!.push({
          asDouble: point.value,
          timeUnixNano: msToNs(point.timestamp),
          attributes: Object.entries(point.labels).map(([k, v]) => toAttr(k, v)),
        });
      }
      const body = JSON.stringify({
        resourceMetrics: [
          {
            resource: {
              attributes: [toAttr("service.name", this.serviceName)],
            },
            scopeMetrics: [
              {
                metrics: Array.from(metricMap.entries()).map(
                  ([name, dataPoints]) => ({
                    name,
                    gauge: { dataPoints },
                  }),
                ),
              },
            ],
          },
        ],
      });
      const response = await fetch(
        `${this.config.endpoint}/otlp/v1/metrics`,
        {
          method: "POST",
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "application/json",
          },
          body,
        },
      );
      if (!response.ok)
        console.error(
          `[obs] Metrics push failed: ${response.status} ${await response.text()}`,
        );
    } catch (err) {
      console.error("[obs] Metrics push error:", err);
    }
  }

  private async flushLogs(logs: LogEntry[]): Promise<void> {
    try {
      const logRecords = logs.map((entry) => ({
        timeUnixNano: msToNs(entry.timestamp),
        body: {
          stringValue: JSON.stringify({
            message: entry.message,
            ...entry.attributes,
          }),
        },
        severityText: entry.level.toUpperCase(),
        attributes: Object.entries(entry.attributes).map(([k, v]) =>
          toAttr(k, String(v)),
        ),
      }));
      const body = JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [toAttr("service.name", this.serviceName)],
            },
            scopeLogs: [{ logRecords }],
          },
        ],
      });
      const response = await fetch(`${this.config.endpoint}/otlp/v1/logs`, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
        },
        body,
      });
      if (!response.ok)
        console.error(
          `[obs] Logs push failed: ${response.status} ${await response.text()}`,
        );
    } catch (err) {
      console.error("[obs] Logs push error:", err);
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

// Singleton buffer -- initialized when registerObservability is called
let buffer: MetricsBuffer | null = null;

/**
 * Register Fastify observability hooks.
 * Instruments every request with: duration, count, error rate.
 * Sends to Grafana Cloud via OTLP.
 */
export function registerObservability(
  app: FastifyInstance,
  serviceName: string,
): void {
  const grafanaEndpoint = process.env.GRAFANA_PUSH_URL;
  const grafanaUser = process.env.GRAFANA_USER;
  const grafanaToken = process.env.GRAFANA_TOKEN;

  if (!grafanaEndpoint || !grafanaUser || !grafanaToken) {
    app.log.info("[obs] Grafana config not set — observability disabled");
    return;
  }

  buffer = new MetricsBuffer(
    { endpoint: grafanaEndpoint, user: grafanaUser, token: grafanaToken },
    serviceName,
  );

  // Track request start time
  app.addHook("onRequest", async (request: FastifyRequest) => {
    (request as unknown as Record<string, unknown>).__obsStart = Date.now();
  });

  // Record metrics after response
  app.addHook(
    "onResponse",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const start = (request as unknown as Record<string, unknown>)
        .__obsStart as number | undefined;
      if (!start || !buffer) return;

      const durationMs = Date.now() - start;
      const route = normalizeRoute(request.url.split("?")[0]);
      const method = request.method;
      const statusCode = String(reply.statusCode);
      const now = Date.now();

      const baseLabels = { method, route, status_code: statusCode };

      // Request duration
      buffer.addMetric({
        name: "http_request_duration_ms",
        value: durationMs,
        labels: baseLabels,
        timestamp: now,
      });

      // Request counter
      buffer.addMetric({
        name: "http_request_total",
        value: 1,
        labels: baseLabels,
        timestamp: now,
      });

      // Error counter for 4xx/5xx
      if (reply.statusCode >= 400) {
        const errorClass = reply.statusCode >= 500 ? "5xx" : "4xx";
        buffer.addMetric({
          name: "http_error_total",
          value: 1,
          labels: { ...baseLabels, error_class: errorClass },
          timestamp: now,
        });

        // Specific tracking for rate limits
        if (reply.statusCode === 429) {
          buffer.addMetric({
            name: "rate_limit_total",
            value: 1,
            labels: { method, route },
            timestamp: now,
          });
        }
      }

      // Structured log
      let level: "info" | "warn" | "error" = "info";
      if (reply.statusCode >= 500) level = "error";
      else if (reply.statusCode >= 400) level = "warn";
      buffer.addLog({
        level,
        message: `${method} ${route} ${statusCode} ${durationMs}ms`,
        attributes: {
          method,
          route,
          status_code: statusCode,
          duration_ms: durationMs,
        },
        timestamp: now,
      });

      // Flush after each request — Cloud Run idle CPU prevents timer-based flushing
      buffer.flush().catch(() => {});
    },
  );

  // Graceful shutdown
  app.addHook("onClose", async () => {
    if (buffer) await buffer.shutdown();
  });

  app.log.info(
    `[obs] Observability enabled for ${serviceName} → ${grafanaEndpoint}`,
  );
}

/**
 * Record a custom metric. Call from route handlers for business-level metrics.
 */
export function recordMetric(
  name: string,
  value: number,
  labels: Record<string, string> = {},
): void {
  buffer?.addMetric({ name, value, labels, timestamp: Date.now() });
}

