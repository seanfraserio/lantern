# How to Monitor Costs

Track and control your AI spending across agents, models, and environments.

---

## View cost breakdown

Get a cost summary broken down by agent and model:

```bash
curl "https://api.openlanternai.com/v1/costs/summary?period=30d" \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

Response:

```json
{
  "period": "30d",
  "totalCostUsd": 142.37,
  "totalInputTokens": 2840000,
  "totalOutputTokens": 1120000,
  "byAgent": [
    {
      "agentName": "support-agent",
      "costUsd": 89.20,
      "inputTokens": 1800000,
      "outputTokens": 720000,
      "traceCount": 4200
    },
    {
      "agentName": "code-review-agent",
      "costUsd": 53.17,
      "inputTokens": 1040000,
      "outputTokens": 400000,
      "traceCount": 1800
    }
  ],
  "byModel": [
    {
      "model": "claude-sonnet-4-5-20251001",
      "costUsd": 98.50,
      "inputTokens": 2000000,
      "outputTokens": 800000
    },
    {
      "model": "gpt-4o",
      "costUsd": 43.87,
      "inputTokens": 840000,
      "outputTokens": 320000
    }
  ]
}
```

Filter by agent or environment:

```bash
curl "https://api.openlanternai.com/v1/costs/summary?period=7d&agentName=support-agent&environment=production" \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

---

## Set monthly budgets

Set a monthly budget for an agent. When spending reaches the threshold, Lantern sends an alert.

```bash
curl -X POST https://api.openlanternai.com/v1/costs/budgets \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentName": "support-agent",
    "monthlyBudgetUsd": 200.00,
    "alertThresholds": [0.50, 0.80, 1.00]
  }'
```

This sends alerts when spending reaches 50%, 80%, and 100% of the budget. Alerts are delivered to your configured [alert channels](./set-up-alerts.md).

> **Note:** Budgets are advisory — Lantern does not block LLM calls when a budget is exceeded. Use the alerts to trigger your own circuit breakers if needed.

---

## Read cost forecasts

Get a projected monthly spend based on current usage trends:

```bash
curl "https://api.openlanternai.com/v1/costs/forecast?agentName=support-agent" \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

Response:

```json
{
  "agentName": "support-agent",
  "currentMonthCostUsd": 62.40,
  "projectedMonthCostUsd": 187.20,
  "daysElapsed": 10,
  "daysRemaining": 21,
  "trend": "stable",
  "monthlyBudgetUsd": 200.00,
  "budgetUtilisation": 0.312
}
```

The `trend` field is one of `decreasing`, `stable`, or `increasing`.

---

## Respond to budget alerts

When you receive a budget alert, consider these actions:

1. **Review the cost breakdown** to identify which model or use case is driving the spend.

2. **Check for anomalies** — a sudden spike may indicate a bug (e.g., infinite retry loops):

    ```bash
    curl "https://api.openlanternai.com/v1/costs/daily?agentName=support-agent&period=14d" \
      -H "Authorization: Bearer $LANTERN_API_KEY"
    ```

3. **Reduce costs** by switching to a cheaper model for low-complexity tasks. Lantern tracks per-model costs so you can compare.

4. **Adjust the budget** if the increased spend is expected:

    ```bash
    curl -X PATCH https://api.openlanternai.com/v1/costs/budgets/budget_abc123 \
      -H "Authorization: Bearer $LANTERN_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "monthlyBudgetUsd": 300.00
      }'
    ```

---

## View cost data in the dashboard

The dashboard provides a visual cost breakdown at **Analytics > Costs**:

- Daily and monthly spend charts
- Per-agent and per-model breakdowns
- Budget burn-down visualisation
- Cost-per-trace trends over time

---

## Model pricing

Lantern estimates costs using the following per-1K-token prices:

| Model | Input | Output |
|-------|-------|--------|
| `claude-sonnet-4-5-20251001` | $0.003 | $0.015 |
| `claude-haiku-4-5-20251001` | $0.0008 | $0.004 |
| `claude-opus-4-5-20251001` | $0.015 | $0.075 |
| `gpt-4o` | $0.005 | $0.015 |
| `gpt-4o-mini` | $0.00015 | $0.0006 |

For models not in this list, Lantern uses a default estimate of $0.001/1K input and $0.002/1K output. Actual costs may differ — use these as directional guidance.
