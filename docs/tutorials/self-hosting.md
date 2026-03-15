# Tutorial: Self-Host Lantern with Docker Compose

In this tutorial you will run the full Lantern stack on your own infrastructure: the ingest server, the dashboard, and PostgreSQL. By the end you will have sent a test trace and seen it in the dashboard.

**Time:** ~10 minutes

---

## Prerequisites

- Docker and Docker Compose v2
- `curl` (for sending a test trace)
- Git (to clone the repository)

---

## 1. Clone the repository

```bash
git clone https://github.com/OpenLantern/lantern.git
cd lantern
```

---

## 2. Create the `.env` file

```bash
cp docker/.env.example docker/.env 2>/dev/null || true
```

Open `docker/.env` and set the required values:

```bash
# Required: set a strong password for the PostgreSQL database
POSTGRES_PASSWORD=your-strong-password-here

# Optional: customise these if needed
POSTGRES_USER=lantern
LANTERN_API_KEY=ltn_self_hosted_dev_key
```

> **Warning:** Never use a weak password in production. `POSTGRES_PASSWORD` is the only required variable.

---

## 3. Start the stack

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts three services:

| Service | Port | Description |
|---------|------|-------------|
| `postgres` | 5432 | PostgreSQL 16 with health checks |
| `ingest` | 4100 | Lantern ingest server (accepts traces) |
| `dashboard` | 3000 | Enterprise dashboard SPA |

Wait for all services to be healthy:

```bash
docker compose -f docker/docker-compose.yml ps
```

Expected output:

```
NAME              STATUS
lantern-postgres  Up (healthy)
lantern-ingest    Up
lantern-dashboard Up
```

---

## 4. Verify the ingest server is running

```bash
curl http://localhost:4100/health
```

Expected response:

```json
{"status":"ok"}
```

---

## 5. Send a test trace

Send a minimal trace to the ingest endpoint:

```bash
curl -X POST http://localhost:4100/v1/traces \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ltn_self_hosted_dev_key" \
  -d '{
    "traces": [
      {
        "id": "test-trace-001",
        "sessionId": "session-001",
        "agentName": "self-host-test",
        "environment": "development",
        "startTime": 1710000000000,
        "endTime": 1710000001500,
        "durationMs": 1500,
        "status": "success",
        "spans": [
          {
            "id": "span-001",
            "traceId": "test-trace-001",
            "type": "llm_call",
            "startTime": 1710000000000,
            "endTime": 1710000001500,
            "durationMs": 1500,
            "input": {
              "messages": [
                {"role": "user", "content": "Hello, world!"}
              ]
            },
            "output": {
              "content": "Hello! How can I help you today?"
            },
            "model": "claude-sonnet-4-5-20251001",
            "inputTokens": 12,
            "outputTokens": 8,
            "estimatedCostUsd": 0.000156
          }
        ],
        "metadata": {"source": "self-host-tutorial"},
        "source": {
          "serviceName": "self-host-test",
          "sdkVersion": "0.1.0",
          "exporterType": "manual"
        },
        "totalInputTokens": 12,
        "totalOutputTokens": 8,
        "estimatedCostUsd": 0.000156
      }
    ]
  }'
```

Expected response:

```json
{"accepted":1}
```

---

## 6. Open the dashboard

Open [http://localhost:3000](http://localhost:3000) in your browser. You should see the test trace under **Traces**.

Click the trace to inspect the span details: input messages, output content, model, token counts, and cost.

---

## 7. Connect your agent

Now point your SDK at the local ingest server instead of the cloud endpoint.

**TypeScript:**

```typescript
import { LanternTracer, LanternExporter } from "@lantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "my-agent",
  environment: "development",
  exporter: new LanternExporter({
    endpoint: "http://localhost:4100",
    apiKey: "ltn_self_hosted_dev_key",
  }),
});
```

**Python:**

```python
from lantern_ai import LanternTracer

tracer = LanternTracer(
    service_name="my-agent",
    environment="development",
    endpoint="http://localhost:4100",
    api_key="ltn_self_hosted_dev_key",
)
```

---

## 8. Stop the stack

When you are done:

```bash
docker compose -f docker/docker-compose.yml down
```

To also remove the database volume (deletes all data):

```bash
docker compose -f docker/docker-compose.yml down -v
```

---

## Production considerations

- **Persistent storage:** The `pgdata` volume persists across restarts. Back it up regularly.
- **TLS:** Put a reverse proxy (nginx, Caddy, Traefik) in front of the ingest server and dashboard for HTTPS.
- **API key rotation:** Change `LANTERN_API_KEY` in the `.env` file and restart the ingest service.
- **Scaling:** The ingest server is stateless. Run multiple instances behind a load balancer for high throughput.
- **Monitoring:** The `/health` endpoint on the ingest server is suitable for load-balancer health checks.

---

## Summary

You self-hosted the full Lantern stack, sent a test trace, and viewed it in the dashboard. You can now connect any agent to your local instance by pointing the SDK at `http://localhost:4100`.

Next: [Instrument a TypeScript agent](./instrument-typescript.md) | [Instrument a Python agent](./instrument-python.md) | [Use the LLM Proxy](../how-to/use-llm-proxy.md)
