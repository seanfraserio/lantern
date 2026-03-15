# How to Set Up Alerts

Configure alert channels so Lantern can notify you when agent quality drifts, costs spike, or PII is detected.

---

## Supported channels

Lantern supports three alert channel types:

- **Slack** — messages via incoming webhook
- **PagerDuty** — incidents via Events API v2
- **Webhook** — generic HTTP POST to any URL

---

## Create a Slack alert channel

1. Create a Slack incoming webhook at [api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks).

2. Register it with Lantern:

```bash
curl -X POST https://api.openlanternai.com/v1/alerts/channels \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ops-slack",
    "type": "slack",
    "config": {
      "webhookUrl": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
    }
  }'
```

The response includes the channel ID:

```json
{
  "id": "ch_abc123",
  "name": "ops-slack",
  "type": "slack",
  "status": "active"
}
```

---

## Create a PagerDuty alert channel

1. In PagerDuty, create a service and get the Events API v2 integration key (routing key).

2. Register it:

```bash
curl -X POST https://api.openlanternai.com/v1/alerts/channels \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "oncall-pagerduty",
    "type": "pagerduty",
    "config": {
      "routingKey": "your-pagerduty-routing-key"
    }
  }'
```

---

## Create a generic webhook channel

Send alert payloads to any HTTP endpoint:

```bash
curl -X POST https://api.openlanternai.com/v1/alerts/channels \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "custom-webhook",
    "type": "webhook",
    "config": {
      "url": "https://your-service.example.com/lantern-alerts",
      "headers": {
        "X-Custom-Auth": "secret-token"
      }
    }
  }'
```

The webhook receives a JSON POST with the alert payload:

```json
{
  "alertId": "alert_xyz",
  "type": "quality_regression",
  "severity": "warning",
  "agentName": "support-agent",
  "message": "Scorer 'tone' dropped from 0.92 to 0.74 (>2 std deviations)",
  "timestamp": "2026-03-15T10:30:00Z",
  "traceIds": ["trace-001", "trace-002"]
}
```

---

## Test an alert channel

Send a test alert to verify connectivity:

```bash
curl -X POST https://api.openlanternai.com/v1/alerts/channels/ch_abc123/test \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

A test message is sent to the configured channel. Check your Slack channel, PagerDuty, or webhook endpoint.

---

## List alert channels

```bash
curl https://api.openlanternai.com/v1/alerts/channels \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

---

## Delete an alert channel

```bash
curl -X DELETE https://api.openlanternai.com/v1/alerts/channels/ch_abc123 \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

---

## What triggers alerts

Lantern generates alerts for the following events:

| Event | Description |
|-------|-------------|
| **Quality regression** | An evaluation score drops by more than 2 standard deviations from the baseline |
| **Error spike** | Agent error rate exceeds the configured threshold within a time window |
| **Cost anomaly** | Token spend for an agent exceeds the daily or monthly budget |
| **PII detected** | Personally identifiable information found in a trace that matches a PII scanning rule |
| **Latency spike** | Agent response time exceeds the configured p95 threshold |

Alerts are routed to all active channels by default. To configure per-event routing, use the dashboard at **Settings > Alerts**.

---

## Configure alert rules in the dashboard

For fine-grained control, open the dashboard and navigate to **Settings > Alerts**:

1. Select which agents or services a rule applies to
2. Choose the event type (regression, error, cost, PII, latency)
3. Set thresholds (e.g., "alert when cost exceeds $50/day")
4. Assign one or more channels
5. Set severity (info, warning, critical)

> **Note:** Alert rules configured in the dashboard take precedence over the default "all channels" behaviour.
